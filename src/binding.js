// ============================================================
// binding.js - QQ ↔ 游戏ID 绑定（#绑定 + 图形验证码）
//
// 规则：
//   · 桥接群的 QQ 消息只会转发给「已绑定游戏ID」的账号；没绑定的收不到
//   · 每个 QQ 的绑定上限：全局默认在 config.json 的 bind.maxPerQQ，单个 QQ 可由管理员用 #绑定上限 覆盖
//   · 绑定前必须答对 4 位图形验证码（防机器人批量绑定）
//
// 数据存在 data/bindings.json：{ "qq": { "<QQ号>": { "ids": ["Steve"], "at": 时间 } }, "limits": { "<QQ号>": 数量 }, "unbinds": [{ "qq", "gameId", "at", "by" }] }
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
/** 解绑记录保留时长（毫秒）；默认 15 天，可由 config.json 的 bind.unbindRetainDays 调整 */
let unbindRetainMs = 15 * 24 * 3600 * 1000;
let data = { qq: {}, limits: {}, unbinds: [] };
/** 封禁名单：qq -> { until, reason, at }。until=0 表示永久（不会自动过期） */
let bans = {};
let banFile = '';
/** 待验证：qq -> { answer, gameId, expires, tries } */
const pending = new Map();
/** 绑定关系变化时的回调（index.js 注入：通知服务器刷新这些玩家的计分板） */
let onChange = null;

export function initBindings(saveDir, opts = {}) {
  file = path.join(saveDir, 'bindings.json');
  banFile = path.join(saveDir, 'bans.json');
  maxPerQq = Number(opts.maxPerQq) > 0 ? Number(opts.maxPerQq) : 3;
  ttlSec = Number(opts.ttlSec) > 0 ? Number(opts.ttlSec) : 300;
  const retainDays = Number(opts.unbindRetainDays);
  unbindRetainMs = Number.isFinite(retainDays) && retainDays >= 0
    ? Math.floor(retainDays) * 24 * 3600 * 1000
    : 15 * 24 * 3600 * 1000;
  // 没传就清空：重新初始化不能沿用上一轮的回调
  onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  // 先清空再加载：重新初始化（如测试/重启）不能沿用上一轮的内存状态
  data = { qq: {}, limits: {}, unbinds: [] };
  bans = {};
  pending.clear();
  const j = readJsonSafe(file, null, 'bindings.json');
  if (j && j.qq && typeof j.qq === 'object') {
    data = {
      qq: j.qq,
      limits: (j.limits && typeof j.limits === 'object' && !Array.isArray(j.limits)) ? { ...j.limits } : {},
      unbinds: Array.isArray(j.unbinds) ? j.unbinds.filter((u) => u && u.qq && u.gameId) : [],
    };
  } else data = { qq: {}, limits: {}, unbinds: [] };
  sweepUnbinds();
  const bj = readJsonSafe(banFile, null, 'bans.json');
  if (bj && typeof bj === 'object') {
    for (const [k, v] of Object.entries(bj)) {
      if (v && typeof v === 'object') bans[k] = { until: Number(v.until) || 0, reason: String(v.reason || ''), at: Number(v.at) || 0 };
    }
  }
  logger.info(`[绑定] 已加载 ${Object.keys(data.qq).length} 个 QQ 的绑定记录（每人上限 ${maxPerQq} 个游戏ID）`);
  if (Object.keys(bans).length) logger.info(`[绑定] 已加载 ${Object.keys(bans).length} 条封禁记录`);
}

/**
 * 通知外部"这几个游戏ID 的绑定状态变了"，好让它去刷新游戏内计分板。
 * 只是通知，失败/没接回调都不该影响绑定本身的结果。
 */
function notifyChange(ids) {
  if (!onChange || !Array.isArray(ids) || !ids.length) return;
  try {
    onChange(ids.slice());
  } catch (e) {
    logger.error('[绑定] 绑定变化通知失败（不影响绑定结果）:', e.message);
  }
}

function save() {
  writeJsonAtomic(file, data);
}

