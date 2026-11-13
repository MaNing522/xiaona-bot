// ============================================================
// asrSherpa.js - 本地语音识别服务（sherpa-onnx，纯 Node 实现）
//
// 目的：顶替原来的 FunASR / funasr-server（Python 虚拟环境），
//       用 sherpa-onnx 的 Node 原生绑定在本机把语音转成文字，
//       对外仍暴露**OpenAI 兼容**的 POST /v1/audio/transcriptions，
//       所以 src/asr.js 一行都不用改（它只认这个接口）。
//
// 用法：
//     node src/asrSherpa.js [--port 8899]
//   启动器 start.js 会在 ASR_URL 指向本机时自动拉起它（见 ensureAsrService）。
//
// 模型（放 models/ 下，不入库）：
//     SHERPA_MODEL_DIR   模型目录，默认 models/sherpa-paraformer-zh-small
//     SHERPA_MODEL_TYPE  paraformer（默认）| sensevoice
//     SHERPA_THREADS     推理线程数，默认 2
//   目录里需要 model.int8.onnx（或 model.onnx）与 tokens.txt。
//   paraformer-zh-small int8 约 82MB，1.7GB 内存的小机器也扛得住；
//   换 SenseVoice（约 239MB）只改 SHERPA_MODEL_DIR/TYPE，不用改代码。
//
// 支持的音频：wav（PCM 8/16/32bit、float32、多声道会自动混成单声道并重采样到 16k）；
//             其它格式（mp3/flac/m4a…）若系统里有 ffmpeg 就先转成 16k 单声道 PCM。
// QQ 语音多为 amr/silk，src/asr.js 已经先让 SnowLuma 转成 wav 再上传，正常走 wav 这条路。
// ============================================================
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const SAMPLE_RATE = 16000;
const MAX_BODY = 32 * 1024 * 1024;   // 单条语音上限 32MB，正常语音远小于此

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
        + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const log = (msg) => console.log(`${stamp()} [ASR] ${msg}`);

// ---------- 参数 ----------
function argValue(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
    const eq = process.argv.find((a) => a.startsWith(name + '='));
    return eq ? eq.slice(name.length + 1) : fallback;
}

const PORT = Number(argValue('--port', process.env.ASR_PORT || 8899));
const HOST = String(process.env.ASR_HOST || '127.0.0.1').trim();
const MODEL_DIR = path.resolve(ROOT, String(process.env.SHERPA_MODEL_DIR || 'models/sherpa-paraformer-zh-small').trim());
const MODEL_TYPE = String(process.env.SHERPA_MODEL_TYPE || 'paraformer').trim().toLowerCase();
const NUM_THREADS = Math.max(1, Number(process.env.SHERPA_THREADS || 2));

// ---------- sherpa-onnx 绑定（缺失时给出人话） ----------
let sherpa = null;
try {
    sherpa = (await import('sherpa-onnx-node')).default;
} catch (e) {
    log(`未安装 sherpa-onnx-node（npm i sherpa-onnx-node）：${e.message}`);
    process.exit(2);
}

