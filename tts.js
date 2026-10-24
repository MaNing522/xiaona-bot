// ============================================================
// tts.js - 文本转语音，支持两种后端（TTS_PROVIDER 切换）
//
// 1) xiaomi（默认，配了 MIMO_API_KEY 时）：小米 MiMo TTS
//    走 OpenAI 兼容的 POST https://api.xiaomimimo.com/v1/chat/completions，
//    model=mimo-v2.5-tts；要合成的话放 role=assistant，风格标签写在文本开头，
//    如 (慵懒)/(磁性)/(东北话)/(粤语)，想唱歌写 (唱歌) 后面跟歌词。
//    返回 choices[0].message.audio.data（base64 音频，这里按 mp3 取）。
// 2) edge（没配小米 key 时回退）：微软 Edge 朗读服务（与 edge-tts 同款协议，免密钥），
//    走 WebSocket 接口：先发 speech.config，再发 SSML，二进制分片拼起来就是 mp3。
//
// 音色 / 语速 / 音量走 .env：
//   TTS_PROVIDER     xiaomi / edge（不填时有 MIMO_API_KEY 就用小米，否则 Edge）
//   MIMO_API_KEY     小米 MiMo API Key
//   TTS_XIAOMI_VOICE 小米音色名，默认 冰糖（女声）；另可选 茉莉 / 苏打 / 白桦 等
//   TTS_VOICE        Edge 音色短名，默认 zh-CN-XiaoxiaoNeural（女声 XiaoXiao）
//   TTS_RATE         Edge 语速增减
//   TTS_VOLUME       Edge 音量增减（SSML prosody volume，常用 -100% ~ +100%）
//   完整 Edge 音色表：edge-tts --list-voices
//
// 说明：两种后端都只用到项目已有的 ws / fetch，无需安装额外东西。
//       微软偶尔会换校验参数，若哪天报「被拒绝 (403)」，把 EDGE_VERSION 换成
//       新版 Edge 的版本号即可（见下方注释）。
// ============================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { logger } from './logger.js';
import { generateSecMsGec } from './edgeDrm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VOICE_DIR = path.join(__dirname, 'voice_cache');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';   // 女声 XiaoXiao
const DEFAULT_RATE = '+8%';
const DEFAULT_VOLUME = '+0%';
const SYNTH_TIMEOUT_MS = 20000;

// 小米 MiMo TTS（OpenAI 兼容的 chat/completions，音频在 message.audio.data）
const XIAOMI_URL = String(process.env.TTS_XIAOMI_URL || 'https://api.xiaomimimo.com/v1/chat/completions').trim();
const XIAOMI_MODEL = String(process.env.TTS_XIAOMI_MODEL || 'mimo-v2.5-tts').trim();
const DEFAULT_XIAOMI_VOICE = '冰糖';              // 中文女声；另可选 茉莉（女）/苏打/白桦（男）
const XIAOMI_TIMEOUT_MS = 60000;                  // 唱歌可能合成得久一些

// Edge 朗读接口的固定参数（与 edge-tts 保持一致）
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_VERSION = '143.0.3650.75';             // 被 403 时换成当前 Edge 版本号
const EDGE_MAJOR = EDGE_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `2-${EDGE_VERSION}`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

// 本机时钟若比服务器慢/快，Sec-MS-GEC 会被判过期（403）。拿到服务器 Date 后校准一次。
let clockSkewMs = 0;

function voiceName() {
    const v = String(process.env.TTS_VOICE || DEFAULT_VOICE).trim();
    // 音色名要拼进 SSML，只放行标准短名，避免被塞进别的东西
    return /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(v) ? v : DEFAULT_VOICE;
}
function rateValue() { return String(process.env.TTS_RATE || DEFAULT_RATE).trim(); }
/** 音量（SSML prosody volume）：相对默认音量的增减，如 +50% / -30%；Edge 一般只接受 -100%~+100% */
function volumeValue() { return String(process.env.TTS_VOLUME || DEFAULT_VOLUME).trim(); }

/** 当前 TTS 后端：显式配了 TTS_PROVIDER 就听它的，否则有小米 key 就用小米，没有就回退 Edge */
export function ttsProvider() {
    const p = String(process.env.TTS_PROVIDER || '').trim().toLowerCase();
    if (p === 'xiaomi' || p === 'edge') return p;
    return String(process.env.MIMO_API_KEY || '').trim() ? 'xiaomi' : 'edge';
}