function saveBans() {
  writeJsonAtomic(banFile, bans);
}

export function maxPerQQ() { return maxPerQq; }

/** 全局默认上限热更新（config.json 的 bind.maxPerQQ 改动后由 index.js 调用） */
export function setGlobalMaxPerQQ(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > 0) maxPerQq = Math.floor(v);
}

/** 解绑记录保留天数热更新（config.json 的 bind.unbindRetainDays 改动后由 index.js 调用） */
export function setGlobalUnbindRetainDays(days) {
  const v = Number(days);
  if (Number.isFinite(v) && v >= 0) unbindRetainMs = Math.floor(v) * 24 * 3600 * 1000;
}

/** 某个 QQ 实际生效的绑定上限：有单独覆盖用覆盖值，否则用全局默认 */
export function limitOf(qq) {
  const key = String(qq || '');
  const o = data.limits && data.limits[key];
  const n = Number(o);
  return Number.isFinite(n) && n > 0 ? n : maxPerQq;
}

/**
 * 给某个 QQ 设置单独的绑定上限覆盖（管理员及以上用 #绑定上限 调用）。
 * n <= 0 表示清除覆盖、回退全局默认。
 * @returns {{ok:boolean, msg:string, max?:number}}
 */
export function setLimit(qq, n) {
  const key = String(qq || '').trim();
  if (!/^\d{5,14}$/.test(key)) return { ok: false, msg: 'QQ 号格式不对（5-14 位数字）' };
  const v = Math.floor(Number(n));
  if (!data.limits) data.limits = {};
  if (!Number.isFinite(v) || v <= 0) {
    delete data.limits[key];
    save();
    return { ok: true, msg: `✅ 已清除 QQ ${key} 的单独上限，回退全局默认 ${maxPerQq} 个。`, max: maxPerQq };
  }
  data.limits[key] = v;
  save();
  return { ok: true, msg: `✅ QQ ${key} 的绑定上限已设为 ${v} 个（全局默认 ${maxPerQq} 个）。`, max: v };
}

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

/**
 * 反查：某个游戏ID 绑在哪个 QQ 上（没有则返回 ''）。
 * 游戏内发 #命令 时用它还原身份——不还原的话 #我的绑定、主人权限这些全是错的。
 * 同一个ID 被多人绑定时取先遇到的那个（罕见，且彼此等价）。
 */
