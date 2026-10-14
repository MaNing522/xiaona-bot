// ============================================================
// asr.js - 语音识别（把 QQ 语音消息转成文字，喂给 AI）
//
// 用**本地 FunASR（SenseVoice 模型）**：QQ 语音是 OneBot 的 record 段（一段音频文件），
// AI 读不懂音频，先送本地 FunASR 转成文字，再拼进给模型看的消息里。
//
// 本地服务（FunASR 官方 OpenAI 兼容接口，一行命令即可起）：
//     pip install funasr fastapi uvicorn python-multipart
//     funasr-server --host 127.0.0.1 --port 8899 --model sensevoice --device cpu
//   本模块默认请求 http://127.0.0.1:8899/v1/audio/transcriptions（multipart 上传 file），
//   返回 JSON 的 text 字段即为识别结果。
//
// 两个「补偿」都在这里做，因为语音识别本身不可靠：
//   1) 转码：QQ 语音多半是 amr / silk，FunASR 吃不下。挂上 setAudioConverter 后，
//      先让 NapCat 用自己的 get_record(out_format=wav) 转成 wav 再上传（NapCat 内部带 silk 解码）。
//   2) 同音纠正：SenseVoice 不认字，常把「小钠」听成「小娜」。按 config.json 的 asr 段把错字改回来，
//      否则既读着别扭，也匹配不上触发关键词（见 fixText）。
//
// 相关 .env（都可留空用默认值）：
//   ASR_URL    完整接口地址，默认 http://127.0.0.1:8899/v1/audio/transcriptions
//   ASR_MODEL  模型名，默认 iic/SenseVoiceSmall（服务端用 SenseVoice）
//   ASR_TOKEN  若服务端要求鉴权，填了会带 Authorization: Bearer <token>
//   ASR_ENABLED=false 可整体关闭语音识别（默认开）
// 相关 config.json：asr.canonicalName / asr.homophones（同音纠正表，见下）
// 服务没起 / 识别失败时一律返回 null，语音消息仍按 [语音] 占位，不影响其它功能。
// ============================================================
import fs from 'fs';
import { logger } from './logger.js';
import { config } from './config.js';

/** 语音段占位（未配置/识别失败时用） */
export const VOICE_PLACEHOLDER = '[语音]';

const DEFAULT_URL = 'http://127.0.0.1:8899/v1/audio/transcriptions';
const DEFAULT_MODEL = 'iic/SenseVoiceSmall';
const ASR_TIMEOUT_MS = 20000;

/** FunASR 原生吃得下的格式；其余（amr/silk/wma/spx…）先转码成 wav */
const NATIVE_EXT = new Set(['wav', 'mp3', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'opus']);

function endpoint() { return String(process.env.ASR_URL || DEFAULT_URL).trim(); }
function modelName() { return String(process.env.ASR_MODEL || DEFAULT_MODEL).trim(); }

/** 是否启用语音识别（默认开；ASR_ENABLED=false 关闭） */
export function asrEnabled() {
    if (String(process.env.ASR_ENABLED || 'true') === 'false') return false;
    return !!endpoint();
}

// ---------- 转码：amr/silk → wav ----------
// 由 index.js 注入（那里才拿得到 NapCat 的 callApi）；本模块只管调用，不关心怎么转。
let audioConverter = null;
/**
 * 注入音频转码器。入参是 record 段数据，返回转好的 wav 字节（Buffer）或 null。
 * @param {(data: object) => Promise<Buffer|null>} fn
 */
export function setAudioConverter(fn) { audioConverter = fn; }

/** 试着把非原生格式的语音转成 wav；转不了返回 null（调用方退回按原格式上传） */
async function convertToWav(data) {
    if (!audioConverter) return null;
    try {
        const out = await audioConverter(data);
        if (out && out.length) return { buf: out, ext: 'wav' };
    } catch (e) {
        logger.warn(`[ASR] 语音转码失败，改按原格式识别：${e.message}`);
    }
    return null;
}

/** 音频扩展名：优先 record 段的 format，其次文件名/URL 的后缀，都没有则返回空串（表示未知） */
function extOf(data) {
    const direct = String(data.format || '').trim().replace(/^\./, '').toLowerCase();
    if (direct) return direct;
    for (const s of [data.file, data.path, data.url]) {
        const m = String(s || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
        if (m) return m[1].toLowerCase();
    }
    return '';
}

/** 常见音频扩展名 → MIME（只为 multipart 标注，识别本身靠服务端） */
function mimeOf(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === 'mp3') return 'audio/mpeg';
    if (e === 'wav') return 'audio/wav';
    if (e === 'flac') return 'audio/flac';
    if (e === 'm4a' || e === 'mp4' || e === 'aac') return 'audio/mp4';
    if (e === 'ogg' || e === 'opus') return 'audio/ogg';
    if (e === 'amr') return 'audio/amr';
    if (e === 'silk') return 'audio/silk';
    return 'application/octet-stream';
}

