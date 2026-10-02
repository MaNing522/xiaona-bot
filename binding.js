// ============================================================
// binding.js - QQ ↔ 游戏ID 绑定（#绑定 + 图形验证码）
//
// 规则：
//   · 桥接群的 QQ 消息只会转发给「已绑定游戏ID」的账号；没绑定的收不到
//   · 每个 QQ 最多绑定 3 个游戏ID（BIND_MAX_PER_QQ 可调）
//   · 绑定前必须答对 4 位图形验证码（防机器人批量绑定）
//
// 数据存在 data/bindings.json：{ "qq": { "<QQ号>": { "ids": ["Steve"], "at": 时间 } } }
// ============================================================
import path from 'path';
import { renderCaptcha } from './captcha.js';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import { logger } from './logger.js';

const GAME_ID = /^[A-Za-z0-9_]{3,16}$/;   // MC 正版/离线 ID 规则
const MAX_TRIES = 5;

let file = '';
let maxPerQq = 3;
let ttlSec = 300;
let data = { qq: {} };
/** 待验证：qq -> { answer, gameId, expires, tries } */
const pending = new Map();

export function initBindings(saveDir, opts = {}) {
  file = path.join(saveDir, 'bindings.json');
  maxPerQq = Number(opts.maxPerQq) > 0 ? Number(opts.maxPerQq) : 3;
  ttlSec = Number(opts.ttlSec) > 0 ? Number(opts.ttlSec) : 300;
  // 先清空再加载：重新初始化（如测试/重启）不能沿用上一轮的内存状态
  data = { qq: {} };
  pending.clear();
  const j = readJsonSafe(file, null, 'bindings.json');
  if (j && j.qq && typeof j.qq === 'object') data = { qq: j.qq };
  logger.info(`[绑定] 已加载 ${Object.keys(data.qq).length} 个 QQ 的绑定记录（每人上限 ${maxPerQq} 个游戏ID）`);
}

function save() {
  writeJsonAtomic(file, data);
}

export function maxPerQQ() { return maxPerQq; }

/** 某个 QQ 绑定的游戏ID */
export function getGameIdsOf(qq) {
  const e = entryOf(qq);
  return e && Array.isArray(e.ids) ? e.ids.slice() : [];
}

/** 所有已绑定的游戏ID（去重）—— 群消息就转发给这些账号 */
export function getReceivers() {
  const set = new Set();
  for (const qq of Object.keys(data.qq)) {
    for (const id of getGameIdsOf(qq)) set.add(id);
  }
  return [...set];
}

/** 该 QQ 的绑定记录（无则 null），并顺手清掉已经空掉的壳 */
function entryOf(qq) {
  const key = String(qq);
  const e = data.qq[key];
  if (e && Array.isArray(e.ids) && e.ids.length === 0) { delete data.qq[key]; return null; }
  return e || null;
}

/** 清掉已过期的待验证项：不然反复发 #绑定 又不答会一直堆在内存里 */
function sweepPending() {
  const now = Date.now();
  for (const [k, p] of pending) if (now > p.expires) pending.delete(k);
}

/**
 * 发起绑定：校验游戏ID与名额，生成验证码。
 * @returns {{ok:boolean, error?:string, image?:Buffer, gameId?:string, count?:number, ttlSec?:number}}
 */
export function startBind(qq, gameId) {
  sweepPending();
  const id = String(gameId || '').trim();
  if (!GAME_ID.test(id)) {
    return { ok: false, error: '游戏ID 只能是 3-16 位的字母、数字或下划线，例如 Steve' };
  }
  const key = String(qq);
  const ids = getGameIdsOf(key);
  if (ids.some((x) => x.toLowerCase() === id.toLowerCase())) {
    return { ok: false, error: `你已经绑定过 ${id} 了。查看： #我的绑定` };
  }
  if (ids.length >= maxPerQq) {
    return { ok: false, error: `每个QQ最多绑定 ${maxPerQq} 个游戏ID，你已经绑满：${ids.join('、')}\n先 #解绑 <游戏ID>，再绑新的` };
  }
  const answer = Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join('');
  pending.set(key, { answer, gameId: id, expires: Date.now() + ttlSec * 1000, tries: 0 });
  return { ok: true, image: renderCaptcha(answer), gameId: id, count: ids.length + 1, ttlSec };
}

/**
 * 把一条消息当作验证码答案来处理。
 * 只有「确实有待验证 + 消息基本就是 4 位数字」时才消费它，避免误吞正常聊天。
 * @returns {{handled:boolean, ok?:boolean, msg?:string}}
 */