export function getQqOf(gameId) {
  const want = String(gameId || '').trim().toLowerCase();
  if (!want) return '';
  for (const qq of Object.keys(data.qq)) {
    if (getGameIdsOf(qq).some((id) => String(id).toLowerCase() === want)) return qq;
  }
  return '';
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

/* ============================================================
 * 封禁：被封禁的 QQ 不能绑定游戏ID，且封禁时解绑其名下所有账号。
 * 时间支持组合单位 5y3d3h3m3s（年/天/时/分/秒），n 表示永久；
 * 不填时间（或时间位置填了非时间内容）一律按永久处理。
 * ============================================================ */
const BAN_UNIT_MS = { y: 365 * 24 * 3600 * 1000, d: 24 * 3600 * 1000, h: 3600 * 1000, m: 60 * 1000, s: 1000 };
const BAN_DUR_RE = /^(?:(\d+)y)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;
const BAN_PERMANENT = new Set(['n', '永久', 'permanent', 'forever', '∞']);

/**
 * 解析封禁时间：'' / n / 永久 → 永久；5y3d3h3m3s → 毫秒数。
 * @returns {{permanent:boolean, ms:number}|null} 解析失败返回 null
 */
export function parseBanTime(str) {
  const s = String(str || '').trim();
  if (!s || BAN_PERMANENT.has(s.toLowerCase())) return { permanent: true, ms: 0 };
  const m = s.match(BAN_DUR_RE);
  if (!m || m.slice(1).every((x) => x === undefined)) return null; // 一个单位都没给 → 不是时间
  let ms = 0;
  const units = ['y', 'd', 'h', 'm', 's'];
  units.forEach((u, i) => { if (m[i + 1]) ms += Number(m[i + 1]) * BAN_UNIT_MS[u]; });
  if (ms <= 0) return null;
  return { permanent: false, ms };
}

/** 毫秒 → 「5年3天3小时3分3秒」（用于展示剩余时间/封禁时长） */
export function humanDuration(ms) {
  let rest = Math.max(0, Math.floor(ms / 1000));
  const y = Math.floor(rest / (365 * 24 * 3600)); rest %= 365 * 24 * 3600;
  const d = Math.floor(rest / (24 * 3600)); rest %= 24 * 3600;
  const h = Math.floor(rest / 3600); rest %= 3600;
  const mi = Math.floor(rest / 60);
  const s = rest % 60;
  const parts = [];
  if (y) parts.push(`${y}年`);
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}小时`);
  if (mi) parts.push(`${mi}分`);
  if (s) parts.push(`${s}秒`);
  return parts.join('') || '0秒';
}

/** 该 QQ 是否在封禁中（过期自动清除）；是则返回记录，否则 null */
export function isBanned(qq) {
  const key = String(qq || '');
  const e = bans[key];
  if (!e) return null;
  if (e.until && Date.now() > e.until) { delete bans[key]; saveBans(); return null; }
  return e;
}

/** 封禁生效期间的提示文案 */
function bannedMsg(e) {
  const left = e.until ? `（剩余 ${humanDuration(e.until - Date.now())}）` : '（永久）';
  const why = e.reason ? `，原因：${e.reason}` : '';
  return `你已被封禁${left}${why}，无法绑定游戏ID。如有疑问请联系管理员。`;
}

/**
 * 封禁一个 QQ：写入名单并立即解绑其名下所有游戏ID。
 * @param {string} qq 目标 QQ
 * @param {string} timeStr 时间（5y3d3h3m3s / n / 空）；填了非时间内容会被当作原因
 * @param {string} reason 原因（可空）
 * @returns {{ok:boolean, error?:string, permanent?:boolean, until?:number, reason?:string, ids?:string[]}}
 */
export function banUser(qq, timeStr, reason) {
  const key = String(qq || '').trim();
  if (!/^\d{5,14}$/.test(key)) return { ok: false, error: 'QQ 号格式不对（5-14 位数字）' };
  const time = String(timeStr || '').trim();
  let why = String(reason || '').trim();
  let dur = parseBanTime(time);
  // 时间位置填的不是时间 → 那是原因，整体按永久处理
  if (time && !dur) { why = [time, why].filter(Boolean).join(' '); dur = { permanent: true, ms: 0 }; }
  const until = dur.permanent ? 0 : Date.now() + dur.ms;
  bans[key] = { until, reason: why, at: Date.now() };
  saveBans();
  // 解绑其名下所有账号：玩家可能正在游戏里，onChange 会顺带撤销白名单放行
  const ub = forceUnbind(key);
  const ids = ub.ok ? ub.ids : [];
  logger.info(`[封禁] QQ ${key} ${dur.permanent ? '永久' : humanDuration(dur.ms)}${why ? ` 原因：${why}` : ''}，已解绑 ${ids.length} 个账号`);
  return { ok: true, permanent: dur.permanent, until, reason: why, ids };
}

/**
 * 解封一个 QQ：移出封禁名单（不恢复被封时已解绑的游戏ID，需本人重新 #绑定）。
 * @returns {{ok:boolean, error?:string}}
 */
export function unbanUser(qq) {
  const key = String(qq || '').trim();
  if (!/^\d{5,14}$/.test(key)) return { ok: false, error: 'QQ 号格式不对（5-14 位数字）' };
  if (!bans[key]) return { ok: false, error: `QQ ${key} 不在封禁名单中` };
  const e = bans[key];
  delete bans[key];
  saveBans();
  logger.info(`[解封] QQ ${key} 已解封${e.reason ? `（原封禁原因：${e.reason}）` : ''}`);
  return { ok: true };
}

/**
 * 发起绑定：校验是否被封禁、游戏ID与名额，生成验证码。
 * @returns {{ok:boolean, error?:string, image?:Buffer, gameId?:string, count?:number, ttlSec?:number}}
 */
export function startBind(qq, gameId) {
  sweepPending();
  const key = String(qq);
  const ban = isBanned(key);
  if (ban) return { ok: false, error: bannedMsg(ban) };
  const id = String(gameId || '').trim();
  if (!GAME_ID.test(id)) {
    return { ok: false, error: '游戏ID 只能是 3-16 位的字母、数字或下划线，例如 Steve' };
  }
  const ids = getGameIdsOf(key);
  if (ids.some((x) => x.toLowerCase() === id.toLowerCase())) {
    return { ok: false, error: `你已经绑定过 ${id} 了。查看： #我的绑定` };
  }
  if (ids.length >= limitOf(key)) {
    return { ok: false, error: `每个QQ最多绑定 ${limitOf(key)} 个游戏ID，你已经绑满：${ids.join('、')}\n先 #解绑 <游戏ID>，再绑新的` };
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
  const ban = isBanned(key);
  if (ban) {
    pending.delete(key);
    return { handled: true, ok: false, msg: `⛔ ${bannedMsg(ban)}` };
  }
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
  notifyChange([p.gameId]);   // 人可能正在游戏里：让服务器把计分板撤掉
  return {
    handled: true,
    ok: true,
    msg: `✅ 绑定成功：${p.gameId}（${entry.ids.length}/${limitOf(key)}）\n`
      + `之后群里有人发言，游戏里会显示成 [QQ][昵称][QQ号]：内容 转发给你这个账号。`,
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
    for (const id of ids) recordUnbind(key, id, 'self');
    save();
    notifyChange(ids);
    return { ok: true, msg: `🗑️ 已解绑全部：${ids.join('、')}` };
  }
  const i = ids.findIndex((x) => x.toLowerCase() === a.toLowerCase());
  if (i < 0) return { ok: false, error: `没找到绑定 ${a}。当前：${ids.join('、')}` };
  const [removed] = ids.splice(i, 1);
  if (!ids.length) delete data.qq[key];
  else entry.at = Date.now();
  recordUnbind(key, removed, 'self');
  save();
  notifyChange([removed]);
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
    for (const id of all) recordUnbind(key, id, 'admin');
    save();
    notifyChange(all);
    return { ok: true, msg: `🗑️ 已强制解绑 QQ ${key} 的全部绑定：${all.join('、')}`, ids: all };
  }
  const i = ids.findIndex((x) => x.toLowerCase() === a.toLowerCase());
  if (i < 0) return { ok: false, error: `QQ ${key} 没有绑定 ${a}（其绑定：${ids.join('、')}）` };
  const [removed] = ids.splice(i, 1);
  if (!ids.length) delete data.qq[key];
  else entry.at = Date.now();
  recordUnbind(key, removed, 'admin');
  save();
  notifyChange([removed]);
  return { ok: true, msg: `🗑️ 已强制解绑 QQ ${key} 的 ${removed}`, ids: [removed] };
}

