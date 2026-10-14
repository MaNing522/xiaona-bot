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
// 相关 .env（都可留空用默认值）：
//   ASR_URL    完整接口地址，默认 http://127.0.0.1:8899/v1/audio/transcriptions
//   ASR_MODEL  模型名，默认 iic/SenseVoiceSmall（服务端用 SenseVoice）
//   ASR_TOKEN  若服务端要求鉴权，填了会带 Authorization: Bearer <token>
//   ASR_ENABLED=false 可整体关闭语音识别（默认开）
// 服务没起 / 识别失败时一律返回 null，语音消息仍按 [语音] 占位，不影响其它功能。
// ============================================================
import fs from 'fs';
import { logger } from './logger.js';

/** 语音段占位（未配置/识别失败时用） */
export const VOICE_PLACEHOLDER = '[语音]';

const DEFAULT_URL = 'http://127.0.0.1:8899/v1/audio/transcriptions';
const DEFAULT_MODEL = 'iic/SenseVoiceSmall';
const ASR_TIMEOUT_MS = 20000;

function endpoint() { return String(process.env.ASR_URL || DEFAULT_URL).trim(); }
function modelName() { return String(process.env.ASR_MODEL || DEFAULT_MODEL).trim(); }

/** 是否启用语音识别（默认开；ASR_ENABLED=false 关闭） */
export function asrEnabled() {
    if (String(process.env.ASR_ENABLED || 'true') === 'false') return false;
    return !!endpoint();
}

/** 音频扩展名：优先 record 段的 format，其次文件名/URL 的后缀，兜底 wav */
function extOf(data) {
    const direct = String(data.format || '').trim().replace(/^\./, '');
    if (direct) return direct;
    for (const s of [data.file, data.path, data.url]) {
        const m = String(s || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
        if (m) return m[1].toLowerCase();
    }
    return 'wav';
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
    const localPath = [data.path, data.file]
        .map((s) => String(s || '').trim())
        .find((s) => s && !/^https?:\/\//i.test(s) && fs.existsSync(s));
    if (localPath) return { buf: fs.readFileSync(localPath), ext: extOf(data) };

    for (const u of [data.url, data.file]) {
        const url = String(u || '').trim();
        if (!/^https?:\/\//i.test(url)) continue;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(ASR_TIMEOUT_MS) });
            if (!res.ok) continue;
            return { buf: Buffer.from(await res.arrayBuffer()), ext: extOf(data) };
        } catch { /* 换个来源再试 */ }
    }
    return null;
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
    const audio = await resolveAudio(data);
    if (!audio || !audio.buf.length) {
        logger.debug('[ASR] 拿不到语音音频（record 段里没有可用的 url/path）');
        return null;
    }
    const ext = audio.ext || 'wav';
    try {
        const form = new FormData();
        form.append('model', modelName());
        form.append('response_format', 'json');
        form.append('file', new Blob([audio.buf], { type: mimeOf(ext) }), `audio.${ext}`);
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
        const text = cleanText(j && (j.text || j.result || j.data));
        return text || null;
    } catch (e) {
        logger.warn(`[ASR] 本地 FunASR 调用失败（服务没起？）：${e.message}`);
        return null;
    }
}
