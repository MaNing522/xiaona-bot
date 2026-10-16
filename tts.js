// ============================================================
// tts.js - 文本转语音（微软 Edge 朗读服务，与 edge-tts 同款协议，免密钥）
//
// 走 Edge 的「大声朗读」WebSocket 接口（speech.platform.bing.com），
// 和 Python 的 edge-tts 用的是同一套协议：先发 speech.config，再发 SSML，
// 服务端回来的二进制分片（每片前 2 字节是大端长度）拼起来就是 mp3。
//
// 音色 / 语速走 .env：
//   TTS_VOICE  音色短名，默认 zh-CN-XiaoxiaoNeural（女声 XiaoXiao）
//   TTS_RATE   语速增减，默认 +8%
//   完整音色表：edge-tts --list-voices（或看名字规律 zh-CN-<名>Neural）
//
// 说明：接口免密钥、无需安装任何东西（只用到项目已有的 ws 依赖）。
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
const SYNTH_TIMEOUT_MS = 20000;

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
export function buildSsml(text, voice, rate) {
    return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
        + `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>`
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

function ssmlMessage(text, voice, rate) {
    return `X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\n`
        + 'Content-Type:application/ssml+xml\r\n'
        + `X-Timestamp:${edgeTimestamp()}Z\r\nPath:ssml\r\n\r\n`   // 末尾这个 Z 是 Edge 的老毛病，得照抄
        + buildSsml(text, voice, rate);
}

/** 连一次 Edge 朗读接口，把文本合成 mp3 字节 */
function synthesizeOnce(text, voice, rate) {
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
            ws.send(ssmlMessage(text, voice, rate));
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
async function synthesize(text, voice, rate) {
    try {
        return await synthesizeOnce(text, voice, rate);
    } catch (e) {
        if (e.statusCode !== 403 || !e.serverDate) throw e;
        const serverMs = Date.parse(e.serverDate);
        if (!Number.isFinite(serverMs)) throw e;
        clockSkewMs = serverMs - Date.now();
        logger.warn(`⚠️ Edge TTS 返回 403，按服务器时间校准本机时钟 ${Math.round(clockSkewMs / 1000)} 秒后重试`);
        return await synthesizeOnce(text, voice, rate);
    }
}

/**
 * 文本转语音，落到 voice_cache 目录，返回文件路径。
 * @param {string} text 要朗读的文本
 * @param {string|null} voiceId 覆盖音色（短名，如 zh-CN-XiaoxiaoNeural）；不传用 .env 的 TTS_VOICE
 * @returns {Promise<string>} 生成的 mp3 路径
 */
export async function textToSpeech(text, voiceId = null) {
    const body = String(text || '').trim();
    if (!body) throw new Error('没有可朗读的文本');
    const voice = String(voiceId || '').trim() || voiceName();
    const rate = rateValue();

    logger.info(`🔊 请求 TTS（Edge ${voice} ${rate}）`);
    const buffer = await synthesize(body, voice, rate);
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