/* ============================================================
 * 解绑记录：解绑（含退群/封禁导致的自动解绑）会留一条记录，供网页
 * 「绑定管理」查看；超过保留期（默认 15 天，config.json 的
 * bind.unbindRetainDays 可调）自动删除。
 * ============================================================ */

/** 记一条解绑记录（只改内存，落盘交给调用方统一 save） */
function recordUnbind(qq, gameId, by) {
  if (!Array.isArray(data.unbinds)) data.unbinds = [];
  data.unbinds.push({ qq: String(qq), gameId: String(gameId), at: Date.now(), by: by || '' });
}

/** 清掉超过保留期的解绑记录；有变化才落盘 */
function sweepUnbinds() {
  if (!Array.isArray(data.unbinds)) { data.unbinds = []; return; }
  const cutoff = Date.now() - unbindRetainMs;
  const kept = data.unbinds.filter((u) => u && Number(u.at) > cutoff);
  if (kept.length !== data.unbinds.length) { data.unbinds = kept; save(); }
}

/** 全部解绑记录（副本，含预计过期时间） */
export function listUnbinds() {
  sweepUnbinds();
  return (data.unbinds || []).map((u) => ({ ...u, expireAt: Number(u.at) + unbindRetainMs }));
}

/** 清空全部解绑记录，返回清掉的条数 */
export function clearUnbinds() {
  const n = Array.isArray(data.unbinds) ? data.unbinds.length : 0;
  data.unbinds = [];
  save();
  return n;
}

