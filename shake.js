// ============================================================
// shake.js - 彩蛋：摇一摇对答
//
// 群成员发送其中任意一行，小钠就接下一行；最后一行接回第一行（循环）。
// 匹配时忽略所有空白，所以「摇一摇摇一摇」少打空格也能接上。
//
// 注意：第 2 句和第 4 句文字完全相同（都是「摇一摇 摇一摇」），
// 光靠查表会一直在第 2、3 句之间打转、走不到后面几句；
// 所以带一个"上一句"上下文：有人重复机器人刚接的那句，就顺着往下接。
//
// 机器人自己发的消息不算（否则会自己接自己，无限循环）——由调用方过滤。
// ============================================================

/** 对答顺序：改这个数组即可换词 */
export const SHAKE_LINES = [
  '来杯好茶摇一摇',
  '摇一摇 摇一摇',
  '吉星高照摇一摇',
  '摇一摇 摇一摇',
  '茶香绕 推个牌 接财到',
  '来财来财来',
  '上签在手 举杯共饮 皆吉兆',
];

const norm = (s) => String(s || '').replace(/\s+/g, '');

/**
 * 命中彩蛋则返回要接的那一句，否则 null。
 * @param {string} text 群里那行文字
 * @param {number} lastSent 机器人上一次接的那句的下标（-1 表示没有上下文）
 * @returns {{line:string, index:number}|null} index 供下次接续使用
 */
export function nextShakeLine(text, lastSent = -1) {
  const t = norm(text);
  if (!t) return null;
  const n = SHAKE_LINES.length;

  // 有人在重复机器人刚接的那句 → 顺着往下接（第 2/4 句同文时靠这条分辨）
  if (lastSent >= 0 && lastSent < n && norm(SHAKE_LINES[lastSent]) === t) {
    const idx = (lastSent + 1) % n;
    return { line: SHAKE_LINES[idx], index: idx };
  }

  // 没有上下文（或从中间插进来）：按第一处出现的这句往下接
  const i = SHAKE_LINES.findIndex((l) => norm(l) === t);
  if (i < 0) return null;
  const idx = (i + 1) % n;
  return { line: SHAKE_LINES[idx], index: idx };
}