/** 在模型目录里挑模型文件：优先 int8，其次 fp32 */
function modelFileOf(dir) {
    for (const name of ['model.int8.onnx', 'model.onnx', 'model.int8.onnx.quant', 'model.fp16.onnx']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    // 有些模型包文件名带前缀（如 paraformer-zh-small-xxx.int8.onnx）
    const onnx = fs.readdirSync(dir).filter((f) => f.endsWith('.onnx'));
    const int8 = onnx.find((f) => f.includes('.int8.'));
    return int8 ? path.join(dir, int8) : (onnx[0] ? path.join(dir, onnx[0]) : '');
}

function buildConfig() {
    const tokens = path.join(MODEL_DIR, 'tokens.txt');
    if (!fs.existsSync(tokens)) throw new Error(`模型目录缺少 tokens.txt：${MODEL_DIR}`);
    const model = modelFileOf(MODEL_DIR);
    if (!model) throw new Error(`模型目录缺少 *.onnx：${MODEL_DIR}`);

    const modelConfig = {
        tokens,
        numThreads: NUM_THREADS,
        provider: 'cpu',
        debug: 0,
    };
    if (MODEL_TYPE === 'sensevoice') {
        modelConfig.senseVoice = { model, language: 'auto', useInverseTextNormalization: 1 };
    } else {
        modelConfig.paraformer = { model };
    }
    return {
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig,
    };
}

// ---------- WAV 解码 ----------
/**
 * 解析 WAV（RIFF）字节，返回 { samples: Float32Array, sampleRate }。
 * 支持 PCM 8/16/32bit、IEEE float32、以及 WAVE_FORMAT_EXTENSIBLE 包装的这两种；
 * 多声道取平均混成单声道。解析不了返回 null。
 */
export function decodeWav(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

    let off = 12;
    let fmt = null;
    let data = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        const body = off + 8;
        if (id === 'fmt ') {
            fmt = {
                format: buf.readUInt16LE(body),
                channels: Math.max(1, buf.readUInt16LE(body + 2)),
                sampleRate: buf.readUInt32LE(body + 4),
                bits: buf.readUInt16LE(body + 14),
                // WAVE_FORMAT_EXTENSIBLE（0xFFFE）时真正的编码在 SubFormat 的第一个 2 字节
                sub: size >= 40 ? buf.readUInt16LE(body + 24) : 0,
            };
        } else if (id === 'data') {
            data = buf.subarray(body, Math.min(body + size, buf.length));
            break;
        }
        off = body + size + (size % 2);
    }
    if (!fmt || !data || !data.length) return null;

    const codec = fmt.format === 0xFFFE ? fmt.sub : fmt.format;
    const channels = fmt.channels;
    const frames = Math.floor(data.length / (channels * (fmt.bits / 8)));
    if (frames <= 0) return null;
    const out = new Float32Array(frames);

    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
            const p = (i * channels + c) * (fmt.bits / 8);
            if (codec === 3) {
                // IEEE float
                sum += fmt.bits === 64 ? data.readDoubleLE(p) : data.readFloatLE(p);
            } else if (fmt.bits === 8) {
                sum += (data[p] - 128) / 128;            // 8bit 是无符号
            } else if (fmt.bits === 16) {
                sum += data.readInt16LE(p) / 32768;
            } else if (fmt.bits === 32) {
                sum += data.readInt32LE(p) / 2147483648;
            } else {
                return null;                              // 24bit 少见，直接放弃
            }
        }
        out[i] = sum / channels;
    }
    return { samples: out, sampleRate: fmt.sampleRate || SAMPLE_RATE };
}

// ---------- 非 wav：借 ffmpeg 转 16k 单声道 ----------
let ffmpegPath = '';
try {
    // 只做一次探活，没有就记一行日志
    const probe = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    probe.on('error', () => { ffmpegPath = ''; });
    probe.on('spawn', () => { ffmpegPath = 'ffmpeg'; });
} catch { /* 没有 ffmpeg 就只支持 wav */ }