/** 删除一条解绑记录（按 qq + gameId + at 定位） */
export function deleteUnbind(qq, gameId, at) {
  if (!Array.isArray(data.unbinds)) return { ok: false, error: '没有解绑记录' };
  const i = data.unbinds.findIndex((u) => u && String(u.qq) === String(qq)
    && String(u.gameId) === String(gameId) && Number(u.at) === Number(at));
  if (i < 0) return { ok: false, error: '这条解绑记录已不存在' };
  data.unbinds.splice(i, 1);
  save();
  return { ok: true };
}

/**
 * 撤销一条解绑记录：把该 QQ ↔ 游戏ID 重新绑回去。
 * 被封禁的 QQ 不允许恢复（否则等于绕过封禁）。
 */
export function restoreUnbind(qq, gameId, at) {
  const key = String(qq || '').trim();
  const id = String(gameId || '').trim();
  if (!/^\d{5,14}$/.test(key)) return { ok: false, error: 'QQ 号格式不对（5-14 位数字）' };
  if (!GAME_ID.test(id)) return { ok: false, error: '游戏ID 格式不对' };
  const ban = isBanned(key);
  if (ban) return { ok: false, error: `QQ ${key} 正在封禁中，不能恢复绑定：${bannedMsg(ban)}` };
  const ids = getGameIdsOf(key);
  if (ids.some((x) => x.toLowerCase() === id.toLowerCase())) return { ok: false, error: `QQ ${key} 已绑定 ${id}` };
  if (ids.length >= limitOf(key)) return { ok: false, error: `QQ ${key} 的绑定已满（${limitOf(key)} 个）` };
  const entry = data.qq[key] || (data.qq[key] = { ids: [], at: 0 });
  if (!Array.isArray(entry.ids)) entry.ids = [];
  entry.ids.push(id);
  entry.at = Date.now();
  // 同一条解绑记录已经恢复过就删掉，避免重复点
  if (Array.isArray(data.unbinds)) {
    const i = data.unbinds.findIndex((u) => u && String(u.qq) === key
      && String(u.gameId) === id && Number(u.at) === Number(at));
    if (i >= 0) data.unbinds.splice(i, 1);
  }
  save();
  logger.info(`[绑定] 撤销解绑：QQ ${key} ↔ 游戏ID ${id}`);
  notifyChange([id]);
  return { ok: true };
}

/** 全部生效中的封禁（先清过期），按时间倒序 */
export function listBans() {
  const out = [];
  for (const qq of Object.keys(bans)) {
    const e = isBanned(qq);
    if (e) out.push({ qq, until: e.until, reason: e.reason, at: e.at });
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out;
}

/** 面板用的绑定总览：已绑定用户（含上限/封禁）+ 解绑记录 + 保留期 */
export function bindingOverview() {
  sweepUnbinds();
  const bound = [];
  for (const qq of Object.keys(data.qq)) {
    const entry = data.qq[qq];
    const ids = entry && Array.isArray(entry.ids) ? entry.ids : [];
    if (!ids.length) continue;
    const ban = isBanned(qq);
    bound.push({
      qq,
      ids: ids.slice(),
      at: Number(entry.at) || 0,
      limit: limitOf(qq),
      limitOverride: data.limits && data.limits[qq] != null ? Number(data.limits[qq]) : null,
      banned: !!ban,
      banUntil: ban ? ban.until : 0,
      banReason: ban ? ban.reason : '',
    });
  }
  return {
    bound,
    bans: listBans(),
    unbinds: listUnbinds(),
    retainDays: Math.round(unbindRetainMs / (24 * 3600 * 1000)),
    maxPerQQ: maxPerQq,
  };
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