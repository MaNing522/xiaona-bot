// ============================================================
// permission.js - 授权 / 权限系统（持久化到 data/）
// 角色档位（从高到低）：owner(主人) > admin(管理员) > authorized(授权用户) > guest(普通用户)
// 高档自动包含低档的全部权限；命令与档位的对应关系见 help.js 的 HELP_CMDS/TIERS。
// 授权由主人管理：普通用户提交申请 -> 主人同意/拒绝。
//
// 等级式管理（#授权 <@或QQ> <等级>）：
//   0 主人 / 1 管理员 / 2 授权用户 / 3 普通用户 / 4 黑名单（不响应，转发除外），默认 2
// .env 里的 BOT_OWNER / BOT_ADMINS 是「写死」的最高身份，命令改不动它们（需改 .env）。
// 命令能管理的是：额外主人 / 额外管理员 / 授权用户 / 黑名单（均持久化到 auth.json）。
// ============================================================
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 保证在 init() 之前 process.env 已从 .env 加载（本模块可能在 index.js 的 dotenv.config() 之前被 import）
// 显式指定路径，避免受启动目录影响
dotenv.config({ path: path.join(__dirname, '.env') });

// 存档路径在 init() 里确定（默认 SAVE_DIR 或项目下 data/，测试可传临时目录）
let AUTH_FILE = '';
let PENDING_FILE = '';

let owner = '';         // 来自 .env BOT_OWNER
let admins = [];        // 来自 .env BOT_ADMINS
let extraOwners = [];   // 命令授予的主人（持久化）
let extraAdmins = [];   // 命令授予的管理员（持久化）
let authorized = [];    // 已授权（持久化）
let blacklist = [];     // 黑名单：不响应其消息（转发除外，持久化）
let pending = [];       // 待主人审批的申请（持久化）
let favors = {};        // 好感度：QQ(或游戏ID) -> 0-100 的数值（持久化，默认 FAVOR_DEFAULT）

/** 等级 -> 中文名（#授权 命令用；也是显示名） */
export const LEVEL_NAMES = { 0: '主人', 1: '管理员', 2: '授权用户', 3: '普通用户', 4: '黑名单' };

function save() {
  writeJsonAtomic(AUTH_FILE, { authorized, extraOwners, extraAdmins, blacklist, favors });
}
function savePending() {
  writeJsonAtomic(PENDING_FILE, { pending });
}

/**
 * 载入配置与存档。默认读 SAVE_DIR/项目 data；测试可传 dir 指定临时目录。
 * @param {string} [dir] 存档目录（留空则用 SAVE_DIR 或项目下 data/）
 */