function ffmpegToPcm(buf) {
    return new Promise((resolve) => {
        if (!ffmpegPath) return resolve(null);
        const p = spawn(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
            '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks = [];
        p.stdout.on('data', (c) => chunks.push(c));
        p.on('error', () => resolve(null));
        p.on('close', (code) => {
            const pcm = Buffer.concat(chunks);
            if (code !== 0 || !pcm.length) return resolve(null);
            const samples = new Float32Array(Math.floor(pcm.length / 2));
            for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
            resolve({ samples, sampleRate: SAMPLE_RATE });
        });
        p.stdin.end(buf);
    });
}

/** 任意音频字节 → 16k 单声道 Float32Array */
async function toSamples(buf) {
    let wave = decodeWav(buf);
    if (!wave) wave = await ffmpegToPcm(buf);
    if (!wave || !wave.samples.length) return null;
    if (wave.sampleRate === SAMPLE_RATE) return wave.samples;
    const rs = new sherpa.LinearResampler(wave.sampleRate, SAMPLE_RATE);
    const out = rs.flush(wave.samples);
    return out && out.length ? out : null;
}

// ---------- multipart 解析（只依赖 Buffer，不引第三方） ----------
export function parseMultipart(body, boundary) {
    const parts = [];
    const delim = Buffer.from('--' + boundary);
    let pos = body.indexOf(delim);
    while (pos >= 0) {
        const start = pos + delim.length;
        if (body.slice(start, start + 2).toString() === '--') break;   // 结束标记
        const headEnd = body.indexOf('\r\n\r\n', start);
        if (headEnd < 0) break;
        const headerText = body.slice(start, headEnd).toString('utf8');
        const next = body.indexOf(delim, headEnd + 4);
        if (next < 0) break;
        // 去掉尾部 CRLF
        const dataEnd = next - 2 >= headEnd + 4 ? next - 2 : next;
        parts.push({
            header: headerText,
            name: (headerText.match(/name="([^"]*)"/i) || [])[1] || '',
            filename: (headerText.match(/filename="([^"]*)"/i) || [])[1] || '',
            data: body.slice(headEnd + 4, dataEnd),
        });
        pos = next;
    }
    return parts;
}

// ---------- 识别器 ----------
let recognizer = null;
let loading = null;

function loadRecognizer() {
    if (recognizer && recognizer.handle) return Promise.resolve(recognizer);
    if (loading) return loading;
    loading = (async () => {
        const cfg = buildConfig();
        log(`加载模型（${MODEL_TYPE}）：${path.relative(ROOT, MODEL_DIR)}，线程 ${NUM_THREADS}`);
        const t0 = Date.now();
        recognizer = await sherpa.OfflineRecognizer.createAsync(cfg);
        log(`模型加载完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return recognizer;
    })().catch((e) => {
        loading = null;
        throw e;
    });
    return loading;
}

/** 串行队列：sherpa 的原生解码是同步的，同时来两条也没意义 */
let queue = Promise.resolve();
function transcribeSamples(samples) {
    const job = queue.then(async () => {
        const rec = await loadRecognizer();
        const stream = rec.createStream();
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        await rec.decodeAsync(stream);
        return rec.getResult(stream);
    });
    queue = job.catch(() => {});
    return job;
}

// ---------- HTTP ----------
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error('音频太大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

/** 从请求里取音频字节：multipart 的 file 字段，或直接是音频裸流 */
function pickAudio(req, body) {
    const ct = String(req.headers['content-type'] || '');
    const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (m) {
        const parts = parseMultipart(body, (m[1] || m[2]).trim());
        const file = parts.find((p) => p.name === 'file' && p.data.length) || parts.find((p) => p.filename);
        if (file) return { buf: file.data, filename: file.filename };
    }
    if (/^(audio|application\/octet-stream)/i.test(ct) && body.length) return { buf: body, filename: '' };
    return null;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        return send(res, 200, {
            ok: true,
            engine: 'sherpa-onnx',
            model: MODEL_TYPE,
            modelDir: path.relative(ROOT, MODEL_DIR),
            ready: !!(recognizer && recognizer.handle),
            sampleRate: SAMPLE_RATE,
        });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/audio/transcriptions') {
        return send(res, 404, { error: 'not found' });
    }
    const t0 = Date.now();
    try {
        const body = await readBody(req);
        const audio = pickAudio(req, body);
        if (!audio) return send(res, 400, { error: '没有找到音频（需要 multipart 的 file 字段或 audio/* 裸流）' });
        const samples = await toSamples(audio.buf);
        if (!samples) {
            return send(res, 415, { error: `解不了这段音频（${audio.filename || '未知'}）：只支持 wav 或系统装了 ffmpeg` });
        }
        const r = await transcribeSamples(samples);
        const text = String((r && r.text) || '').trim();
        log(`识别完成 ${(Date.now() - t0)}ms｜${samples.length / SAMPLE_RATE}s 音频｜${text || '(空)'}`);
        return send(res, 200, { text });
    } catch (e) {
        log(`识别失败：${e.message}`);
        return send(res, 500, { error: e.message });
    }
});

server.listen(PORT, HOST, () => {
    log(`sherpa-onnx 语音识别服务已启动：http://${HOST}:${PORT}/v1/audio/transcriptions`);
    // 预热：启动即加载模型，避免第一条语音等太久
    loadRecognizer().catch((e) => log(`模型加载失败：${e.message}`));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        log('收到退出信号，关闭服务');
        try { server.close(); } catch { /* 忽略 */ }
        process.exit(0);
    });
}
