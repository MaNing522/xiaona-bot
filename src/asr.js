// ============================================================
// asr.js - 语音识别（把 QQ 语音消息转成文字，喂给 AI）
//
// 用**本地语音识别服务**：QQ 语音是 OneBot 的 record 段（一段音频文件），
// AI 读不懂音频，先送本地服务转成文字，再拼进给模型看的消息里。
//
// 默认后端是**小米 MiMo ASR**（复用 .env 的 MIMO_API_KEY，模型 mimo-v2.5-asr）：
//    POST https://api.xiaomimimo.com/v1/chat/completions
//    messages 里放 input_audio 的 data URL（只支持 wav / mp3），返回 choices[0].message.content。
// 没 Key、调用失败、返回空 → 自动降级到**本地 sherpa-onnx**
// （Node 实现，见 src/asrSherpa.js，由 start.js 自动拉起）。
// 也可在 config.json 把 asr.provider 设成 local（只用本地）或 custom（自定义接口）。
// 本地 / 自定义都是 OpenAI 兼容接口：
//    POST http://127.0.0.1:8899/v1/audio/transcriptions（multipart 上传 file），
//    返回 JSON 的 text 字段即为识别结果。
//
// 两个「补偿」都在这里做，因为语音识别本身不可靠：
//   1) 转码：QQ 语音多半是 amr / silk，小米和 sherpa 都吃不下。挂上 setAudioConverter 后，
//      先让 SnowLuma 用自己的 get_record(out_format=wav) 转成 wav 再上传（SnowLuma 内部带 silk 解码）。
//   2) 同音纠正：模型不认字，常把「小钠」听成「小娜」。按 config.json 的 asr 段把错字改回来，
//      否则既读着别扭，也匹配不上触发关键词（见 fixText）。
//
// 相关 .env（都可留空用默认值）：
//   MIMO_API_KEY      小米 MiMo Key（ASR 与 TTS 共用）
//   MIMO_ASR_URL      小米 ASR 地址，默认 https://api.xiaomimimo.com/v1/chat/completions
//   MIMO_ASR_MODEL    小米 ASR 模型，默认 mimo-v2.5-asr
//   ASR_URL    本地接口地址，默认 http://127.0.0.1:8899/v1/audio/transcriptions
//   ASR_MODEL  本地模型名（仅 FunASR 后端有意义）
//   ASR_TOKEN  本地服务要求鉴权时带 Authorization: Bearer <token>
//   ASR_ENABLED=false 可整体关闭语音识别（默认开）
//   ASR_CUSTOM_URL / ASR_CUSTOM_KEY / ASR_CUSTOM_MODEL 自定义接口的兜底
// 相关 config.json：asr.provider（mimo / local / custom）/ customUrl / customModel / customKey / language，
//   以及 asr.canonicalName / asr.homophones（同音纠正表，见下）
// 服务没起 / 识别失败时一律返回 null，语音消息仍按 [语音] 占位，不影响其它功能。
// ============================================================
import fs from 'fs';
import { logger } from './logger.js';
import { config } from './config.js';

/** 同一条 record 段的识别结果缓存（WeakMap：消息处理完随段对象一起回收） */
const transcribeCache = new WeakMap();

/** 语音段占位（未配置/识别失败时用） */
export const VOICE_PLACEHOLDER = '[语音]';

const DEFAULT_URL = 'http://127.0.0.1:8899/v1/audio/transcriptions';
const DEFAULT_MODEL = 'sensevoice';
const ASR_TIMEOUT_MS = 20000;

// 小米 MiMo ASR（OpenAI 兼容的 chat/completions，音频放 input_audio 的 data URL）
const MIMO_URL = String(process.env.MIMO_ASR_URL || 'https://api.xiaomimimo.com/v1/chat/completions').trim();
const MIMO_MODEL = String(process.env.MIMO_ASR_MODEL || 'mimo-v2.5-asr').trim();
const MIMO_TIMEOUT_MS = 30000;
const MIMO_EXT = new Set(['wav', 'mp3']);

/** 小米只吃 wav/mp3；其余（amr/silk/flac/m4a…）先转码成 wav */
const NATIVE_EXT = new Set(['wav', 'mp3', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'opus']);

function endpoint() { return String(process.env.ASR_URL || DEFAULT_URL).trim(); }
function modelName() { return String(process.env.ASR_MODEL || DEFAULT_MODEL).trim(); }
function mimoKey() { return String(process.env.MIMO_API_KEY || '').trim(); }

/** config.json 的 asr 段（热加载，改完下一条语音就生效） */
function asrCfg() { return (config().asr) || {}; }

/**
 * 识别后端：mimo（小米，失败降本地）| local（本地服务）| custom（自定义 OpenAI 兼容接口）。
 * 默认 mimo —— 网页「全局设置」可改，热加载生效。
 */
export function asrProvider() {
    const p = String(asrCfg().provider || '').toLowerCase();
    if (p === 'custom' || p === 'local' || p === 'mimo') return p;
    return 'mimo';
}

