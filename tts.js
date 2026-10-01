// ============================================================
// tts.js
// 文本转语音 - 使用在线 API
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VOICE_DIR = path.join(__dirname, 'voice_cache');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

// 默认音色：曼波
const DEFAULT_VOICE_ID = '2aec4123eb4d51d43bbb47b91e1ece27';

export async function textToSpeech(text, voiceId = DEFAULT_VOICE_ID) {
    const url = `https://api-v2.yuafeng.cn/API/kktts.php?content=${encodeURIComponent(text)}&action=voice&voice_id=${voiceId}`;
    console.log(`🔊 请求 TTS: ${url}`);

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`TTS API 请求失败: ${resp.status}`);
    
    const json = await resp.json();
    if (json.code !== 0) throw new Error(`TTS API 错误: ${json.msg || '未知'}`);
    
    const audioUrl = json.data?.url;
    if (!audioUrl) throw new Error('TTS 响应中无音频 URL');

    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) throw new Error(`下载音频失败: ${audioResp.status}`);
    
    const buffer = await audioResp.arrayBuffer();
    const filename = `tts_${Date.now()}.mp3`;
    const filepath = path.join(VOICE_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(buffer));
    
    console.log(`✅ TTS 生成成功: ${filepath}`);
    return filepath;
}

export function cleanVoiceCache(maxFiles = 50) {
    try {
        const files = fs.readdirSync(VOICE_DIR)
            .filter(f => f.endsWith('.mp3'))
            .map(f => ({ name: f, time: fs.statSync(path.join(VOICE_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
        if (files.length > maxFiles) {
            files.slice(maxFiles).forEach(f => {
                fs.unlinkSync(path.join(VOICE_DIR, f.name));
                console.log(`🗑️ 删除过期语音: ${f.name}`);
            });
        }
    } catch (e) { /* ignore */ }
}