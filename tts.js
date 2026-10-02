// ============================================================
// tts.js - 文本转语音（玉峰 kktts.php，免密钥）
//
//   GET https://api-v2.yuafeng.cn/API/kktts.php
//       ?action=voice&content=<文本>&voice_id=<音色>
//   返回 { code:0, data:{ url, file_id } }，再下载 data.url 存到本地。
//
//   音色列表：同地址 action=list（178 个音色）
// 音色走 .env：TTS_VOICE_ID（默认甜妹音）。
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VOICE_DIR = path.join(__dirname, 'voice_cache');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

// 默认音色：甜妹音（热门分类）。可在 .env 用 TTS_VOICE_ID 覆盖，
// 例如 ded710805a714c2a4523b84a8ed96388（夹子音2）；完整列表见 action=list。
const DEFAULT_VOICE_ID = 'cc073894e597a60a8a784ef4b4e9b473';

export async function textToSpeech(text, voiceId = null) {
    const id = String(voiceId || process.env.TTS_VOICE_ID || DEFAULT_VOICE_ID).trim();

    const url = 'https://api-v2.yuafeng.cn/API/kktts.php'
        + `?action=voice&content=${encodeURIComponent(text)}&voice_id=${encodeURIComponent(id)}`;
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
    const filepath = path.join(VOICE_DIR, `tts_${Date.now()}.mp3`);
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
