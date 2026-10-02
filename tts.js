// ============================================================
// tts.js - 文本转语音（玉峰 yuyin.php）
//
//   GET https://api-v2.yuafeng.cn/API/yuyin.php?apikey=<密钥>&id=<音色>&text=<文本>
//   返回 { code:0, data:{ id, format:'mp3', url } }，再下载 data.url 存到本地。
//
// 密钥与音色走 .env：TTS_API_KEY / TTS_VOICE_ID（默认 2969 可爱少女）。
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VOICE_DIR = path.join(__dirname, 'voice_cache');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

// 常用音色（可在 .env 用 TTS_VOICE_ID 覆盖）
//   2969 可爱少女（默认）  3716 崩坏3_爱莉希雅_可爱  853 阿库娅  1168 梅古米  1323 美树沙耶香
const DEFAULT_VOICE_ID = '2969';

export async function textToSpeech(text, voiceId = null) {
    const apikey = String(process.env.TTS_API_KEY || '').trim();
    if (!apikey) throw new Error('未配置 TTS_API_KEY（请在 .env 里填玉峰语音的密钥）');
    const id = String(voiceId || process.env.TTS_VOICE_ID || DEFAULT_VOICE_ID).trim();

    const url = 'https://api-v2.yuafeng.cn/API/yuyin.php'
        + `?apikey=${encodeURIComponent(apikey)}`
        + `&id=${encodeURIComponent(id)}`
        + `&text=${encodeURIComponent(text)}`;
    console.log(`🔊 请求 TTS（音色 ${id}）`);

    const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!resp.ok) throw new Error(`TTS API 请求失败: ${resp.status}`);

    const json = await resp.json();
    if (json.code !== 0) throw new Error(`TTS API 错误: ${json.msg || '未知'}`);

    const audioUrl = json.data && json.data.url;
    if (!audioUrl) throw new Error('TTS 响应中无音频 URL');

    const audioResp = await fetch(audioUrl, { signal: AbortSignal.timeout(60000) });
    if (!audioResp.ok) throw new Error(`下载音频失败: ${audioResp.status}`);

    const buffer = Buffer.from(await audioResp.arrayBuffer());
    const fmt = (json.data.format || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
    const filepath = path.join(VOICE_DIR, `tts_${Date.now()}.${fmt}`);
    fs.writeFileSync(filepath, buffer);

    console.log(`✅ TTS 生成成功: ${filepath}`);
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
                console.log(`🗑️ 删除过期语音: ${f.name}`);
            });
        }
    } catch (e) { /* ignore */ }
}
