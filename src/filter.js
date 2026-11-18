// ============================================================
// filter.js - 转发消息的敏感词过滤
//
// 只做纯文本替换，不读配置、不碰网络，方便单测：
//   · 词表用逗号 / 顿号 / 分号 / 空白 / 竖线分隔（中文逗号也认）
//   · 英文不区分大小写；中文按原样匹配
//   · 命中后统一替换成占位符（默认 ***）
// ============================================================

/** 把配置里的词表字符串拆成去重后的数组 */
export function parseSensitiveWords(input) {
  return [...new Set(
    String(input ?? '')
      .split(/[\s,，、;；|]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )];
}

/**
 * 过滤一段文本。
 * @param {string} text 原文
 * @param {{enabled?:boolean, words?:string, replace?:string}} [opt] config.json 的 filter 段
 * @returns {string} 过滤后的文本（没开/没词表时原样返回）
 */
export function maskSensitive(text, opt) {
  const src = String(text ?? '');
  if (!src) return src;
  const o = opt || {};
  if (o.enabled === false) return src;
  const words = parseSensitiveWords(o.words);
  if (!words.length) return src;
  const rep = String(o.replace || '***');
  let out = src;
  for (const w of words) {
    // 转义正则元字符，避免用户写的词把正则写坏
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, rep);
  }
  return out;
}
