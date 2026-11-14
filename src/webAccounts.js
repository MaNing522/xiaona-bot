// ============================================================
// webAccounts.js - 网页面板的 QQ 账号密码（data/web-accounts.json，不进仓库）
// 只存 scrypt 哈希；登录方式见 webui.js：
//   - 所有者：可用 .env 的 WEBUI_PASSWORD，也可在网页改密码后改用账号密码
//   - 已绑定玩家 / 管理员：用验证码（bot 私聊发送）登录，登录后可设置/修改密码
// ============================================================
import path from 'path';
import crypto from 'crypto';
import { ROOT } from './paths.js';
import { readJsonSafe, writeJsonAtomic } from './datafile.js';

const FILE = path.join(ROOT, 'data', 'web-accounts.json');
const KEYLEN = 64;

function loadAll() {
    const d = readJsonSafe(FILE, { accounts: {} }, 'web-accounts.json');
    if (!d || typeof d !== 'object' || !d.accounts || typeof d.accounts !== 'object') return { accounts: {} };
    return d;
}

function hash(pass, salt) {
    return crypto.scryptSync(String(pass), salt, KEYLEN).toString('hex');
}

/** 统一 Unicode 规范化：中文输入法可能给出组合字符/全角形式，先归一化再哈希，避免“看起来一样却登不上” */
function norm(pass) {
    return String(pass == null ? '' : pass).normalize('NFC');
}

export function hasPassword(qq) {
    const a = loadAll().accounts[String(qq)];
    return !!(a && a.hash && a.salt);
}

/** 设置/修改密码（调用方负责校验旧密码或验证码身份） */
export function setPassword(qq, pass) {
    const key = String(qq);
    const all = loadAll();
    const salt = crypto.randomBytes(16).toString('hex');
    all.accounts[key] = { salt, hash: hash(norm(pass), salt), at: Date.now() };
    return writeJsonAtomic(FILE, all);
}

export function verifyPassword(qq, pass) {
    const a = loadAll().accounts[String(qq)];
    if (!a || !a.hash || !a.salt) return false;
    const got = Buffer.from(hash(norm(pass), a.salt), 'hex');
    const want = Buffer.from(a.hash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}
