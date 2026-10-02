// ============================================================
// permission.js - 授权 / 权限系统（持久化到 data/）
// 角色等级：owner > admin > authorized > guest
// 授权由主人管理：普通用户提交申请 -> 主人同意/拒绝
// ============================================================
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 保证在 init() 之前 process.env 已从 .env 加载（本模块可能在 index.js 的 dotenv.config() 之前被 import）
// 显式指定路径，避免受启动目录影响
dotenv.config({ path: path.join(__dirname, '.env') });
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');

let owner = '';
let admins = [];      // 来自 .env BOT_ADMINS
let authorized = [];  // 已授权（持久化）
let pending = [];     // 待主人审批的申请（持久化）

function save() {
  writeJsonAtomic(AUTH_FILE, { owner, authorized });
}
function savePending() {
  writeJsonAtomic(PENDING_FILE, { pending });
}

export function init() {
  owner = String(process.env.BOT_OWNER || '').trim();
  admins = (process.env.BOT_ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const a = readJsonSafe(AUTH_FILE, {}, 'auth.json');
  authorized = Array.isArray(a.authorized) ? a.authorized.map(String) : [];
  const p = readJsonSafe(PENDING_FILE, {}, 'pending.json');
  pending = Array.isArray(p.pending) ? p.pending.map(String) : [];
}

/** 返回角色：owner | admin | authorized | guest */
export function role(userId) {
  const id = String(userId);
  if (owner && id === owner) return 'owner';
  if (admins.includes(id)) return 'admin';
  if (authorized.includes(id)) return 'authorized';
  return 'guest';
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