/** 小米音色名（中文名直接传，如 冰糖 / 茉莉） */
function xiaomiVoice() {
    const v = String(process.env.TTS_XIAOMI_VOICE || DEFAULT_XIAOMI_VOICE).trim().replace(/[\r\n'"]/g, '');
    return v || DEFAULT_XIAOMI_VOICE;
}

// emoji / 颜文字里的符号：语音里不要带，读出来会很怪
/* eslint-disable no-misleading-character-class */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]+/gu;
/* eslint-enable no-misleading-character-class */

/** 去掉文本里的 emoji（保留 (风格标签)，那是小米 TTS 的指令） */
export function stripEmoji(text) {
    return String(text || '').replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 拼小米 MiMo TTS 的请求体（导出给单测）。
 * 目标文本必须放 assistant，风格标签（如 (唱歌)）也写在文本开头；
 * user 里可以放一句自然语言指令，内容不会被读出来。
 */
export function buildXiaomiRequest(text, voice, model = XIAOMI_MODEL, instruct = '') {
    const messages = [];
    const inst = String(instruct || '').trim();
    if (inst) messages.push({ role: 'user', content: inst });
    messages.push({ role: 'assistant', content: String(text) });
    return { model, messages, audio: { format: 'mp3', voice } };
}

/** 调一次小米 MiMo TTS，返回 mp3 字节 */
async function synthesizeXiaomi(text, voice) {
    const key = String(process.env.MIMO_API_KEY || '').trim();
    if (!key) throw new Error('没配 MIMO_API_KEY，无法使用小米 TTS');
    const res = await fetch(XIAOMI_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': key,
            'Authorization': `Bearer ${key}`,   // OpenAI 兼容客户端走 Bearer，两个都带上最稳
        },
        body: JSON.stringify(buildXiaomiRequest(text, voice, XIAOMI_MODEL, process.env.TTS_XIAOMI_INSTRUCT)),
        signal: AbortSignal.timeout(XIAOMI_TIMEOUT_MS),
    });
    if (!res.ok) {
        let detail = '';
        try { detail = String(await res.text() || '').replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* 读不出就算了 */ }
        throw new Error(`小米 TTS 返回 ${res.status}${detail ? '：' + detail : ''}`);
    }
    const data = await res.json();
    const b64 = data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.audio && data.choices[0].message.audio.data;
    if (!b64) throw new Error('小米 TTS 没返回音频');
    return Buffer.from(String(b64), 'base64');
}

/** Edge 的 Sec-MS-GEC 校验值（v2 格式，见 edgeDrm.js）：时间戳拼上固定 token 后的两段哈希 */
export function secMsGec(nowMs = Date.now()) {
    return generateSecMsGec((nowMs + clockSkewMs) / 1000);
}

/** Edge 要求每次连接带一个随机 muid Cookie */
function makeMuid() { return crypto.randomBytes(16).toString('hex').toUpperCase(); }

/** Edge 消息头里的时间格式：Fri Oct 18 2024 10:00:00 GMT+0000 (Coordinated Universal Time) */
function edgeTimestamp(d = new Date()) {
    const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = (n) => String(n).padStart(2, '0');
    return `${D[d.getUTCDay()]} ${M[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()}`
        + ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
        + ' GMT+0000 (Coordinated Universal Time)';
}

function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 拼 SSML（导出是为了单测能验证转义） */
export function buildSsml(text, voice, rate, volume = DEFAULT_VOLUME) {
    return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
        + `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='${volume}'>`
        + `${escXml(text)}</prosody></voice></speak>`;
}

function configMessage() {
    return `X-Timestamp:${edgeTimestamp()}\r\n`
        + 'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
        + JSON.stringify({
            context: {
                synthesis: {
                    audio: {
                        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                        outputFormat: OUTPUT_FORMAT,
                    },
                },
            },
        });
}

function ssmlMessage(text, voice, rate, volume) {
    return `X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\n`
        + 'Content-Type:application/ssml+xml\r\n'
        + `X-Timestamp:${edgeTimestamp()}Z\r\nPath:ssml\r\n\r\n`   // 末尾这个 Z 是 Edge 的老毛病，得照抄
        + buildSsml(text, voice, rate, volume);
}