/**
 * 把 record 段解析成音频字节。
 * 依次尝试：本地文件（path/file 存在于磁盘）→ http(s) 地址（url/file 是链接）。
 * 拿不到返回 null（NapCat 一般会在 record 段里带 url，可直接下到音频）。
 */
async function resolveAudio(data) {
    const ext = extOf(data);
    const localPath = [data.path, data.file]
        .map((s) => String(s || '').trim())
        .find((s) => s && !/^https?:\/\//i.test(s) && fs.existsSync(s));
    if (localPath) return { buf: fs.readFileSync(localPath), ext };

    for (const u of [data.url, data.file]) {
        const url = String(u || '').trim();
        if (!/^https?:\/\//i.test(url)) continue;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(ASR_TIMEOUT_MS) });
            if (!res.ok) continue;
            return { buf: Buffer.from(await res.arrayBuffer()), ext };
        } catch { /* 换个来源再试 */ }
    }
    return null;
}

// ---------- 同音纠正：把识别错的字改回机器人名字 ----------
/**
 * 解析同音纠正表。
 * 逗号/分号/换行分隔；每一项若写成「错字=正确词」则精确映射，否则算作 canonicalName 的错写。
 * @param {string} text config.json 的 asr.homophones
 * @param {string} canonicalName config.json 的 asr.canonicalName
 * @returns {Map<string,string>} 错字 → 正确词
 */
export function parseFixList(text, canonicalName) {
    const map = new Map();
    const target = String(canonicalName || '').trim();
    for (const raw of String(text || '').split(/[,，;；\n]+/)) {
        const item = raw.trim();
        if (!item) continue;
        const i = item.indexOf('=');
        if (i > 0) {
            const from = item.slice(0, i).trim();
            const to = item.slice(i + 1).trim();
            if (from && to) map.set(from, to);
        } else if (target) {
            map.set(item, target);
        }
    }
    if (target) map.delete(target);   // 本来就是对的不必再改
    return map;
}

/**
 * 按同音表纠正识别结果（长词优先，避免「小娜子」被「小娜」先替换成半截句子）。
 * @param {string} text 识别出的原文
 * @param {{canonicalName?:string, homophones?:string}} [asrCfg] 纠正配置，默认取 config.json 的 asr 段
 */
export function fixText(text, asrCfg) {
    let s = String(text || '');
    if (!s) return s;
    const a = asrCfg || config().asr || {};
    const map = parseFixList(a.homophones, a.canonicalName);
    if (!map.size) return s;
    const keys = [...map.keys()].sort((x, y) => y.length - x.length);
    for (const k of keys) s = s.split(k).join(map.get(k));
    return s;
}

/** 去掉 SenseVoice 可能带的 <|zh|><|HAPPY|> 之类标记，只留人话 */
function cleanText(s) {
    return String(s || '').replace(/<\|[^|]*\|>/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 把一条语音段转成文字。
 * @param {object} data OneBot record 段的数据：{ file, url, path, format, ... }
 * @returns {Promise<string|null>} 识别出的文字；未启用 / 拿不到音频 / 服务异常均返回 null
 */
export async function transcribe(data) {
    if (!data) return null;
    if (!asrEnabled()) return null;

    // QQ 语音多是非原生格式（amr/silk 且常查不出扩展名）：优先让 NapCat 转成 wav，
    // 转不动再退回原格式上传（此时多半会被服务端拒绝，返回 null → [语音] 占位）。
    const ext = extOf(data);
    let audio = null;
    if (!NATIVE_EXT.has(ext)) audio = await convertToWav(data);
    if (!audio) audio = await resolveAudio(data);

    if (!audio || !audio.buf.length) {
        logger.debug('[ASR] 拿不到语音音频（record 段里没有可用的 url/path）');
        return null;
    }
    const useExt = audio.ext || ext || 'wav';
    try {
        const form = new FormData();
        form.append('model', modelName());
        form.append('response_format', 'json');
        form.append('file', new Blob([audio.buf], { type: mimeOf(useExt) }), `audio.${useExt}`);
        const token = String(process.env.ASR_TOKEN || '').trim();
        const res = await fetch(endpoint(), {
            method: 'POST',
            headers: token ? { Authorization: 'Bearer ' + token } : {},
            body: form,
            signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
        });
        if (!res.ok) {
            logger.warn(`[ASR] 本地 FunASR 返回 ${res.status}，本条语音跳过识别`);
            return null;
        }
        const j = await res.json().catch(() => null);
        const text = fixText(cleanText(j && (j.text || j.result || j.data)));
        return text || null;
    } catch (e) {
        logger.warn(`[ASR] 本地 FunASR 调用失败（服务没起？）：${e.message}`);
        return null;
    }
}