/** 小米 ASR 的语种参数（只认 auto / zh / en） */
function mimoLanguage() {
    const v = String(asrCfg().language || 'auto').trim().toLowerCase();
    return ['auto', 'zh', 'en'].includes(v) ? v : 'auto';
}

/** custom 后端的地址/模型/密钥（config.json 优先，缺了再看 .env） */
function customSettings() {
    const a = asrCfg();
    return {
        url: String(a.customUrl || process.env.ASR_CUSTOM_URL || '').trim(),
        model: String(a.customModel || process.env.ASR_CUSTOM_MODEL || 'whisper-1').trim(),
        key: String(a.customKey || process.env.ASR_CUSTOM_KEY || '').trim(),
        language: String(a.language || '').trim(),
    };
}

/** 是否启用语音识别（默认开；ASR_ENABLED=false 关闭） */
export function asrEnabled() {
    if (String(process.env.ASR_ENABLED || 'true') === 'false') return false;
    const p = asrProvider();
    if (p === 'custom') return !!customSettings().url;
    // mimo 没 Key 时会降本地，所以本地地址在就算启用
    if (p === 'mimo') return !!mimoKey() || !!endpoint();
    return !!endpoint();
}

// ---------- 转码：amr/silk → wav ----------
// 由 index.js 注入（那里才拿得到 SnowLuma 的 callApi）；本模块只管调用，不关心怎么转。
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
 * 拿不到返回 null（SnowLuma 一般会在 record 段里带 url，可直接下到音频）。
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
 * 同一条 record 段在一次消息处理里可能被读两次（触发关键词判断 + 交给模型），
 * 用 WeakMap 缓存 Promise，避免重复上传识别。
 * @param {object} data OneBot record 段的数据：{ file, url, path, format, ... }
 * @returns {Promise<string|null>} 识别出的文字；未启用 / 拿不到音频 / 服务异常均返回 null
 */
export function transcribe(data) {
    if (!data || typeof data !== 'object') return Promise.resolve(null);
    if (!transcribeCache.has(data)) transcribeCache.set(data, doTranscribe(data));
    return transcribeCache.get(data);
}

/** 降级/失败日志限流：一条语音失败一次就够，别每次刷屏 */
let lastFallbackWarnAt = 0;
function warnThrottled(msg) {
    const now = Date.now();
    if (now - lastFallbackWarnAt < 60000) return;
    lastFallbackWarnAt = now;
    logger.warn(msg);
}

/** 读音频：目标格式吃不下就先转码成 wav，转不动退回原格式 */
const rawAudioCache = new WeakMap();   // data → Promise<{buf,ext}|null>：同一段语音不重复下载
const wavAudioCache = new WeakMap();   // data → Promise<{buf,ext}|null>：不重复转码
async function loadAudio(data, wanted) {
    const ext = extOf(data);
    if (!wanted.has(ext)) {
        if (!wavAudioCache.has(data)) wavAudioCache.set(data, convertToWav(data));
        const audio = await wavAudioCache.get(data);
        if (audio && audio.buf.length) return { buf: audio.buf, ext: 'wav' };
    }
    if (!rawAudioCache.has(data)) rawAudioCache.set(data, resolveAudio(data));
    const raw = await rawAudioCache.get(data);
    if (!raw || !raw.buf.length) return null;
    return { buf: raw.buf, ext: raw.ext || ext || 'wav' };
}

/**
 * 从 wav 字节头算时长（秒）；不是 wav 或头不完整返回 null。
 * 只解析 RIFF 的 fmt / data 两个块，足够算时长。
 */