export function init(dir) {
  const dataDir = dir || process.env.SAVE_DIR || path.join(__dirname, 'data');
  AUTH_FILE = path.join(dataDir, 'auth.json');
  PENDING_FILE = path.join(dataDir, 'pending.json');
  owner = String(process.env.BOT_OWNER || '').trim();
  admins = (process.env.BOT_ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const a = readJsonSafe(AUTH_FILE, {}, 'auth.json');
  authorized = Array.isArray(a.authorized) ? a.authorized.map(String) : [];
  extraOwners = Array.isArray(a.extraOwners) ? a.extraOwners.map(String) : [];
  extraAdmins = Array.isArray(a.extraAdmins) ? a.extraAdmins.map(String) : [];
  blacklist = Array.isArray(a.blacklist) ? a.blacklist.map(String) : [];
  favors = (a.favors && typeof a.favors === 'object' && !Array.isArray(a.favors)) ? { ...a.favors } : {};
  const p = readJsonSafe(PENDING_FILE, {}, 'pending.json');
  pending = Array.isArray(p.pending) ? p.pending.map(String) : [];
}

/** 返回角色：owner | admin | authorized | guest */
export function role(userId) {
  const id = String(userId);
  if (owner && id === owner) return 'owner';
  if (extraOwners.includes(id)) return 'owner';
  if (admins.includes(id)) return 'admin';
  if (extraAdmins.includes(id)) return 'admin';
  if (authorized.includes(id)) return 'authorized';
  return 'guest';
}

/**
 * 四档的显示名（从高到低，供元数据/日志统一引用，避免各处各写一套）：
 *   owner 主人 > admin 管理员 > authorized 授权用户 > guest 普通用户
 *
 * 好感度是**动态值**（见 getFavor/adjustFavor）：所有人默认 FAVOR_DEFAULT(50)，
 * 由 AI 在交谈中按表现增减，但受档位上限约束（FAVOR_MAX）：
 *   主人固定 100%；管理员 / 授权用户 上限 90%；普通用户上限 80%。
 */
export const TIER_META = {
  owner: { name: '主人' },
  admin: { name: '管理员' },
  authorized: { name: '授权用户' },
  guest: { name: '普通用户' },
};

/** 好感度默认值（所有新用户从这里起步，由 AI 累积调整） */
export const FAVOR_DEFAULT = 50;

/** 各档好感度上限（主人固定即上限=下限=100） */
export const FAVOR_MAX = { owner: 100, admin: 90, authorized: 90, guest: 80 };

/** 把某档的好感度夹到 [0, 上限]；非法值回落默认值 */
function clampFavor(roleName, value) {
  const max = FAVOR_MAX[roleName] ?? FAVOR_MAX.guest;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return FAVOR_DEFAULT;
  return Math.max(0, Math.min(max, n));
}

/**
 * 取某人当前好感度（喂给 AI 的元数据用）。
 * 主人固定 100%；其余取持久化值（无则默认 50），并按档位上限夹一次。
 */
export function getFavor(userId) {
  const id = String(userId || '');
  if (!id) return FAVOR_DEFAULT;
  const r = role(id);
  if (r === 'owner') return 100;
  const stored = Object.prototype.hasOwnProperty.call(favors, id) ? favors[id] : FAVOR_DEFAULT;
  return clampFavor(r, stored);
}

/**
 * 直接设定某人好感度（夹到档位上限后持久化）；主人不接受改动，恒为 100。
 * @returns {{ok:boolean, favor:number, msg:string}}
 */
export function setFavor(userId, value) {
  const id = String(userId || '');
  if (!id) return { ok: false, favor: FAVOR_DEFAULT, msg: '缺少目标用户。' };
  const r = role(id);
  if (r === 'owner') return { ok: true, favor: 100, msg: '主人好感度固定 100%，无需调整。' };
  const nv = clampFavor(r, value);
  favors[id] = nv;
  save();
  return { ok: true, favor: nv, msg: `好感度已设为 ${nv}%（上限 ${FAVOR_MAX[r]}%）。` };
}

/**
 * 按增量调整好感度（AI 工具用）：正数加、负数减，夹到 [0, 档位上限]。
 * @returns {{ok:boolean, favor:number, max:number, msg:string}}
 */
export function adjustFavor(userId, delta) {
  const id = String(userId || '');
  const d = Math.round(Number(delta));
  if (!id) return { ok: false, favor: FAVOR_DEFAULT, max: FAVOR_MAX.guest, msg: '缺少目标用户。' };
  if (!Number.isFinite(d) || d === 0) return { ok: false, favor: getFavor(id), max: FAVOR_MAX[role(id)] ?? 80, msg: '请给出非零的好感度增减量。' };
  const r = role(id);
  if (r === 'owner') return { ok: true, favor: 100, max: 100, msg: '主人好感度固定 100%，无需调整。' };
  const cur = getFavor(id);
  const next = clampFavor(r, cur + d);
  if (next === cur) return { ok: true, favor: cur, max: FAVOR_MAX[r], msg: `好感度已是 ${cur}%（上限 ${FAVOR_MAX[r]}%），不变。` };
  favors[id] = next;
  save();
  return { ok: true, favor: next, max: FAVOR_MAX[r], msg: `好感度 ${cur}% → ${next}%（上限 ${FAVOR_MAX[r]}%）。` };
}

/** 是否有使用受限指令的权限 */
export function hasPermission(userId) {
  return role(userId) !== 'guest';
}

// ---------- 直接授权（仅主人调用） ----------
export function grant(userId) {
  const id = String(userId);
  const wasPending = pending.includes(id);
  pending = pending.filter((q) => q !== id);
  savePending();
  if (!authorized.includes(id)) {
    authorized.push(id);
    save();
    return { added: true, clearedPending: wasPending, msg: `已授权 QQ ${id}` };
  }
  return { added: false, clearedPending: wasPending, msg: `QQ ${id} 已在授权列表中` };
}

export function revoke(userId) {
  const id = String(userId);
  const i = authorized.indexOf(id);
  if (i >= 0) {
    authorized.splice(i, 1);
    save();
    return true;
  }
  return false;
}

// ---------- 等级式管理（#授权 <@或QQ> <等级>，仅主人调用） ----------
/** 该 QQ 是否被 .env 写死为最高身份（命令改不动） */
function envLocked(userId) {
  const id = String(userId);
  if (owner && id === owner) return '主人';
  if (admins.includes(id)) return '管理员';
  return '';
}

/** 是否为黑名单用户（不响应其消息） */
export function isBlacklisted(userId) {
  return blacklist.includes(String(userId));
}

/**
 * 把某个 QQ 设为指定等级（0-4），从其余名单里移除后加入目标名单。
 * 3 = 普通用户（等价于取消授权，从所有名单移除）。待审批记录一并清除。
 * @returns {{ok:boolean, msg:string, level?:number}}
 */
export function setLevel(userId, level) {
  const id = String(userId);
  const lv = Number(level);
  if (!Number.isInteger(lv) || lv < 0 || lv > 4) return { ok: false, msg: '❌ 等级需为 0-4' };
  const lock = envLocked(id);
  if (lock && ((lv === 0 && lock === '主人') || (lv === 1 && lock === '管理员'))) {
    // 已是该（或更高）身份，无需改动
    return { ok: true, msg: `ℹ️ QQ ${id} 本就是 .env 里写死的${lock}。`, level: lv };
  }
  if (lock) {
    return { ok: false, msg: `❌ QQ ${id} 是 .env 里写死的${lock}，不能通过命令降级（请改 BOT_${lock === '主人' ? 'OWNER' : 'ADMINS'}）` };
  }
  // 先从所有「命令可管理」的名单里清掉，再加入目标名单
  extraOwners = extraOwners.filter((q) => q !== id);
  extraAdmins = extraAdmins.filter((q) => q !== id);
  authorized = authorized.filter((q) => q !== id);
  blacklist = blacklist.filter((q) => q !== id);
  pending = pending.filter((q) => q !== id);

  if (lv === 0) extraOwners.push(id);
  else if (lv === 1) extraAdmins.push(id);
  else if (lv === 2) authorized.push(id);
  else if (lv === 4) blacklist.push(id);
  // lv === 3 不加任何名单 = 普通用户

  // 档位变了，好感度要按新档位的上限重新夹一次（例如从授权降到普通，88% 会被压到 80%）
  if (Object.prototype.hasOwnProperty.call(favors, id)) {
    const nr = role(id);
    favors[id] = nr === 'owner' ? 100 : clampFavor(nr, favors[id]);
  }

  savePending();
  save();
  emitLevel(id, lv);
  return { ok: true, msg: `✅ 已设置 QQ ${id} 为「${LEVEL_NAMES[lv]}」`, level: lv };
}

export function listBlacklist() { return blacklist.slice(); }
export function listExtraOwners() { return extraOwners.slice(); }
export function listExtraAdmins() { return extraAdmins.slice(); }

// ---------- 等级变更监听（供黑名单→服务器封禁名单同步用） ----------
let levelListener = null;
/**
 * 注册"某 QQ 等级变了"的回调（index.js 用它把黑名单同步到服务器）。
 * 只保留一个监听者；传 null 可注销。回调异常不影响等级设置本身。
 */
export function setLevelListener(fn) {
  levelListener = typeof fn === 'function' ? fn : null;
}
function emitLevel(id, level) {
  if (!levelListener) return;
  try { levelListener(id, level); } catch { /* 同步失败不影响授权结果 */ }
}

// ---------- 申请 / 审批 ----------
export function requestAuth(userId) {
  const id = String(userId);
  if (owner && id === owner) return { ok: true, msg: '你是主人，无需申请。' };
  if (admins.includes(id)) return { ok: true, msg: '你是管理员，无需申请。' };
  if (authorized.includes(id)) return { ok: false, msg: '你已在授权列表中。' };
  if (pending.includes(id)) return { ok: false, msg: '你的申请已提交，等待主人审批。' };
  pending.push(id);
  savePending();
  return { ok: true, msg: `申请已提交，等待主人审批（QQ ${id}）。` };
}

/** 主人同意授权（同时清待审） */
export function approveAuth(userId) {
  const id = String(userId);
  const i = pending.indexOf(id);
  const g = grant(id); // grant 会自动移除 pending
  return { existed: i >= 0, ...g };
}

/** 主人拒绝授权 */
export function rejectAuth(userId) {
  const id = String(userId);
  const i = pending.indexOf(id);
  if (i >= 0) {
    pending.splice(i, 1);
    savePending();
    return true;
  }
  return false;
}

export function listAuthorized() { return authorized.slice(); }
export function listPending() { return pending.slice(); }
export function getOwner() { return owner; }

init();