/** 连一次 Edge 朗读接口，把文本合成 mp3 字节 */
function synthesizeOnce(text, voice, rate, volume) {
    const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
        + `?TrustedClientToken=${TRUSTED_TOKEN}`
        + `&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`
        + `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            perMessageDeflate: true,
            headers: {
                'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache',
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    + ` (KHTML, like Gecko) Chrome/${EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_MAJOR}.0.0.0`,
                'Cookie': `muid=${makeMuid()};`,
            },
        });

        const chunks = [];
        let done = false;
        const finish = (err, buf) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* 已经关了就算了 */ }
            if (err) reject(err); else resolve(buf);
        };
        const timer = setTimeout(() => finish(new Error(`Edge TTS 超时（${SYNTH_TIMEOUT_MS / 1000} 秒没合成完）`)), SYNTH_TIMEOUT_MS);

        ws.on('open', () => {
            ws.send(configMessage());
            ws.send(ssmlMessage(text, voice, rate, volume));
        });
        ws.on('message', (data, isBinary) => {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (isBinary) {
                // 二进制分片：前 2 字节是大端头部长度，跳过后才是音频数据
                if (buf.length < 3) return;
                const headerLen = buf.readUInt16BE(0);
                const audio = buf.subarray(2 + headerLen);
                if (audio.length) chunks.push(audio);
                return;
            }
            if (/Path:\s*turn\.end/i.test(buf.toString('utf8'))) {
                finish(null, Buffer.concat(chunks));
            }
        });
        ws.on('error', (e) => finish(new Error(`Edge TTS 连接失败：${e.message}`)));
        ws.on('unexpected-response', (_req, res) => {
            const err = new Error(`Edge TTS 被拒绝 (${res.statusCode})，多半是 EDGE_VERSION 过期了`);
            err.serverDate = res.headers && res.headers.date;   // 403 时借服务器时间校准本机时钟
            err.statusCode = res.statusCode;
            finish(err);
        });
        ws.on('close', () => { if (!done) finish(new Error('Edge TTS 连接被提前关闭')); });
    });
}

/** 连一次不行就校准时钟再试一次（本机时间偏差会让 Sec-MS-GEC 直接过期） */
async function synthesize(text, voice, rate, volume) {
    try {
        return await synthesizeOnce(text, voice, rate, volume);
    } catch (e) {
        if (e.statusCode !== 403 || !e.serverDate) throw e;
        const serverMs = Date.parse(e.serverDate);
        if (!Number.isFinite(serverMs)) throw e;
        clockSkewMs = serverMs - Date.now();
        logger.warn(`⚠️ Edge TTS 返回 403，按服务器时间校准本机时钟 ${Math.round(clockSkewMs / 1000)} 秒后重试`);
        return await synthesizeOnce(text, voice, rate, volume);
    }
}

/**
 * 文本转语音，落到 voice_cache 目录，返回文件路径。
 * 语音里不带 emoji：先统一清掉，再交给当前后端合成。
 * @param {string} text 要朗读的文本（可带 (风格) 标签，小米 TTS 会当指令）
 * @param {string|null} voiceId 覆盖音色；不传用 .env 里的默认音色
 * @returns {Promise<string>} 生成的音频路径（.mp3）
 */
export async function textToSpeech(text, voiceId = null) {
    const body = stripEmoji(text);
    if (!body) throw new Error('没有可朗读的文本');

    if (ttsProvider() === 'xiaomi') {
        const voice = String(voiceId || '').trim() || xiaomiVoice();
        logger.info(`🔊 请求 TTS（小米 MiMo ${voice}）`);
        const buffer = await synthesizeXiaomi(body, voice);
        if (!buffer || !buffer.length) throw new Error('小米 TTS 没返回音频');
        const filepath = path.join(VOICE_DIR, `tts_${Date.now()}.mp3`);
        fs.writeFileSync(filepath, buffer);
        logger.info(`✅ TTS 生成成功: ${filepath}`);
        return filepath;
    }

    const voice = String(voiceId || '').trim() || voiceName();
    const rate = rateValue();
    const volume = volumeValue();
    // Edge 不认 (风格) 标签，念出来会很怪，去掉开头那一个
    const edgeText = body.replace(/^\s*[(（[]\s*[^)）\]]{1,20}\s*[)）\]]\s*/, '') || body;

    logger.info(`🔊 请求 TTS（Edge ${voice} 语速 ${rate} 音量 ${volume}）`);
    const buffer = await synthesize(edgeText, voice, rate, volume);
    if (!buffer || !buffer.length) throw new Error('Edge TTS 没返回音频');

    const filepath = path.join(VOICE_DIR, `tts_${Date.now()}.mp3`);
    fs.writeFileSync(filepath, buffer);
    logger.info(`✅ TTS 生成成功: ${filepath}`);
    return filepath;
}

export function cleanVoiceCache(maxFiles = 50) {
    try {
        const files = fs.readdirSync(VOICE_DIR)
            .filter((f) => /\.(mp3|wav|m4a|ogg)$/i.test(f))
            .map((f) => ({ name: f, time: fs.statSync(path.join(VOICE_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
        if (files.length > maxFiles) {
            files.slice(maxFiles).forEach((f) => {
                fs.unlinkSync(path.join(VOICE_DIR, f.name));
                logger.info(`🗑️ 删除过期语音: ${f.name}`);
            });
        }
    } catch (e) { /* ignore */ }
}