export function answerCaptcha(qq, text) {
  const key = String(qq);
  const p = pending.get(key);
  if (!p) return { handled: false };
  if (Date.now() > p.expires) {
    pending.delete(key);
    return { handled: true, ok: false, msg: `⌛ 验证码已过期，请重新发送 #绑定 ${p.gameId}` };
  }
  // 只有「基本就是 4 位数字」才消费：允许前后有空白/标点、以及一个 @昵称（如 "@小钠 4832"）。
  // 不能用宽松的 \D{0,8}：那会把「我买了 1000 个方块」这类正常聊天也吞掉，还会白烧一次重试次数。
  const m = String(text || '').trim().match(/^(?:@[^\s]{1,12})?[\s、,，.。!！?？~*]*(\d{4})[\s、,，.。!！?？~*]*$/);
  if (!m) return { handled: false };

  if (m[1] !== p.answer) {
    p.tries += 1;
    if (p.tries >= MAX_TRIES) {
      pending.delete(key);
      return { handled: true, ok: false, msg: `❌ 验证码连错 ${MAX_TRIES} 次，已取消。请重新发送 #绑定 ${p.gameId}` };
    }
    return { handled: true, ok: false, msg: `❌ 验证码不对，还能再试 ${MAX_TRIES - p.tries} 次` };
  }

  pending.delete(key);
  const entry = data.qq[key] || (data.qq[key] = { ids: [], at: 0 });
  if (!Array.isArray(entry.ids)) entry.ids = [];
  entry.ids.push(p.gameId);
  entry.at = Date.now();
  save();
  logger.info(`[绑定] QQ ${key} ↔ 游戏ID ${p.gameId}（该QQ共 ${entry.ids.length} 个）`);
  return {
    handled: true,
    ok: true,
    msg: `✅ 绑定成功：${p.gameId}（${entry.ids.length}/${maxPerQq}）\n`
      + `之后群里有人发言，就会以 [QQ] 前缀转发进游戏给你这个账号。`,
  };
}

/** 解绑：arg 为游戏ID，或 all/全部 清空 */
export function unbind(qq, arg) {
  const key = String(qq);
  const entry = data.qq[key];
  const ids = entry && Array.isArray(entry.ids) ? entry.ids : [];
  if (!ids.length) return { ok: false, error: '你还没有绑定任何游戏ID。发送 #绑定 <游戏ID> 开始绑定' };

  const a = String(arg || '').trim();
  if (!a) return { ok: false, error: `用法：#解绑 <游戏ID>，或 #解绑 all 清空。当前：${ids.join('、')}` };
  if (a.toLowerCase() === 'all' || a === '全部') {
    delete data.qq[key];      // 不留空壳，否则「N 个 QQ 的绑定记录」会一直虚高
    save();
    return { ok: true, msg: `🗑️ 已解绑全部：${ids.join('、')}` };
  }
  const i = ids.findIndex((x) => x.toLowerCase() === a.toLowerCase());
  if (i < 0) return { ok: false, error: `没找到绑定 ${a}。当前：${ids.join('、')}` };
  const [removed] = ids.splice(i, 1);
  if (!ids.length) delete data.qq[key];
  else entry.at = Date.now();
  save();
  return { ok: true, msg: `🗑️ 已解绑 ${removed}${ids.length ? `，剩余：${ids.join('、')}` : '，你已没有绑定'}` };
}

/** 强制解绑（主人/管理员用）：清掉某个 QQ 的全部绑定，或只清掉其中一个游戏ID */
export function forceUnbind(qq, gameId) {
  const key = String(qq || '').trim();
  if (!/^\d{5,14}$/.test(key)) return { ok: false, error: 'QQ 号格式不对（5-14 位数字）' };
  // 注意：必须拿存储里的那个数组本身。getGameIdsOf 返回的是副本，splice 副本等于没删
  const entry = data.qq[key];
  const ids = entry && Array.isArray(entry.ids) ? entry.ids : [];
  if (!ids.length) return { ok: false, error: `QQ ${key} 没有绑定任何游戏ID` };

  const a = String(gameId || '').trim();
  if (!a) {
    const all = ids.slice();
    delete data.qq[key];
    save();
    return { ok: true, msg: `🗑️ 已强制解绑 QQ ${key} 的全部绑定：${all.join('、')}`, ids: all };
  }
  const i = ids.findIndex((x) => x.toLowerCase() === a.toLowerCase());
  if (i < 0) return { ok: false, error: `QQ ${key} 没有绑定 ${a}（其绑定：${ids.join('、')}）` };
  const [removed] = ids.splice(i, 1);
  if (!ids.length) delete data.qq[key];
  else entry.at = Date.now();
  save();
  return { ok: true, msg: `🗑️ 已强制解绑 QQ ${key} 的 ${removed}`, ids: [removed] };
}

/** 查看自己的绑定 */
export function listOf(qq) {
  const ids = getGameIdsOf(qq);
  if (!ids.length) {
    return `📭 你还没有绑定游戏ID。\n发送 #绑定 <游戏ID> 开始绑定（需输入图形验证码）。\n`
      + `绑定后，桥接群里的 QQ 消息会转发进游戏给你；每个QQ最多 ${maxPerQq} 个。`;
  }
  return `📋 你的绑定（${ids.length}/${maxPerQq}）：${ids.join('、')}\n#解绑 <游戏ID> 可解除，或 #解绑 all 全部清空。`;
}