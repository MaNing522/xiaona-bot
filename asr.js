// ============================================================
// asr.js - 语音识别（把 QQ 语音消息转成文字，喂给 AI）
//
// 用户发来的语音是 OneBot 的 record 段（里面是一段音频的 URL/文件名），
// AI 读不懂音频，需要调用"语音转文字(ASR)"把它变成文字再喂给 AI。
//
// **功能完整、外部 API 留空**：本模块把调用 ASR 的完整流程写好了，
// 但默认不接任何服务商——在 .env 填 ASR_API_URL / ASR_API_KEY 即启用；
// 没配置时一律返回 null，语音消息仍按 [语音] 占位处理，不影响其他功能。
//
// 接口约定（可自行对接任意 ASR 服务，近似 OpenAI 语音转写）：
//   POST ASR_API_URL
//   Header: Content-Type: application/json；有 ASR_API_KEY 时带 Authorization: Bearer <key>
//   Body(JSON): { url, file, format }
//   返回: JSON 的 text/result/data 字段，或纯文本；取其中的文字。
// ============================================================

/** 语音段占位（未配置/识别失败时用） */
export const VOICE_PLACEHOLDER = '[语音]';

function apiUrl() { return String(process.env.ASR_API_URL || '').trim(); }

/** 是否已配置 ASR 服务（供启动时打印功能状态） */
export function asrEnabled() { return !!apiUrl(); }

/**
 * 把一条语音段转成文字。
 * @param {object} data OneBot record 段的数据：{ file, url, path, format, ... }
 * @returns {Promise<string|null>} 识别出的文字；未配置或失败返回 null
 */
export async function transcribe(data) {
    if (!data) return null;
    const url = apiUrl();
    if (!url) return null;                 // API 留空：不做识别
    if (!data.url && !data.file && !data.path) return null;
    const key = String(process.env.ASR_API_KEY || '').trim();
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
            body: JSON.stringify({
                url: String(data.url || ''),
                file: String(data.file || ''),
                format: String(data.format || ''),
            }),
        });
        if (!res.ok) return null;
        const ct = String(res.headers.get('content-type') || '');
        if (ct.includes('application/json')) {
            const j = await res.json();
            const t = (typeof j === 'string') ? j : (j && (j.text || j.result || j.data));
            const s = String(t || '').trim();
            return s || null;
        }
        const s = (await res.text()).trim();
        return s || null;
    } catch {
        return null;                       // 网络异常不影响主流程
    }
}
