// ============================================================
// lang.js - 语言识别
//
// 设计：识别"这条消息主要用什么语言写的"，结果会写进喂给 AI 的元数据（语言:xx），
// 让 AI 知道对方在说哪种语言，从而用同一种语言回复。
//
// **功能完整、外部 API 留空**：默认走内置的"字符集启发式"（不依赖任何外部服务，永远可用）。
// 若之后要接外部语言识别 API，只需在 .env 填好 LANG_API_URL / LANG_API_KEY(HANDLER可选)，
// 调用方改用 detectLanguageAsync() 即可 —— 未配置时它会自动回退到本地启发式，不会报错。
// ============================================================

/** 语言代码 -> 中文名（交给 AI 看，用中文名更直观） */
export const LANG_NAMES = {
    zh: '中文',
    en: '英语',
    ja: '日语',
    ko: '韩语',
    ru: '俄语',
    ar: '阿拉伯语',
    el: '希腊语',
    th: '泰语',
    vi: '越南语',
    fr: '法语',
    de: '德语',
    es: '西班牙语',
    pt: '葡萄牙语',
    unknown: '未知',
};

/** 语言代码 -> 展示名（如 "中文"；未知时用原名） */
export function langLabel(code) {
    const c = String(code || '').toLowerCase();
    return LANG_NAMES[c] || c || '未知';
}

/** 各字符集所属语言（按优先级：命中最多者胜出） */
const SCRIPTS = [
    { code: 'ja', re: /[\u3040-\u309F\u30A0-\u30FF]/g },   // 假名（日语最显著的特征）
    { code: 'ko', re: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g }, // 谚文
    { code: 'zh', re: /[\u4E00-\u9FFF\u3400-\u4DBF]/g },   // 汉字（日文里也有，但假名会先盖过它）
    { code: 'ru', re: /[\u0400-\u04FF]/g },                // 西里尔
    { code: 'ar', re: /[\u0600-\u06FF\u0750-\u077F]/g },   // 阿拉伯
    { code: 'el', re: /[\u0370-\u03FF]/g },                // 希腊
    { code: 'th', re: /[\u0E00-\u0E7F]/g },                // 泰文
    { code: 'vi', re: /[\u1EA0-\u1EF9]/g },                // 越南语特有拉丁扩展
    { code: 'en', re: /[A-Za-z]/g },                       // 拉丁字母兜底（默认当作英语）
];

/**
 * 内置的字符集启发式：统计各字符集命中数，取最多的那个。
 * 纯表情 / 纯数字等情况返回 'unknown'。
 */
export function detectByScript(text) {
    const s = String(text || '');
    if (!s) return 'unknown';
    let best = 'unknown';
    let bestCount = 0;
    for (const { code, re } of SCRIPTS) {
        const n = (s.match(re) || []).length;
        if (n > bestCount) { bestCount = n; best = code; }
    }
    return bestCount > 0 ? best : 'unknown';
}

/**
 * 外部语言识别 API（**默认留空**）。
 * 未配置 LANG_API_URL 时直接返回 null（交给本地兜底）——这就是"API 留空"的含义。
 * 配了 API 的返回体各家不同，这里做了宽松兜底（取 lang/language/code 任一字段）。
 */
export async function detectLanguageRemote(text) {
    const url = String(process.env.LANG_API_URL || '').trim();
    if (!url) return null;
    const key = String(process.env.LANG_API_KEY || '').trim();
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
            body: JSON.stringify({ text: String(text || '') }),
        });
        if (!res.ok) return null;
        const j = await res.json();
        const code = String(j.lang || j.language || j.code || '').toLowerCase().slice(0, 8);
        return code || null;
    } catch {
        return null;   // 网络异常也不要影响主流程，交给本地兜底
    }
}

/** 同步识别（走本地启发式）—— 元数据构建这种同步场景用它 */
export function detectLanguage(text) {
    return detectByScript(text);
}

/** 异步识别：配了外部 API 就优先用它，取不到再回退本地 */
export async function detectLanguageAsync(text) {
    const remote = await detectLanguageRemote(text);
    return remote || detectByScript(text);
}