export function wavDurationSec(buf) {
    if (!buf || buf.length < 44) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let pos = 12;
    let byteRate = 0;
    let dataLen = 0;
    while (pos + 8 <= buf.length) {
        const id = buf.toString('ascii', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        if (id === 'fmt ' && size >= 16) byteRate = buf.readUInt32LE(pos + 16);
        else if (id === 'data') {
            dataLen = Math.min(size, buf.length - pos - 8);
            break;
        }
        pos += 8 + size + (size % 2);
    }
    if (!byteRate || !dataLen) return null;
    return dataLen / byteRate;
}

/**
 * 一段语音的时长（秒）：优先 record 段自带的 duration，否则拿 wav 头算；
 * 格式不是 wav 会先转码一次（和识别共用缓存）。算不出来返回 null。
 */
export function voiceDuration(data) {
    if (!data || typeof data !== 'object') return Promise.resolve(null);
    const d = Number(data.duration);
    if (Number.isFinite(d) && d > 0) return Promise.resolve(d);
    if (!durationCache.has(data)) {
        durationCache.set(data, (async () => {
            const audio = await loadAudio(data, new Set(['wav']));
            if (!audio || audio.ext !== 'wav') return null;
            return wavDurationSec(audio.buf);
        })());
    }
    return durationCache.get(data);
}

/** 同一条 record 段的时长缓存（与转写缓存一样随段对象回收） */
const durationCache = new WeakMap();

/** 小米 MiMo ASR：成功返回文字，没 Key / 失败 / 空结果返回 null（调用方降级本地） */
async function transcribeMimo(audio) {
    const key = mimoKey();
    if (!key) {
        warnThrottled('[ASR] 没配 MIMO_API_KEY，语音识别直接用本地服务');
        return null;
    }
    const ext = audio.ext === 'mp3' ? 'mp3' : 'wav';
    const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const body = {
        model: MIMO_MODEL,
        messages: [{
            role: 'user',
            content: [{
                type: 'input_audio',
                // 只传 Base64 时 format 必填；这里 data URL 与 format 一起给，最稳
                input_audio: { data: `data:${mime};base64,${audio.buf.toString('base64')}`, format: ext },
            }],
        }],
        asr_options: { language: mimoLanguage() },
    };
    try {
        const res = await fetch(MIMO_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': key,
                'Authorization': `Bearer ${key}`,   // OpenAI 兼容客户端走 Bearer，两个都带上最稳
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(MIMO_TIMEOUT_MS),
        });
        if (!res.ok) {
            let detail = '';
            try { detail = String(await res.text() || '').replace(/\s+/g, ' ').trim().slice(0, 160); } catch { /* 读不出就算了 */ }
            warnThrottled(`[ASR] 小米语音识别返回 ${res.status}${detail ? '：' + detail : ''}，改用本地识别`);
            return null;
        }
        const j = await res.json().catch(() => null);
        const raw = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        const text = fixText(cleanText(raw));
        if (!text) {
            warnThrottled('[ASR] 小米语音识别没有返回文字，改用本地识别');
            return null;
        }
        return text;
    } catch (e) {
        warnThrottled(`[ASR] 小米语音识别调用失败（${e.message}），改用本地识别`);
        return null;
    }
}

/** 本地 / 自定义的 OpenAI 兼容 multipart 接口 */
async function transcribeHttp(audio, opt) {
    const { provider, url, model, key, language } = opt;
    try {
        const form = new FormData();
        form.append('model', model);
        form.append('response_format', 'json');
        // custom 传 auto 等于让接口自己检测，干脆不传（不是所有实现都认 auto）
        if (language && language !== 'auto') form.append('language', language);
        form.append('file', new Blob([audio.buf], { type: mimeOf(audio.ext) }), `audio.${audio.ext}`);
        const res = await fetch(url, {
            method: 'POST',
            headers: key ? { Authorization: 'Bearer ' + key } : {},
            body: form,
            signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
        });
        if (!res.ok) {
            // 带上服务端返回的原文（如 Unknown model 'iic/SenseVoiceSmall'），方便直接看出原因
            let detail = '';
            try { detail = String(await res.text() || '').replace(/\s+/g, ' ').trim().slice(0, 160); } catch { /* 读不出就算了 */ }
            logger.warn(`[ASR] ${provider === 'custom' ? '自定义' : '本地'}语音识别服务返回 ${res.status}${detail ? '：' + detail : ''}，本条语音跳过识别`);
            return null;
        }
        const j = await res.json().catch(() => null);
        const text = fixText(cleanText(j && (j.text || j.result || j.data)));
        return text || null;
    } catch (e) {
        logger.warn(`[ASR] ${provider === 'custom' ? '自定义' : '本地'}语音识别服务调用失败（服务没起/地址不通？）：${e.message}`);
        return null;
    }
}

async function doTranscribe(data) {
    if (!asrEnabled()) return null;

    const provider = asrProvider();
    // 小米只支持 wav/mp3：优先转 wav；转不动就拿原格式（小米会跳过，本地还能试）
    const audio = await loadAudio(data, provider === 'mimo' ? MIMO_EXT : NATIVE_EXT);
    if (!audio) {
        logger.debug('[ASR] 拿不到语音音频（record 段里没有可用的 url/path）');
        return null;
    }

    if (provider === 'mimo') {
        if (MIMO_EXT.has(audio.ext)) {
            const text = await transcribeMimo(audio);
            if (text) return text;
        } else {
            warnThrottled(`[ASR] 小米只支持 wav/mp3，当前格式是 ${audio.ext}，改用本地识别`);
        }
        // 降级：本地服务（没配 key / 调用失败 / 空结果都会走到这里）
        return transcribeHttp(audio, {
            provider: 'local',
            url: endpoint(),
            model: modelName(),
            key: String(process.env.ASR_TOKEN || '').trim(),
        });
    }

    if (provider === 'custom') {
        const c = customSettings();
        return transcribeHttp(audio, { provider: 'custom', url: c.url, model: c.model, key: c.key, language: c.language });
    }

    return transcribeHttp(audio, {
        provider: 'local',
        url: endpoint(),
        model: modelName(),
        key: String(process.env.ASR_TOKEN || '').trim(),
    });
}
