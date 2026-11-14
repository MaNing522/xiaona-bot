// ============================================================
// webui.js - 响应式网页控制面板（Node 内置 http/https，无第三方依赖；HTTPS 代码保留，由 WEBUI_HTTPS 开关控制）
// 功能：SnowLuma / QQ 连接状态、授权管理、状态监控、日志流
// ============================================================
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { WebSocket, WebSocketServer } from 'ws';
import * as perm from './permission.js';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import { renderCaptcha } from './captcha.js';
import { bot, logs, takeover, pushTakeoverMsg, getSendMsg, setTakeoverMode } from './state.js';
import { logger } from './logger.js';
import { isAiEnabled, balanceEndpoint, getProviderInfo } from './aiService.js';
import { isMcConnected, getGameBans, banPlayers, banEachPlayer, unbanEachPlayer, revokePunishments, getBridgeTarget, isMcConfigured, getPlayerPositions } from './mcbridge.js';
import { listProviders, getActiveId, saveProvider, deleteProvider, setActive } from './aiProviders.js';
import { isSearchEnabled, searchSettings } from './search.js';
import * as chatCfg from './chatSettings.js';
import { qzoneStatus, postQzoneNow, normalizeQzone } from './qzone.js';
import { HELP_CMDS, TIERS } from './help.js';
import { config, reloadConfig, CONFIG_PATH } from './config.js';
import {
  bindingOverview, forceUnbind, clearUnbinds, banUser, unbanUser,
  deleteUnbind, restoreUnbind, getGameIdsOf, startBind, answerCaptcha, unbind as unbindSelf,
  forceBind,
} from './binding.js';
import { hasPassword, setPassword, verifyPassword, listAccounts, deletePassword } from './webAccounts.js';
import { ROOT } from './paths.js';
import { ensureTls, CERT_FILE } from './tls.js';
import { transcribe } from './asr.js';
import {
  listConversations as inboxList, getMessages as inboxMessages,
  markRead as inboxMarkRead, convName, setConvName,
} from './qqInbox.js';

const SNOWLUMA_DIR = path.join(ROOT, 'snowluma');
const WEB_DIR = path.join(ROOT, 'web', 'index.html');
const HOME_FILE = path.join(ROOT, 'web', 'home.html');
// 网页 QQ：照搬 Stapxs QQ Lite 官方网页版的静态资源（原样保留它的绝对路径前缀，不改编译产物）
const SSQQ_DIR = path.join(ROOT, 'web', 'ssqq');
const SSQQ_PREFIX = '/Stapxs-QQ-Lite-2.0/';
// 网页 QQ 的 OneBot 反向代理目标：浏览器连同源 /ssqq/ws（不用带 token），服务端补 Authorization 再转给本机 OneBot
const ONEBOT_WS_URL = String(process.env.ONEBOT_WS || 'ws://127.0.0.1:3001').trim();
const ONEBOT_TOKEN = String(process.env.ONEBOT_TOKEN || '').trim();

// 面板协议：默认 HTTP；设 WEBUI_HTTPS=true 才启用 HTTPS（证书代码保留在 tls.js）
function useHttps() {
  return String(process.env.WEBUI_HTTPS || '').toLowerCase() === 'true';
}
// Cookie 的 Secure 只在 HTTPS 下加：HTTP 下加了浏览器会直接丢弃
function cookieSecure() {
  return useHttps() ? '; Secure' : '';
}

// OneBot 连接参数（与 index.js 保持一致；旧 NAPCAT_* 仍兼容）
const ONEBOT_WS = String(process.env.ONEBOT_WS || process.env.NAPCAT_WS || 'ws://127.0.0.1:3001').trim();

// WebUI 实际监听的端口（配置端口被占用时会自动顺延，这里记录真实值供状态页展示）
let webuiPort = 0;
export function getWebuiPort() {
  return webuiPort;
}

// 主人通知回调（由 index.js 注入，用于 QQ 通知主人审批）
let notifyOwner = null;
export function setOwnerNotifier(cb) {
  notifyOwner = cb;
}

// 试用页聊天回调（由 index.js 注入：以「小锂 · 普通用户」身份跑一轮私聊 AI）
let trialChat = null;
let trialReset = null;
export function setTrialChat(cb) {
  trialChat = cb;
}
// 试用会话不落盘：浏览器关闭（断开连接）时清空内存历史
export function setTrialReset(cb) {
  trialReset = cb;
}

// ---------- SnowLuma / QQ 连接状态 ----------
// SnowLuma 注入真实 QQ.exe；只有 QQ 登录成功后它才会监听 OneBot WS（默认 3001）。
// 所以「WS 端口在监听」≈「QQ 已登录且 SnowLuma 已就绪」，面板据此展示。
const ONEBOT_PORT = Number((ONEBOT_WS.match(/:(\d+)/) || [])[1] || 3001);

let slUp = false;
let slProbeAt = 0;

function probePort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

async function probeSnowLuma() {
  const now = Date.now();
  if (now - slProbeAt < 2000) return slUp; // 2s 缓存，避免高频探测
  slProbeAt = now;
  slUp = await probePort(ONEBOT_PORT);
  return slUp;
}

// QQ.exe 是否在跑（5 秒缓存；tasklist 查询不贵，但面板轮询很频繁）
let qqUp = false;
let qqProbeAt = 0;
function probeQQ() {
  const now = Date.now();
  if (now - qqProbeAt < 5000) return Promise.resolve(qqUp);
  qqProbeAt = now;
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      qqUp = !err && /QQ\.exe/i.test(String(stdout || ''));
      resolve(qqUp);
    });
  });
}

/** SnowLuma 控制台端口（可在 snowluma/config/runtime.json 改） */
function snowlumaWebuiPort() {
  const d = readJsonSafe(path.join(SNOWLUMA_DIR, 'config', 'runtime.json'), null, 'runtime.json');
  const p = Number(d && d.webuiPort);
  return Number.isFinite(p) && p > 0 ? p : 5099;
}

async function connectionStatus() {
  const up = await probeSnowLuma();
  const slPort = snowlumaWebuiPort();
  return {
    snowlumaUp: up,
    qqRunning: await probeQQ(),
    botConnected: bot.connected,
    botError: bot.lastError || '',
    wsUrl: ONEBOT_WS,
    snowlumaWebui: `http://127.0.0.1:${slPort}`,
    snowlumaWebuiPort: slPort,
  };
}

/** 最新一份 SnowLuma 日志的末尾若干行（日志文件在 snowluma/logs/） */
function tailSnowlumaLog(maxLines = 80) {
  try {
    const dir = path.join(SNOWLUMA_DIR, 'logs');
    const files = fs.readdirSync(dir).filter((f) => /^snowluma-.*\.log$/.test(f)).sort();
    if (!files.length) return [];
    const file = path.join(dir, files[files.length - 1]);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

// ---------- HTTP 工具 ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
    });
  });
}

// ---------- 全局设置的取值校正（AI / 记忆） ----------
/** AI 段：思考开关、思考强度白名单、上下文 5~50 条、温度 0~2 */
function normalizeAi(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const effort = String(a.reasoningEffort || 'auto').trim().toLowerCase();
  const temp = Number(a.temperature);
  const ctx = Number(a.contextMessages);
  return {
    thinking: a.thinking !== false,
    reasoningEffort: ['auto', 'low', 'high', 'max'].includes(effort) ? effort : 'auto',
    contextMessages: Number.isFinite(ctx) ? Math.min(50, Math.max(5, Math.round(ctx))) : 20,
    temperature: Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : 0.7,
  };
}

/** 记忆段：每人保留 5~20 条 */
function normalizeMemory(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const n = Number(m.maxUserMessages);
  return {
    maxUserMessages: Number.isFinite(n) ? Math.min(20, Math.max(5, Math.round(n))) : 12,
  };
}

// ---------- 面板认证：QQ 号 + 密码 / QQ 验证码 + 图形人机验证 + 会话 Cookie ----------
// 面板能以机器人身份发消息、管理授权，公开到局域网后必须挡一层。
// 所有者（.env BOT_OWNER）登录后是完整管理面板；其他人（已绑定玩家/管理员）只能进 /me 管自己的绑定。
const PANEL_USER = process.env.WEBUI_USER || 'admin'; // 兼容旧版会话文件，不参与登录
// 密码只从 .env 读，代码里不留任何默认值：没配就直接拒绝启动（fail-closed），
// 避免出现"忘了配密码 → 面板用一个人所共知的默认密码裸奔"的情况
const PANEL_PASS = process.env.WEBUI_PASSWORD || '';
const SESSION_TTL = 24 * 60 * 60 * 1000;    // 登录有效期 24 小时（非正常退出也按这个保留）
const SESSION_FILE = path.join(ROOT, 'data', 'webui-sessions.json');
const CAPTCHA_TTL = 3 * 60 * 1000;         // 验证码 3 分钟
const CAPTCHA_AFTER_FAILS = 5;             // 连续输错密码达到这个次数后，才要求人机验证
const LOGIN_MAX_FAIL = 10;                 // 连续失败上限（含验证码错误），超过则封 5 分钟
const LOGIN_BLOCK_MS = 5 * 60 * 1000;      // 超过上限封 5 分钟
const QQ_CODE_TTL = 5 * 60 * 1000;         // QQ 登录验证码 5 分钟
const QQ_CODE_MAX_TRIES = 5;
const QQ_CODE_SEND_GAP = 60 * 1000;        // 同一 QQ 两次发送间隔
const QQ_CODE_MAX_PER_HOUR = 5;

// token → { qq, exp }。落盘保存：机器人重启、浏览器异常关闭（没点退出登录）都不会丢会话，
// 只有主动调用 /api/logout 或超过 24 小时才失效。
const sessions = new Map();
const preAuth = new Map();     // 预登录 id → { answer, exp }
const failLog = new Map();     // ip → { n, until }
const loginCodes = new Map();  // qq → { code, exp, tries }
const codeSendLog = new Map(); // qq → { at, hourAt, hourN }

// 启动时恢复上次的登录会话（只认格式正确且未过期的；旧版只有过期时间的会话归给所有者）
for (const [token, val] of Object.entries(readJsonSafe(SESSION_FILE, {}, 'webui-sessions.json') || {})) {
  if (!/^[0-9a-f]{64}$/.test(token)) continue;
  const exp = typeof val === 'object' && val ? Number(val.exp) : Number(val);
  if (!(exp > Date.now())) continue;
  const qq = typeof val === 'object' && val && val.qq ? String(val.qq) : String(process.env.BOT_OWNER || PANEL_USER);
  sessions.set(token, { qq, exp, code: !!(typeof val === 'object' && val && val.code) });
}

function saveSessions() {
  const obj = {};
  for (const [token, s] of sessions) obj[token] = { qq: s.qq, exp: s.exp, code: !!s.code };
  writeJsonAtomic(SESSION_FILE, obj);
}

function sweepAuth() {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of sessions) if (now > v.exp) { sessions.delete(k); changed = true; }
  for (const [k, v] of preAuth) if (now > v.exp) preAuth.delete(k);
  for (const [k, v] of failLog) if (v.until && now > v.until) failLog.delete(k);
  for (const [k, v] of loginCodes) if (now > v.exp) loginCodes.delete(k);
  if (changed) saveSessions();
}

/** QQ 是否已绑定至少一个游戏ID */
function isBoundQq(qq) {
  try { return getGameIdsOf(qq).length > 0; } catch { return false; }
}

/** 能否用验证码登录：所有者、主人/管理员，或已绑定玩家（还必须在桥接群里，见 groupMember） */
function canLoginByCode(qq) {
  if (!/^\d{5,14}$/.test(qq)) return false;
  if (qq === String(process.env.BOT_OWNER || '').trim()) return true;
  const role = perm.role(qq);
  if (role === 'owner' || role === 'master' || role === 'admin') return true;
  return isBoundQq(qq);
}

// ---------- 群成员门槛：只有加入桥接群的用户才能登录面板 ----------
const BRIDGE_GROUP = String(process.env.MC_BRIDGE_GROUP || '').trim();
const MEMBER_TTL = 5 * 60 * 1000;   // 在群里：缓存 5 分钟，免得每次登录都打 OneBot
const NON_MEMBER_TTL = 60 * 1000;   // 不在群里：缓存 1 分钟，方便刚进群的人尽快登录
const memberCache = new Map();      // qq -> { ok, exp, error }

/** 是否为管理级角色（能用 /admin 子页面） */
function canAdmin(role) {
  return role === 'owner' || role === 'master' || role === 'admin';
}

/**
 * 查 QQ 是否在桥接群里（OneBot get_group_member_info）。
 * 未配置群 / 机器人没连上 / 查询失败都按“不能登录”处理（fail-closed）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function groupMember(qq) {
  if (!BRIDGE_GROUP) {
    return { ok: false, error: '面板还没配置桥接群（MC_BRIDGE_GROUP），暂时无法登录，请联系主人' };
  }
  const now = Date.now();
  const c = memberCache.get(qq);
  if (c && now < c.exp) return c.ok ? { ok: true } : { ok: false, error: c.error };
  const call = getSendMsg();
  if (!call) return { ok: false, error: '机器人还没连上 QQ，暂时无法验证群成员身份，请稍后再试' };
  try {
    const info = await call('get_group_member_info', {
      group_id: Number(BRIDGE_GROUP), user_id: Number(qq), no_cache: true,
    });
    const uid = info && (info.user_id != null ? info.user_id : (info.data && info.data.user_id));
    const ok = String(uid == null ? '' : uid) === String(qq);
    const error = ok ? '' : '只有在小钠的群里才能登录面板';
    memberCache.set(qq, { ok, exp: now + (ok ? MEMBER_TTL : NON_MEMBER_TTL), error });
    return ok ? { ok: true } : { ok: false, error };
  } catch (e) {
    logger.info(`[面板] 查询 QQ ${qq} 的群成员身份失败：${e && e.message ? e.message : e}`);
    return { ok: false, error: '无法确认群成员身份（机器人可能没连上 QQ），请稍后再试' };
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * 登录限速按来源 IP 统计。
 * 默认只认 TCP 来源地址：X-Forwarded-For 是客户端可伪造的，盲信它等于让人随便绕过锁定。
 * 只有确实放在反向代理后面（nginx 等）才开 WEBUI_TRUST_PROXY=true。
 */
function clientIp(req) {
  if ((process.env.WEBUI_TRUST_PROXY || '') === 'true') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

/** 固定时间比较，避免用长度/前缀逐步试出密码 */
function safeEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** 建立登录会话；返回给调用方统一发给前端。viaCode=用 QQ 验证码登录（可不输原密码改密码） */
function startSession(res, qq, ip, viaCode = false) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { qq, exp: Date.now() + SESSION_TTL, code: !!viaCode });
  saveSessions();
  res.setHeader('Set-Cookie', `xn_sess=${token}; Path=/; HttpOnly; SameSite=Lax${cookieSecure()}; Max-Age=${SESSION_TTL / 1000}`);
  logger.info(`🔓 面板登录成功 QQ ${qq}（${ip}）`);
  return { status: 200, body: { ok: true, qq, role: perm.role(qq), hasPassword: hasPassword(qq) } };
}

/** 取当前登录会话（含 QQ 与实时角色）；未登录/过期返回 null */
function sessionOf(req) {
  sweepAuth();
  const token = parseCookies(req).xn_sess;
  if (!/^[0-9a-f]{64}$/.test(token || '')) return null;
  const s = sessions.get(token);
  if (!s || Date.now() > s.exp) {
    if (sessions.delete(token)) saveSessions();
    return null;
  }
  return { qq: s.qq, exp: s.exp, code: !!s.code, role: perm.role(s.qq) };
}

/** 试用页客户端标识：按浏览器分配（会话级 Cookie，关掉浏览器即失效） */
const TRIAL_COOKIE = 'xn_tid';
function trialClientId(req, res) {
  let id = parseCookies(req)[TRIAL_COOKIE];
  if (!/^[0-9a-f]{32}$/.test(id || '')) {
    id = crypto.randomBytes(16).toString('hex');
    // 不设 Max-Age：会话级 Cookie，浏览器关闭即失效，试用历史随之被丢弃
    if (res && !res.headersSent) {
      res.setHeader('Set-Cookie', `${TRIAL_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${cookieSecure()}`);
    }
  }
  return id;
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/** 静态文件 Content-Type（网页 QQ 的编译产物只有这几种） */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** 把网页 QQ 的静态文件发出去；路径必须落在 web/ssqq 内（防 ../ 穿越） */
function serveSsqqFile(res, pathname) {
  const rel = pathname.startsWith(SSQQ_PREFIX)
    ? pathname.slice(SSQQ_PREFIX.length)
    : pathname.replace(/^\/ssqq\/?/, '');
  const file = path.resolve(SSQQ_DIR, ...decodeURIComponent(rel).split('/').filter(Boolean));
  if (!file.startsWith(SSQQ_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  // 编译产物文件名带 hash，可以长缓存；index.html 不快照，保证升级后立刻拿到新入口
  const cache = file.endsWith('index.html') ? 'no-store' : 'public, max-age=604800';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

/** 该 IP 是否已连续输错到需要人机验证（达到阈值才要求） */
function captchaNeeded(ip) {
  const f = failLog.get(ip);
  return !!f && (f.n || 0) >= CAPTCHA_AFTER_FAILS;
}

function loginPage(msg = '', needCaptcha = false) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f0f2f5">
<title>小钠控制面板 · 登录</title>
<style>
:root{
  --bg:#f0f2f5; --card:#fff; --card2:#f5f7fa; --line:#e8ebf0;
  --txt:#1f2329; --sub:#8a919f; --accent:#1677ff; --danger:#ff4d4f; --radius:10px;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
  background:var(--bg);color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{width:360px;max-width:100%;padding:28px 26px;border-radius:var(--radius);
  background:var(--card);border:1px solid #f0f0f0;box-shadow:0 2px 12px rgba(0,0,0,.06)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.logo{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:20px;flex:0 0 auto;
  background:linear-gradient(135deg,#1677ff,#4096ff);box-shadow:0 2px 8px rgba(22,119,255,.28)}
h1{margin:0;font-size:17px}
.sub{color:var(--sub);font-size:12px;line-height:1.5}
label{display:block;font-size:13px;color:var(--sub);margin:12px 0 5px}
input{width:100%;min-height:44px;padding:0 14px;border-radius:8px;border:1px solid #d9d9d9;
  background:var(--card);color:var(--txt);font-size:15px}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(22,119,255,.12)}
.row{display:flex;gap:10px;align-items:center;margin-top:8px}
.row input{flex:1}
.row img{height:44px;border-radius:8px;border:1px solid #d9d9d9;background:#fff;cursor:pointer}
button{width:100%;margin-top:18px;min-height:46px;border:1px solid var(--accent);border-radius:8px;
  background:var(--accent);color:#fff;font-family:inherit;font-size:15px;font-weight:500;cursor:pointer;transition:.15s}
button:hover{filter:brightness(1.06)}
button:active{transform:scale(.98)}
button:disabled{opacity:.6;cursor:default}
.err{margin-top:12px;color:var(--danger);font-size:12px;min-height:16px}
.alt{display:block;margin-top:14px;text-align:center;color:var(--accent);font-size:13px;text-decoration:none}
.alt:hover{text-decoration:underline}
@keyframes xnUp{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.card{animation:xnUp .38s cubic-bezier(.2,.8,.25,1) both}
.err:not(:empty){animation:xnUp .25s ease both}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<form class="card" id="f">
  <div class="brand">
    <div class="logo">🤖</div>
    <div>
      <h1>小钠控制面板</h1>
      <div class="sub">需要登录后使用</div>
    </div>
  </div>
  <label>QQ 号</label><input id="u" inputmode="numeric" autocomplete="username" placeholder="输入你的 QQ 号">
  <div id="pwBox">
    <label>密码</label><input id="p" type="password" autocomplete="current-password" placeholder="没设过密码就用验证码登录">
  </div>
  <div id="capBox" style="display:${needCaptcha ? 'block' : 'none'}">
    <label>人机验证</label>
    <div class="row">
      <input id="c" inputmode="numeric" maxlength="4" placeholder="4 位数字" autocomplete="off">
      <img id="cap" alt="验证码" title="点一下换一张">
    </div>
  </div>
  <button id="b">登录</button>
  <div id="codeBox" style="display:none">
    <label>QQ 验证码</label>
    <div class="row">
      <input id="vc" inputmode="numeric" maxlength="6" placeholder="机器人私聊发给你的 6 位数字" autocomplete="one-time-code">
      <button type="button" id="send" style="width:auto;min-height:44px;margin:0;padding:0 14px;font-size:13px">发送验证码</button>
    </div>
    <button type="button" id="cbtn" style="background:var(--card2);color:var(--txt);border-color:#d9d9d9">验证码登录</button>
  </div>
  <div class="err" id="e">${msg}</div>
  <div class="sub" style="margin-top:10px;text-align:center">只有加入小钠的群、并已绑定游戏ID的成员才能登录</div>
  <a class="alt" href="#" id="toggle">没有密码？用 QQ 验证码登录</a>
  <a class="alt" href="/">← 返回首页</a>
</form>
<script>
var $ = function (i) { return document.getElementById(i); };
function fresh() { $('cap').src = '/api/captcha?t=' + Date.now(); }
$('cap').onclick = fresh;
// 默认不显示验证码；只有连续输错达到阈值（服务端返回 captchaRequired）才露出来
function showCaptcha(show) {
  $('capBox').style.display = show ? 'block' : 'none';
  if (show && !$('cap').getAttribute('src')) fresh();
}
if (${needCaptcha ? 'true' : 'false'}) fresh();

$('toggle').onclick = function (ev) {
  ev.preventDefault();
  var box = $('codeBox');
  var show = box.style.display === 'none';
  box.style.display = show ? 'block' : 'none';
  // 验证码登录模式下不需要密码框和「登录」按钮，避免两套表单混在一起
  $('pwBox').style.display = show ? 'none' : 'block';
  $('b').style.display = show ? 'none' : 'block';
  if (show) {
    $('capBox').setAttribute('data-prev', $('capBox').style.display || 'none');
    $('capBox').style.display = 'none';
  } else {
    $('capBox').style.display = $('capBox').getAttribute('data-prev') || 'none';
  }
  $('toggle').textContent = show ? '返回密码登录' : '没有密码？用 QQ 验证码登录';
};

function post(url, body, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', url, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    var j = {};
    try { j = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
    cb(xhr.status, j);
  };
  xhr.onerror = function () { cb(0, { error: '网络错误' }); };
  xhr.send(JSON.stringify(body || {}));
}
function done(j) {
  if (j.role === 'owner') { location.href = '/'; return; }
  if (j.role === 'master' || j.role === 'admin') { location.href = '/admin'; return; }
  location.href = '/me' + (j.needSetPassword ? '?setpwd=1' : '');
}

// 密码登录
$('f').onsubmit = function (ev) {
  ev.preventDefault();
  $('b').disabled = true; $('e').textContent = '';
  post('/api/login', { qq: $('u').value.trim(), pass: $('p').value, captcha: $('c').value }, function (st, j) {
    if (st >= 200 && st < 300 && j.ok) { done(j); return; }
    $('e').textContent = j.error || ('登录失败（HTTP ' + st + '）');
    if (j.captchaRequired) showCaptcha(true);
    $('b').disabled = false; $('c').value = ''; $('p').value = '';
    if ($('capBox').style.display !== 'none') fresh();
  });
};

// 发送 QQ 验证码
var timer = null;
$('send').onclick = function () {
  var qq = $('u').value.trim();
  if (!qq) { $('e').textContent = '先填 QQ 号'; return; }
  $('send').disabled = true; $('e').textContent = '';
  post('/api/login/send-code', { qq: qq }, function (st, j) {
    if (st >= 200 && st < 300 && j.ok) {
      $('e').textContent = '验证码已私聊发到 QQ，5 分钟内有效';
      var left = 60;
      timer = setInterval(function () {
        if (--left <= 0) { clearInterval(timer); $('send').disabled = false; $('send').textContent = '发送验证码'; return; }
        $('send').textContent = left + 's';
      }, 1000);
    } else {
      $('e').textContent = j.error || '发送失败';
      $('send').disabled = false;
    }
  });
};

// 验证码登录
$('cbtn').onclick = function () {
  var qq = $('u').value.trim(), code = $('vc').value.trim();
  if (!qq || !code) { $('e').textContent = '填 QQ 号和验证码'; return; }
  $('cbtn').disabled = true; $('e').textContent = '';
  post('/api/login/code', { qq: qq, code: code }, function (st, j) {
    if (st >= 200 && st < 300 && j.ok) { done(j); return; }
    $('e').textContent = j.error || ('登录失败（HTTP ' + st + '）');
    $('cbtn').disabled = false;
  });
};
</script></body></html>`;
}

/** 非所有者的「我的账号」页：只能看/管自己的游戏绑定与密码 */
function mePage(sess) {
  const qq = String(sess.qq);
  const isOwner = sess.role === 'owner';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的账号 · 小钠</title>
<style>
:root{--bg:#f0f2f5;--card:#fff;--line:#e8ebf0;--txt:#1f2329;--sub:#8a919f;--accent:#1677ff;--danger:#ff4d4f}
*{box-sizing:border-box}
body{margin:0;padding:22px 16px 40px;background:var(--bg);color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:560px;margin:0 auto}
.head{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.logo{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:20px;
  background:linear-gradient(135deg,#1677ff,#4096ff)}
h1{margin:0;font-size:17px}
.sub{color:var(--sub);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
h2{margin:0 0 12px;font-size:15px}
label{display:block;font-size:13px;color:var(--sub);margin:10px 0 5px}
input{width:100%;min-height:42px;padding:0 12px;border-radius:8px;border:1px solid #d9d9d9;font-size:15px;background:#fff}
input:focus{outline:none;border-color:var(--accent)}
button{min-height:42px;padding:0 18px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);
  color:#fff;font-size:14px;font-family:inherit;cursor:pointer}
button.ghost{background:#fff;color:var(--txt);border-color:#d9d9d9}
button:disabled{opacity:.55;cursor:default}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.list{margin-top:10px}
.item{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)}
.item:first-child{border-top:0}
.item b{flex:1;font-weight:600;font-size:14px}
.hint{color:var(--sub);font-size:12px;line-height:1.6}
.err{color:var(--danger);font-size:12px;min-height:16px;margin-top:8px;white-space:pre-wrap}
.ok{color:#16a34a}
#capimg{height:52px;border:1px solid #d9d9d9;border-radius:8px;background:#fff}
</style></head><body><div class="wrap">
<div class="head"><div class="logo">🤖</div><div><h1>我的账号</h1>
  <div class="sub">QQ ${qq}${isOwner ? ' · 所有者' : ''}</div></div></div>

<div class="card">
  <h2>我的游戏绑定</h2>
  <div class="hint">这里只能管理你自己 QQ 下的绑定。解绑后被封禁/白名单会同步更新。</div>
  <div class="list" id="list"><span class="hint">加载中…</span></div>
  <div class="row" style="margin-top:12px">
    <input id="gid" placeholder="要绑定的游戏ID，如 Steve" style="flex:1;min-width:160px">
    <button id="start" class="ghost">发送验证</button>
  </div>
  <div id="verifyBox" style="display:none;margin-top:10px">
    <div class="hint">把图片里的 4 位验证码填在下面，确认后即完成绑定：</div>
    <img id="capimg" alt="验证码">
    <div class="row" style="margin-top:8px">
      <input id="vcode" inputmode="numeric" maxlength="4" placeholder="4 位验证码" style="flex:1;min-width:120px">
      <button id="verify">确认绑定</button>
    </div>
  </div>
  <div class="err" id="bindErr"></div>
</div>

<div class="card">
  <h2>登录密码</h2>
  <div class="hint" id="pwdHint">设置后可用 QQ 号 + 密码登录；支持中文密码，忘记密码就用验证码登录后重设。</div>
  <div id="oldWrap" style="display:none"><label>原密码</label><input id="oldPass" type="password"></div>
  <label>新密码（至少 6 位，支持中文）</label><input id="newPass" type="password" autocomplete="new-password">
  <label>确认新密码</label><input id="newPass2" type="password" autocomplete="new-password">
  <div class="row" style="margin-top:12px"><button id="savePwd">保存密码</button></div>
  <div class="err" id="pwdErr"></div>
</div>

<div class="row" style="justify-content:space-between">
  ${canAdmin(sess.role) ? '<a class="hint" href="/admin">管理面板 →</a>' : '<span class="hint">小钠控制面板</span>'}
  <button id="logout" class="ghost">退出登录</button>
</div>
</div>
<script>
var $=function(i){return document.getElementById(i)};
function post(url,body,cb){
  var xhr=new XMLHttpRequest();xhr.open('POST',url,true);
  xhr.setRequestHeader('Content-Type','application/json');
  xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;var j={};try{j=JSON.parse(xhr.responseText||'{}')}catch(e){}
    cb(xhr.status,j)};
  xhr.onerror=function(){cb(0,{error:'网络错误'})};
  xhr.send(JSON.stringify(body||{}));
}
function get(url,cb){
  var xhr=new XMLHttpRequest();xhr.open('GET',url,true);
  xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;var j={};try{j=JSON.parse(xhr.responseText||'{}')}catch(e){}
    cb(xhr.status,j)};
  xhr.send();
}
function load(){
  get('/api/me',function(st,j){
    if(st===401){location.href='/login';return}
    if(!j.ok){$('list').innerHTML='<span class="hint">'+ (j.error||'加载失败') +'</span>';return}
    var bs=j.bindings||[];
    $('list').innerHTML=bs.length?bs.map(function(b){
      return '<div class="item"><b>'+b.id+'</b><button class="ghost" data-id="'+b.id+'" style="min-height:32px;padding:0 12px;font-size:12px">解绑</button></div>'
    }).join(''):'<span class="hint">还没有绑定任何游戏ID</span>';
    Array.prototype.forEach.call(document.querySelectorAll('#list [data-id]'),function(btn){
      btn.onclick=function(){
        if(!confirm('确认解绑 '+btn.dataset.id+' ？'))return;
        post('/api/me/unbind',{gameId:btn.dataset.id},function(s,r){
          if(!r.ok){alert(r.error||'解绑失败');return}
          load();
        });
      };
    });
    $('oldWrap').style.display=(j.hasPassword && !j.viaCode)?'block':'none';
    $('pwdHint').textContent=j.hasPassword?(j.viaCode?'本次是验证码登录，可直接设置新密码。':'支持中文密码；忘记密码就用验证码登录后重设。'):'还没设置密码，设置后就能用 QQ 号+密码登录（支持中文）。';
  });
}
$('start').onclick=function(){
  var gid=$('gid').value.trim();
  if(!gid){$('bindErr').textContent='先填游戏ID';return}
  $('start').disabled=true;$('bindErr').textContent='';
  post('/api/me/bind/start',{gameId:gid},function(st,j){
    if(!j.ok){$('bindErr').textContent=j.error||'发起绑定失败';$('start').disabled=false;return}
    $('verifyBox').style.display='block';
    $('capimg').src=j.image;
    $('bindErr').textContent='验证码 '+(j.ttlSec||180)+' 秒内有效';
    $('start').disabled=false;
  });
};
$('verify').onclick=function(){
  var code=$('vcode').value.trim();
  if(!code){$('bindErr').textContent='填验证码';return}
  $('verify').disabled=true;$('bindErr').textContent='';
  post('/api/me/bind/verify',{code:code},function(st,j){
    $('verify').disabled=false;
    if(!j.ok){$('bindErr').textContent=j.error||'验证失败';return}
    $('bindErr').textContent=j.msg||'绑定成功';
    $('bindErr').className='err ok';
    $('verifyBox').style.display='none';$('vcode').value='';$('gid').value='';
    load();
  });
};
$('savePwd').onclick=function(){
  var a=$('newPass').value,b=$('newPass2').value;
  if(a!==b){$('pwdErr').textContent='两次输入不一致';return}
  $('savePwd').disabled=true;$('pwdErr').textContent='';
  post('/api/me/password',{oldPass:$('oldPass').value,newPass:a},function(st,j){
    $('savePwd').disabled=false;
    if(!j.ok){$('pwdErr').textContent=j.error||'保存失败';return}
    $('pwdErr').className='err ok';$('pwdErr').textContent='密码已保存';
    $('oldPass').value='';$('newPass').value='';$('newPass2').value='';
    $('oldWrap').style.display='block';
  });
};
$('logout').onclick=function(){post('/api/logout',{},function(){location.href='/login'})};
load();
</script></body></html>`;
}

/** 管理子页（主人/管理员）：管理所有人的网页账户与游戏绑定 */
function adminPage(sess) {
  const qq = String(sess.qq);
  const roleName = { owner: '所有者', master: '主人', admin: '管理员' }[sess.role] || '管理员';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理中心 · 小钠</title>
<style>
:root{--bg:#f0f2f5;--card:#fff;--line:#e8ebf0;--txt:#1f2329;--sub:#8a919f;--accent:#1677ff;--danger:#ff4d4f}
*{box-sizing:border-box}
body{margin:0;padding:22px 16px 40px;background:var(--bg);color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:760px;margin:0 auto}
.head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.logo{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:20px;
  background:linear-gradient(135deg,#1677ff,#4096ff)}
h1{margin:0;font-size:17px}
.sub{color:var(--sub);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}
.user{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
.uhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.uhead b{font-size:15px}
.tag{font-size:11px;padding:2px 8px;border-radius:999px;background:#eef4ff;color:var(--accent)}
.tag.bad{background:#fff1f0;color:var(--danger)}
.tag.off{background:#f2f3f5;color:var(--sub)}
.ids{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:13px;padding:4px 10px;border-radius:999px;background:#f5f7fa;border:1px solid var(--line)}
.chip button{border:0;background:transparent;color:var(--danger);cursor:pointer;font-size:14px;padding:0;line-height:1}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
input{min-height:38px;padding:0 10px;border-radius:8px;border:1px solid #d9d9d9;font-size:14px;background:#fff}
input:focus{outline:none;border-color:var(--accent)}
input[type=text]{flex:1;min-width:150px}
button{min-height:38px;padding:0 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);
  color:#fff;font-size:13px;font-family:inherit;cursor:pointer}
button.ghost{background:#fff;color:var(--txt);border-color:#d9d9d9}
button:disabled{opacity:.55;cursor:default}
.hint{color:var(--sub);font-size:12px;line-height:1.6}
.err{color:var(--danger);font-size:12px;min-height:16px;margin-top:6px;white-space:pre-wrap}
.ok{color:#16a34a}
</style></head><body><div class="wrap">
<div class="head"><div class="logo">🛠️</div><div><h1>管理中心</h1>
  <div class="sub">${roleName} ${qq} · 管理所有人的账户与游戏绑定</div></div></div>

<div class="card">
  <div class="row" style="margin:0">
    <input id="q" type="text" placeholder="搜索 QQ 或游戏ID">
    <button id="refresh" class="ghost">刷新</button>
  </div>
  <div class="hint" style="margin-top:8px">登录门槛：QQ 必须在桥接群里。这里可以直接给人补绑/解绑游戏ID、清除网页密码（对方之后用验证码登录重设）。</div>
  <div class="err" id="msg"></div>
</div>

<div id="list"><div class="hint">加载中…</div></div>

<div class="row" style="justify-content:space-between">
  <a class="hint" href="/heatmap">📍 位置热力图</a>
  <a class="hint" href="/me">← 我的账号</a>
  <button id="logout" class="ghost">退出登录</button>
</div>
</div>
<script>
var $=function(i){return document.getElementById(i)};
var USERS=[];
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function post(url,body,cb){
  var xhr=new XMLHttpRequest();xhr.open('POST',url,true);
  xhr.setRequestHeader('Content-Type','application/json');
  xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;var j={};try{j=JSON.parse(xhr.responseText||'{}')}catch(e){}
    cb(xhr.status,j)};
  xhr.onerror=function(){cb(0,{error:'网络错误'})};
  xhr.send(JSON.stringify(body||{}));
}
function get(url,cb){
  var xhr=new XMLHttpRequest();xhr.open('GET',url,true);
  xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;var j={};try{j=JSON.parse(xhr.responseText||'{}')}catch(e){}
    cb(xhr.status,j)};
  xhr.send();
}
function flash(t,ok){var m=$('msg');m.className='err'+(ok?' ok':'');m.textContent=t||''}
function load(){
  get('/api/admin/users',function(st,j){
    if(st===401){location.href='/login';return}
    if(!j.ok){flash(j.error||'加载失败');return}
    USERS=j.users||[];render();
  });
}
function render(){
  var kw=($('q').value||'').trim().toLowerCase();
  var list=USERS.filter(function(u){
    if(!kw)return true;
    return u.qq.toLowerCase().indexOf(kw)>=0||(u.ids||[]).some(function(id){return id.toLowerCase().indexOf(kw)>=0});
  });
  if(!list.length){$('list').innerHTML='<div class="hint">没有匹配的用户</div>';return}
  $('list').innerHTML=list.map(function(u){
    var ids=(u.ids||[]).map(function(id){
      return '<span class="chip">'+esc(id)+'<button data-unbind="'+esc(u.qq)+'" data-id="'+esc(id)+'" title="解绑">×</button></span>';
    }).join('')||'<span class="hint">还没有绑定</span>';
    return '<div class="user">'
      +'<div class="uhead"><b>QQ '+esc(u.qq)+'</b>'
      +'<span class="tag">'+esc(u.roleName||u.role||'普通用户')+'</span>'
      +(u.banned?'<span class="tag bad">封禁中'+(u.banReason?'：'+esc(u.banReason):'')+'</span>':'')
      +'<span class="tag '+(u.hasPassword?'':'off')+'">'+(u.hasPassword?'已设密码':'未设密码')+'</span></div>'
      +'<div class="ids">'+ids+'</div>'
      +'<div class="row"><input type="text" placeholder="要补绑的游戏ID" data-gid="'+esc(u.qq)+'">'
      +'<button class="ghost" data-bind="'+esc(u.qq)+'">绑定</button>'
      +(u.hasPassword?'<button class="ghost" data-pwd="'+esc(u.qq)+'">清除密码</button>':'')
      +'</div></div>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('[data-unbind]'),function(b){
    b.onclick=function(){
      if(!confirm('确认解绑 QQ '+b.dataset.unbind+' 的 '+b.dataset.id+' ？'))return;
      post('/api/admin/unbind',{qq:b.dataset.unbind,gameId:b.dataset.id},function(st,r){
        flash(r.ok?('已解绑 '+b.dataset.id):(r.error||'解绑失败'),!!r.ok);if(r.ok)load();
      });
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-bind]'),function(b){
    b.onclick=function(){
      var qq=b.dataset.bind;
      var inp=document.querySelector('[data-gid="'+qq+'"]');
      var gid=(inp&&inp.value||'').trim();
      if(!gid){flash('先填游戏ID');return}
      b.disabled=true;
      post('/api/admin/bind',{qq:qq,gameId:gid},function(st,r){
        b.disabled=false;
        flash(r.ok?('已给 QQ '+qq+' 绑定 '+gid):(r.error||'绑定失败'),!!r.ok);if(r.ok)load();
      });
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-pwd]'),function(b){
    b.onclick=function(){
      if(!confirm('清除 QQ '+b.dataset.pwd+' 的网页密码？对方之后要用验证码登录重设。'))return;
      post('/api/admin/password/clear',{qq:b.dataset.pwd},function(st,r){
        flash(r.ok?'已清除密码':(r.error||'清除失败'),!!r.ok);if(r.ok)load();
      });
    };
  });
}
$('q').oninput=render;
$('refresh').onclick=load;
$('logout').onclick=function(){post('/api/logout',{},function(){location.href='/login'})};
load();
</script></body></html>`;
}

/** 位置热力图页（所有者/主人/管理员）：三个维度同时画，一人一色，主世界↔下界坐标互映 */
function heatmapPage(sess) {
  const home = sess.role === 'owner' ? '/' : '/admin';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>位置热力图 · 小钠</title>
<style>
:root{--bg:#f0f2f5;--card:#fff;--line:#e8ebf0;--txt:#1f2329;--sub:#8a919f;--accent:#1677ff;--danger:#ff4d4f}
*{box-sizing:border-box}
body{margin:0;padding:22px 16px 40px;background:var(--bg);color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:0 auto}
.head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.logo{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:20px;
  background:linear-gradient(135deg,#1677ff,#4096ff)}
h1{margin:0;font-size:17px}
h2{margin:0 0 8px;font-size:15px}
.sub{color:var(--sub);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{min-height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);
  color:#fff;font-size:13px;font-family:inherit;cursor:pointer}
button.ghost{background:#fff;color:var(--txt);border-color:#d9d9d9}
button.mini{min-height:26px;padding:0 10px;font-size:12px;margin-left:auto}
button:disabled{opacity:.55;cursor:default}
.hint{color:var(--sub);font-size:12px;line-height:1.6}
.err{color:var(--danger);font-size:12px;min-height:16px;margin-top:6px;white-space:pre-wrap}
.maps{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:1000px){.maps{grid-template-columns:1fr 1fr}}
.maps .mapcard:first-child{grid-column:1/-1}
.mapcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.maph{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.cvwrap{position:relative;background:#fafbfc;border:1px solid var(--line);border-radius:10px;overflow:hidden}
canvas{display:block;width:100%}
.tip{position:absolute;display:none;pointer-events:none;background:rgba(31,35,41,.9);color:#fff;
  font-size:12px;padding:3px 8px;border-radius:6px;white-space:nowrap;z-index:2}
.legend{display:flex;gap:8px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;border-radius:999px;
  background:#fff;border:1px solid var(--line);cursor:pointer;user-select:none}
.chip.off{opacity:.4;text-decoration:line-through}
.dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
.find{color:var(--accent);text-decoration:none;font-size:12px;border-left:1px solid var(--line);padding-left:8px}
.meta{color:var(--sub);font-size:12px}
a{color:var(--accent);text-decoration:none}
</style></head><body><div class="wrap">
<div class="head"><div class="logo">🗺️</div><div><h1>位置热力图</h1>
  <div class="sub">全服玩家最近的活动位置 · 每个玩家一种颜色 · 三个维度同时显示</div></div></div>

<div class="card">
  <div class="row">
    <label class="hint row" style="gap:4px"><input type="checkbox" id="mapNether" checked> 主世界 ↔ 下界坐标互映（×8）</label>
    <span style="flex:1"></span>
    <label class="hint row" style="gap:4px"><input type="checkbox" id="auto" checked> 自动刷新</label>
    <button id="refresh" class="ghost">刷新</button>
  </div>
  <div class="meta" id="meta" style="margin-top:8px">加载中…</div>
  <div class="err" id="err"></div>
</div>

<div class="maps">
  <div class="mapcard">
    <div class="maph"><b>主世界</b><span class="meta" id="mt-overworld">—</span>
      <button class="ghost mini" data-reset="minecraft:overworld">全图</button></div>
    <div class="cvwrap"><canvas id="cv-overworld"></canvas><div class="tip" id="tip-overworld"></div></div>
  </div>
  <div class="mapcard">
    <div class="maph"><b>下界</b><span class="meta" id="mt-the_nether">—</span>
      <button class="ghost mini" data-reset="minecraft:the_nether">全图</button></div>
    <div class="cvwrap"><canvas id="cv-the_nether"></canvas><div class="tip" id="tip-the_nether"></div></div>
  </div>
  <div class="mapcard">
    <div class="maph"><b>末地</b><span class="meta" id="mt-the_end">—</span>
      <button class="ghost mini" data-reset="minecraft:the_end">全图</button></div>
    <div class="cvwrap"><canvas id="cv-the_end"></canvas><div class="tip" id="tip-the_end"></div></div>
  </div>
</div>

<div class="card" style="margin-top:12px">
  <h2>玩家图例</h2>
  <div class="hint" style="margin:0 0 8px">点整块可隐藏/显示；点「定位」把对应维度缩放到他当前位置。</div>
  <div class="legend" id="legend"></div>
</div>

<div class="row" style="justify-content:space-between">
  <a class="hint" href="${home}">← 返回</a>
  <span class="hint">小钠 · 位置热力图</span>
</div>
</div>
<script>
var $=function(i){return document.getElementById(i)};
var DIMS=[
  {id:'minecraft:overworld',cid:'overworld',name:'主世界'},
  {id:'minecraft:the_nether',cid:'the_nether',name:'下界'},
  {id:'minecraft:the_end',cid:'the_end',name:'末地'}
];
var DATA=null, HIDDEN={}, VIEW={}, TRANS={}, COLORS={}, timer=null, MAPON=true;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function get(url,cb){
  var xhr=new XMLHttpRequest();xhr.open('GET',url,true);
  xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;var j={};try{j=JSON.parse(xhr.responseText||'{}')}catch(e){}
    cb(xhr.status,j)};
  xhr.onerror=function(){cb(0,{error:'网络错误'})};
  xhr.send();
}
function allNames(){
  var seen={}, out=[];
  (DATA&&DATA.players||[]).forEach(function(p){if(!seen[p.name]){seen[p.name]=1;out.push(p.name)}});
  out.sort();return out;
}
function colorFor(name){
  if(!COLORS[name]){
    var names=allNames(), i=names.indexOf(name);
    COLORS[name]='hsl('+Math.round(((i<0?0:i)*137.508)%360)+',72%,52%)';
  }
  return COLORS[name];
}
function rawSeries(dim){
  return ((DATA&&DATA.players)||[]).filter(function(p){
    return p.dim===dim && !HIDDEN[p.name+'|'+p.dim];
  });
}
function mapped(p,f){
  return {
    name:p.name, mapped:true,
    pts:(p.pts||[]).map(function(pt){return [pt[0]*f,pt[1]*f]}),
    last:p.last?{x:p.last.x*f,z:p.last.z*f}:null
  };
}
function seriesOf(dim){
  var out=rawSeries(dim).map(function(p){return {name:p.name,mapped:false,pts:p.pts||[],last:p.last||null}});
  if(MAPON){
    if(dim==='minecraft:overworld'){
      rawSeries('minecraft:the_nether').forEach(function(p){out.push(mapped(p,8))});
    }else if(dim==='minecraft:the_nether'){
      rawSeries('minecraft:overworld').forEach(function(p){out.push(mapped(p,1/8))});
    }
  }
  return out;
}
var sprites={};
function sprite(color){
  if(sprites[color])return sprites[color];
  var c=document.createElement('canvas');c.width=c.height=64;
  var g=c.getContext('2d');
  var grd=g.createRadialGradient(32,32,0,32,32,32);
  grd.addColorStop(0,color);grd.addColorStop(1,'rgba(0,0,0,0)');
  g.fillStyle=grd;g.fillRect(0,0,64,64);
  sprites[color]=c;return c;
}
function drawOne(d){
  var cv=$('cv-'+d.cid), wrap=cv.parentNode, tip=$('tip-'+d.cid);
  if(!cv)return;
  var dpr=window.devicePixelRatio||1;
  var w=Math.max(300,wrap.clientWidth-2);
  var h=Math.max(300,Math.min(470,Math.round(w*0.55)));
  cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);
  cv.style.height=h+'px';
  var ctx=cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  var list=seriesOf(d.id);
  $('mt-'+d.cid).textContent=list.length?('· '+list.length+' 名玩家'):'· 暂无数据';
  if(!list.length){
    TRANS[d.id]=null;
    ctx.fillStyle='#8a919f';ctx.font='14px sans-serif';ctx.textAlign='center';
    ctx.fillText(DATA?'这个维度暂时没有采样数据':'还没有数据',w/2,h/2);
    return;
  }
  var minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  list.forEach(function(p){(p.pts||[]).forEach(function(pt){
    if(pt[0]<minX)minX=pt[0];if(pt[0]>maxX)maxX=pt[0];
    if(pt[1]<minZ)minZ=pt[1];if(pt[1]>maxZ)maxZ=pt[1];
  })});
  if(!isFinite(minX)){minX=0;maxX=128;minZ=0;maxZ=128}
  var view=VIEW[d.id];
  if(view){
    minX=view.x-view.span/2;maxX=view.x+view.span/2;
    minZ=view.z-view.span/2;maxZ=view.z+view.span/2;
  }else{
    var spanX=Math.max(128,maxX-minX), spanZ=Math.max(128,maxZ-minZ), span=Math.max(spanX,spanZ);
    var pad=Math.max(48,span*0.08);
    var cx=(minX+maxX)/2, cz=(minZ+maxZ)/2, half=span/2+pad;
    minX=cx-half;maxX=cx+half;minZ=cz-half;maxZ=cz+half;
  }
  var sx=w/(maxX-minX), sz=h/(maxZ-minZ);
  TRANS[d.id]={minX:minX,minZ:minZ,sx:sx,sz:sz,w:w,h:h};
  function px(x){return (x-minX)*sx}
  function pz(z){return (z-minZ)*sz}

  var steps=[16,32,64,128,256,512,1024,2048,4096,8192,16384];
  var step=steps[steps.length-1];
  for(var i=0;i<steps.length;i++){if((maxX-minX)/steps[i]<=14){step=steps[i];break}}
  ctx.strokeStyle='#e8ecf2';ctx.fillStyle='#a8b0bd';ctx.lineWidth=1;ctx.font='10px sans-serif';
  ctx.textAlign='center';ctx.textBaseline='top';
  for(var gx=Math.ceil(minX/step)*step;gx<=maxX;gx+=step){
    var X=px(gx);ctx.beginPath();ctx.moveTo(X,0);ctx.lineTo(X,h);ctx.stroke();
    ctx.fillText(String(Math.round(gx)),X,4);
  }
  ctx.textAlign='left';ctx.textBaseline='middle';
  for(var gz=Math.ceil(minZ/step)*step;gz<=maxZ;gz+=step){
    var Z=pz(gz);ctx.beginPath();ctx.moveTo(0,Z);ctx.lineTo(w,Z);ctx.stroke();
    ctx.fillText(String(Math.round(gz)),4,Z);
  }
  ctx.strokeStyle='#d9dee8';ctx.strokeRect(0.5,0.5,w-1,h-1);

  var R=Math.max(12,Math.min(w,h)*0.05);
  ctx.save();
  ctx.globalCompositeOperation='lighter';
  list.forEach(function(p){
    var sp=sprite(colorFor(p.name));
    ctx.globalAlpha=p.mapped?0.07:0.10;
    (p.pts||[]).forEach(function(pt){
      ctx.drawImage(sp,px(pt[0])-R,pz(pt[1])-R,R*2,R*2);
    });
  });
  ctx.restore();

  // 当前位置标点：己维度用圆点，映射过来的用菱形
  ctx.font='12px sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
  list.forEach(function(p){
    if(!p.last)return;
    var color=colorFor(p.name), X=px(p.last.x), Z=pz(p.last.z);
    ctx.beginPath();
    if(p.mapped){
      ctx.moveTo(X,Z-5);ctx.lineTo(X+5,Z);ctx.lineTo(X,Z+5);ctx.lineTo(X-5,Z);ctx.closePath();
    }else{
      ctx.arc(X,Z,5.5,0,Math.PI*2);
    }
    ctx.fillStyle=color;ctx.fill();
    ctx.lineWidth=2;ctx.strokeStyle='#fff';ctx.stroke();
    var label=p.name+(p.mapped?(d.id==='minecraft:overworld'?' ×8':' ÷8'):'');
    ctx.lineWidth=3;ctx.strokeStyle='rgba(255,255,255,.85)';ctx.strokeText(label,X+9,Z);
    ctx.fillStyle='#1f2329';ctx.fillText(label,X+9,Z);
  });

  // 鼠标位置显示世界坐标
  cv.onmousemove=function(e){
    var t=TRANS[d.id];if(!t)return;
    var mx=e.offsetX, mz=e.offsetY;
    var wx=t.minX+mx/t.sx, wz=t.minZ+mz/t.sz;
    tip.style.display='block';
    tip.textContent='X '+Math.round(wx)+'   Z '+Math.round(wz);
    var left=mx+14, top=mz+14;
    if(left+tip.offsetWidth>t.w-4)left=Math.max(4,mx-tip.offsetWidth-10);
    if(top+tip.offsetHeight>t.h-4)top=Math.max(4,mz-tip.offsetHeight-10);
    tip.style.left=left+'px';tip.style.top=top+'px';
  };
  cv.onmouseleave=function(){tip.style.display='none'};
}
function drawAll(){DIMS.forEach(drawOne)}
function renderLegend(){
  var seen={}, list=[];
  (DATA&&DATA.players||[]).forEach(function(p){
    var k=p.name+'|'+p.dim;
    if(seen[k])return;seen[k]=1;list.push(p);
  });
  if(!list.length){$('legend').innerHTML='<span class="hint">还没有数据</span>';return;}
  $('legend').innerHTML=list.map(function(p){
    var k=p.name+'|'+p.dim, off=!!HIDDEN[k];
    return '<span class="chip'+(off?' off':'')+'" data-k="'+esc(k)+'">'
      +'<span class="dot" style="background:'+colorFor(p.name)+'"></span>'+esc(p.name)
      +' <span class="meta">'+esc(dimName(p.dim))+' · '+(p.pts||[]).length+' 点</span>'
      +'<a href="#" class="find" data-find="'+esc(k)+'">定位</a></span>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('#legend [data-k]'),function(el){
    el.onclick=function(ev){
      if(ev.target&&ev.target.dataset&&ev.target.dataset.find)return;
      var k=el.dataset.k;
      if(HIDDEN[k])delete HIDDEN[k];else HIDDEN[k]=1;
      drawAll();renderLegend();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('#legend [data-find]'),function(a){
    a.onclick=function(ev){
      ev.preventDefault();ev.stopPropagation();
      var k=a.dataset.find, i=k.lastIndexOf('|');
      var dim=k.slice(i+1);
      var p=((DATA&&DATA.players)||[]).filter(function(x){return x.name+'|'+x.dim===k})[0];
      if(!p||!p.last)return;
      VIEW[dim]={x:p.last.x,z:p.last.z,span:256};
      drawOne(DIMS.filter(function(d){return d.id===dim})[0]||DIMS[0]);
    };
  });
}
function dimName(d){
  return ({'minecraft:overworld':'主世界','minecraft:the_nether':'下界','minecraft:the_end':'末地'})[d]||d||'未知维度';
}
function load(){
  $('err').textContent='';
  get('/api/heatmap',function(st,j){
    if(st===401){location.href='/login';return}
    if(!j.ok){$('err').textContent=j.error||'加载失败';return}
    DATA=j;
    var d=new Date();
    $('meta').textContent='采样间隔 '+(j.sampleSec||'?')+' 秒 · 保留 '+(j.retainMin||'?')+' 分钟 · 更新 '
      +('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2);
    drawAll();renderLegend();
  });
}
$('refresh').onclick=load;
$('mapNether').onchange=function(){MAPON=$('mapNether').checked;drawAll()};
$('auto').onchange=function(){
  if(timer){clearInterval(timer);timer=null}
  if($('auto').checked)timer=setInterval(load,15000);
};
Array.prototype.forEach.call(document.querySelectorAll('[data-reset]'),function(b){
  b.onclick=function(){
    VIEW[b.dataset.reset]=null;
    drawOne(DIMS.filter(function(d){return d.id===b.dataset.reset})[0]||DIMS[0]);
  };
});
window.addEventListener('resize',function(){if(DATA)drawAll()});
load();
if($('auto').checked)timer=setInterval(load,15000);
</script></body></html>`;
}

// ---------- 健康检查（免鉴权） ----------
// 只暴露「能不能用」的布尔量与版本无关的计数，**不含**密钥 / URL / QQ 号 / 群号。
const HEALTH_AI_TTL = 60 * 1000; // AI 可达性探测结果缓存 60 秒，避免每次探活都打真实请求
let healthAiCache = { at: 0, reachable: false };

/** 轻量探测 AI 服务商是否可达：只要求「对方有 HTTP 响应」就算通（401 也算，说明网络与接口在） */
async function probeAiReachable() {
  if (Date.now() - healthAiCache.at < HEALTH_AI_TTL) return healthAiCache.reachable;
  let reachable = false;
  try {
    const endpoint = balanceEndpoint() || getProviderInfo().url;
    if (endpoint) {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      reachable = !!res && res.status > 0;
    }
  } catch {
    reachable = false;
  }
  healthAiCache = { at: Date.now(), reachable };
  return reachable;
}

async function handleHealth(res) {
  const botConnected = !!bot.connected;
  const bt = getBridgeTarget();
  const mcConfigured = isMcConfigured();
  const mcConnected = mcConfigured ? isMcConnected() : false;
  const aiEnabled = isAiEnabled();
  const aiReachable = aiEnabled ? await probeAiReachable() : false;

  const body = {
    status: botConnected && (!mcConfigured || mcConnected) ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    bot: { connected: botConnected },
    mcBridge: { configured: mcConfigured, connected: mcConnected, mode: bt.mode, base: bt.base },
    ai: { enabled: aiEnabled, reachable: aiReachable },
    timestamp: new Date().toISOString(),
  };
  sendJSON(res, body.status === 'ok' ? 200 : 503, body);
}

// ---------- 会话列表：所有群聊 + 所有好友（主人默认置顶） ----------
// 群/好友名单从 SnowLuma 拉取（get_group_list / get_friend_list），缓存 60 秒避免频繁请求。
const convCache = { at: 0, groups: [], friends: [], ok: false };
const CONV_CACHE_MS = 60 * 1000;

async function fetchGroupsAndFriends() {
  if (Date.now() - convCache.at < CONV_CACHE_MS) return convCache;
  const call = getSendMsg(); // 由 index.js 注入：OneBot 的 callApi
  if (!call) return convCache;
  try {
    const [gs, fs] = await Promise.all([
      call('get_group_list', {}).catch(() => []),
      call('get_friend_list', {}).catch(() => []),
    ]);
    convCache.groups = (Array.isArray(gs) ? gs : []).map((g) => ({
      key: 'g:' + String(g.group_id),
      id: String(g.group_id),
      name: g.group_name || String(g.group_id),
    }));
    convCache.friends = (Array.isArray(fs) ? fs : []).map((f) => ({
      key: 'p:' + String(f.user_id),
      id: String(f.user_id),
      name: f.remark || f.nickname || String(f.user_id),
    }));
    convCache.at = Date.now();
    convCache.ok = true;
  } catch (e) {
    logger.warn('[面板] 获取群/好友列表失败：' + e.message);
  }
  return convCache;
}

/** 组装会话列表：群聊 + 好友，附加置顶状态与已覆盖项数；主人私聊默认置顶 */
async function listConversations() {
  const owner = String(perm.getOwner() || '');
  const pinnedMap = {};
  for (const k of chatCfg.pinnedKeys()) pinnedMap[k] = true;
  // 显式取消置顶（pin === false）也记下，避免主人会话被默认置顶规则又拉上去
  const over = chatCfg.allOverrides();
  const explicitOff = {};
  for (const k of Object.keys(over)) if (over[k] && over[k].pin === false) explicitOff[k] = true;

  const effPinned = (k) => (pinnedMap[k] ? true : (owner && k === 'p:' + owner && !explicitOff[k]));
  const coverCount = (k) => Object.keys(over[k] || {}).filter((f) => f !== 'pin').length;

  const fx = await fetchGroupsAndFriends();
  const seen = new Set();
  const groups = [];
  const friends = [];
  for (const g of fx.groups) {
    if (seen.has(g.key)) continue;
    seen.add(g.key);
    groups.push({ ...g, pinned: !!effPinned(g.key), overrides: coverCount(g.key) });
  }
  for (const f of fx.friends) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    friends.push({ ...f, pinned: !!effPinned(f.key), overrides: coverCount(f.key) });
  }
  // 补充"收到过消息但不在名单里"的会话（如已退群/未加好友），避免它们从列表消失
  for (const k of chatCfg.listKeys()) {
    if (seen.has(k)) continue;
    if (k.startsWith('g:')) groups.push({ key: k, id: k.slice(2), name: k.slice(2) + '（不在群列表）', pinned: !!effPinned(k), overrides: coverCount(k) });
    else friends.push({ key: k, id: k.slice(2), name: k.slice(2) + '（非好友）', pinned: !!effPinned(k), overrides: coverCount(k) });
  }
  // 置顶的排最前，其余按名称排序
  const sortFn = (a, b) => (Number(b.pinned) - Number(a.pinned)) || a.name.localeCompare(b.name, 'zh-CN');
  groups.sort(sortFn);
  friends.sort(sortFn);
  return { owner, listOk: fx.ok, groups, friends, pinned: chatCfg.pinnedKeys() };
}

// ---------- 路由 ----------
async function route(req, res, url) {
  sweepAuth();

  // 健康检查：放在一切鉴权之前（探活工具不该需要登录），且不返回任何敏感信息
  if (url.pathname === '/health') return handleHealth(res);

  // 主页：未登录给空白主页（只有右上角登录入口），登录后才给控制面板
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const s = sessionOf(req);
    // 非所有者不配进管理面板：管理员去 /admin，普通玩家去「我的账号」
    if (s && s.role !== 'owner') {
      res.writeHead(302, { Location: canAdmin(s.role) ? '/admin' : '/me', 'Cache-Control': 'no-store' });
      return res.end();
    }
    const file = s ? WEB_DIR : HOME_FILE;
    if (!fs.existsSync(file)) return sendJSON(res, 500, { error: `缺少 ${path.relative(ROOT, file)}` });
    const html = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // 我的账号：非所有者登录后的唯一入口
  if (url.pathname === '/me' || url.pathname === '/me.html') {
    const s = sessionOf(req);
    if (!s) {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendHtml(res, 200, mePage(s));
  }

  // 管理子页：主人 / 管理员管理所有人的账户与游戏绑定
  if (url.pathname === '/admin' || url.pathname === '/admin.html') {
    const s = sessionOf(req);
    if (!s) {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!canAdmin(s.role)) {
      res.writeHead(302, { Location: '/me', 'Cache-Control': 'no-store' });
      return res.end();
    }
    // 所有者直接用主面板里的「账户管理」内嵌页，不再单独开一个页面
    if (s.role === 'owner') {
      res.writeHead(302, { Location: '/#accounts', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendHtml(res, 200, adminPage(s));
  }

  // 位置热力图：全服玩家最近的活动位置（所有者/主人/管理员）
  if (url.pathname === '/heatmap' || url.pathname === '/heatmap.html') {
    const s = sessionOf(req);
    if (!s) {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!canAdmin(s.role)) {
      res.writeHead(302, { Location: '/me', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendHtml(res, 200, heatmapPage(s));
  }

  // 登录页单独一个地址；已登录访问时直接回对应首页
  if (url.pathname === '/login' || url.pathname === '/login.html') {
    const s = sessionOf(req);
    if (s) {
      res.writeHead(302, { Location: s.role === 'owner' ? '/' : (canAdmin(s.role) ? '/admin' : '/me'), 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendHtml(res, 200, loginPage('', captchaNeeded(clientIp(req))));
  }

  // 原来的私聊试用入口 → 网页 QQ 客户端
  if (url.pathname === '/trial' || url.pathname === '/trial.html') {
    res.writeHead(302, { Location: '/qq', 'Cache-Control': 'no-store' });
    return res.end();
  }

  // 网页 QQ 客户端：必须登录，未登录先去登录页
  if (url.pathname === '/qq' || url.pathname === '/qq.html') {
    const s = sessionOf(req);
    if (!s) {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (s.role !== 'owner') {
      res.writeHead(302, { Location: '/me', 'Cache-Control': 'no-store' });
      return res.end();
    }
    const qq = path.join(path.dirname(WEB_DIR), 'qq.html');
    if (!fs.existsSync(qq)) return sendJSON(res, 500, { error: '缺少 web/qq.html' });
    return sendHtml(res, 200, fs.readFileSync(qq));
  }

  // 网页 QQ（Stapxs QQ Lite 原版）：/ssqq 是入口，它引用 /Stapxs-QQ-Lite-2.0/... 的绝对资源路径
  // 它拿到的是机器人 QQ 的完整 OneBot 权限，只给所有者
  if (url.pathname === '/ssqq' || url.pathname === '/ssqq/'
    || url.pathname.startsWith(SSQQ_PREFIX) || url.pathname.startsWith('/ssqq/')) {
    const s = sessionOf(req);
    if (!s) {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (s.role !== 'owner') {
      res.writeHead(302, { Location: '/me', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (url.pathname === '/ssqq' || url.pathname === '/ssqq/') {
      const idx = path.join(SSQQ_DIR, 'index.html');
      if (!fs.existsSync(idx)) {
        return sendJSON(res, 500, { error: '缺少 web/ssqq（Stapxs QQ Lite 静态资源）' });
      }
      return sendHtml(res, 200, fs.readFileSync(idx));
    }
    return serveSsqqFile(res, url.pathname);
  }

  // 老旧浏览器兼容页（纯 ES5 + XHR，只保留状态 / 登录 / 试用）
  if (url.pathname === '/legacy' || url.pathname === '/legacy.html') {
    const s = sessionOf(req);
    if (s && s.role !== 'owner') {
      res.writeHead(302, { Location: '/me', 'Cache-Control': 'no-store' });
      return res.end();
    }
    const legacy = path.join(path.dirname(WEB_DIR), 'legacy.html');
    if (!fs.existsSync(legacy)) return sendJSON(res, 500, { error: '缺少 web/legacy.html' });
    return sendHtml(res, 200, fs.readFileSync(legacy));
  }

  // 人机验证：发图 + 记下答案（按预登录 id 绑定，换一张即作废旧的）
  if (url.pathname === '/api/captcha') {
    const ck = parseCookies(req);
    let pid = ck.xn_pre;
    if (!/^[0-9a-f]{32}$/.test(pid || '')) pid = crypto.randomBytes(16).toString('hex');
    const answer = String(Math.floor(1000 + Math.random() * 9000));
    preAuth.set(pid, { answer, exp: Date.now() + CAPTCHA_TTL });
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Set-Cookie': `xn_pre=${pid}; Path=/; HttpOnly; SameSite=Lax${cookieSecure()}; Max-Age=${CAPTCHA_TTL / 1000}`,
    });
    return res.end(renderCaptcha(answer));
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const f = failLog.get(ip);
    if (f && f.until && Date.now() < f.until) {
      const min = Math.ceil((f.until - Date.now()) / 60000);
      return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${min} 分钟后再试` });
    }
    const body = await readBody(req);
    const qq = String(body.qq || '').trim();
    const pass = String(body.pass || '');

    // 人机验证「按需」要求：只有当这个 IP 已连续输错到阈值时才校验验证码；
    // 平时只需账号密码，不给正常登录加负担。
    const requiresCaptcha = (f && f.n ? f.n : 0) >= CAPTCHA_AFTER_FAILS;

    let bad = '';
    if (requiresCaptcha) {
      const pid = parseCookies(req).xn_pre || '';
      const p = preAuth.get(pid);
      preAuth.delete(pid);      // 验证码一次性，无论对错都用掉
      if (!p || Date.now() > p.exp) bad = '验证码已过期，请重新输入';
      else if (String(body.captcha || '').trim() !== p.answer) bad = '验证码不对';
    }
    if (!bad && !/^\d{5,14}$/.test(qq)) bad = '请输入 QQ 号';
    if (!bad) {
      const isOwner = qq === String(process.env.BOT_OWNER || '').trim();
      if (isOwner) {
        // 所有者：网页改过密码就认账号密码，否则沿用 .env 的 WEBUI_PASSWORD
        const ok = hasPassword(qq) ? verifyPassword(qq, pass) : (PANEL_PASS ? safeEq(pass, PANEL_PASS) : false);
        if (!ok) bad = 'QQ 号或密码不对';
      } else {
        const gate = await groupMember(qq);
        if (!gate.ok) {
          bad = gate.error || '只有在小钠的群里才能登录面板';
        } else if (!canLoginByCode(qq)) {
          bad = '该 QQ 没有绑定游戏ID，不能登录面板';
        } else if (!hasPassword(qq)) {
          bad = '该 QQ 还没设置密码，请用「验证码登录」';
        } else if (!verifyPassword(qq, pass)) {
          bad = 'QQ 号或密码不对';
        }
      }
    }

    if (bad) {
      const n = ((f && f.n) || 0) + 1;
      failLog.set(ip, { n, until: n >= LOGIN_MAX_FAIL ? Date.now() + LOGIN_BLOCK_MS : 0 });
      logger.info(`🔒 面板登录失败（${ip}）: ${bad}（连续第 ${n} 次）`);
      return sendJSON(res, 401, {
        ok: false,
        // 达到阈值后让前端把验证码框露出来，用户下一次提交就得带上验证码
        captchaRequired: n >= CAPTCHA_AFTER_FAILS,
        error: bad + (n >= LOGIN_MAX_FAIL ? `，已锁定 ${LOGIN_BLOCK_MS / 60000} 分钟` : ''),
      });
    }

    failLog.delete(ip);
    const s = startSession(res, qq, ip);
    return sendJSON(res, s.status, s.body);
  }

  // 发送 QQ 验证码（登录用，bot 私聊发送）
  if (url.pathname === '/api/login/send-code' && req.method === 'POST') {
    const body = await readBody(req);
    const qq = String(body.qq || '').trim();
    if (!/^\d{5,14}$/.test(qq)) return sendJSON(res, 400, { ok: false, error: '请输入 QQ 号' });
    if (!canLoginByCode(qq)) return sendJSON(res, 403, { ok: false, error: '该 QQ 没有绑定游戏ID，不能登录面板' });
    const gate = await groupMember(qq);
    if (!gate.ok) return sendJSON(res, 403, { ok: false, error: gate.error || '只有在小钠的群里才能登录面板' });
    const now = Date.now();
    const rec = codeSendLog.get(qq);
    if (rec && now - rec.at < QQ_CODE_SEND_GAP) {
      return sendJSON(res, 429, { ok: false, error: `发送太频繁，请 ${Math.ceil((QQ_CODE_SEND_GAP - (now - rec.at)) / 1000)} 秒后再试` });
    }
    const hourN = rec && now - rec.hourAt < 3600000 ? rec.hourN + 1 : 1;
    if (hourN > QQ_CODE_MAX_PER_HOUR) return sendJSON(res, 429, { ok: false, error: '这个 QQ 一小时最多发 5 次验证码' });
    const call = getSendMsg();
    if (!call) return sendJSON(res, 503, { ok: false, error: '机器人还没连上 QQ，发不了验证码' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    try {
      await call('send_private_msg', { user_id: Number(qq), message: `【小钠面板】登录验证码：${code}（5 分钟内有效）。不是你本人操作请忽略，别把验证码发给任何人。` });
    } catch (e) {
      logger.warn(`[面板] 给 QQ ${qq} 发验证码失败：${e && e.message ? e.message : e}`);
      return sendJSON(res, 502, { ok: false, error: '验证码发送失败（对方可能没加机器人好友）' });
    }
    loginCodes.set(qq, { code, exp: now + QQ_CODE_TTL, tries: 0 });
    codeSendLog.set(qq, { at: now, hourAt: rec && now - rec.hourAt < 3600000 ? rec.hourAt : now, hourN });
    logger.info(`[面板] 已给 QQ ${qq} 发送登录验证码`);
    return sendJSON(res, 200, { ok: true, ttl: QQ_CODE_TTL / 1000 });
  }

  // 用 QQ 验证码登录（首次登录后引导设置密码）
  if (url.pathname === '/api/login/code' && req.method === 'POST') {
    const body = await readBody(req);
    const qq = String(body.qq || '').trim();
    const code = String(body.code || '').trim();
    if (!/^\d{5,14}$/.test(qq)) return sendJSON(res, 400, { ok: false, error: '请输入 QQ 号' });
    if (!canLoginByCode(qq)) return sendJSON(res, 403, { ok: false, error: '该 QQ 没有绑定游戏ID，不能登录面板' });
    const gate = await groupMember(qq);
    if (!gate.ok) return sendJSON(res, 403, { ok: false, error: gate.error || '只有在小钠的群里才能登录面板' });
    const c = loginCodes.get(qq);
    if (!c || Date.now() > c.exp) return sendJSON(res, 401, { ok: false, error: '验证码已过期，请重新发送' });
    if (c.tries >= QQ_CODE_MAX_TRIES) { loginCodes.delete(qq); return sendJSON(res, 401, { ok: false, error: '验证码错太多次，请重新发送' }); }
    if (!safeEq(code, c.code)) {
      c.tries += 1;
      return sendJSON(res, 401, { ok: false, error: `验证码不对（还能试 ${QQ_CODE_MAX_TRIES - c.tries} 次）` });
    }
    loginCodes.delete(qq);
    const needSetPassword = !hasPassword(qq);
    const r = startSession(res, qq, clientIp(req), true);
    return sendJSON(res, r.status, { ...r.body, needSetPassword });
  }

  if (url.pathname === '/api/logout') {
    const token = parseCookies(req).xn_sess;
    if (token && sessions.delete(token)) saveSessions();
    // 退出登录也丢弃**本客户端**的试用会话（不落盘），并清掉试用客户端 Cookie
    if (trialReset) trialReset(parseCookies(req)[TRIAL_COOKIE]);
    res.setHeader('Set-Cookie', [
      `xn_sess=; Path=/; HttpOnly${cookieSecure()}; Max-Age=0`,
      `${TRIAL_COOKIE}=; Path=/; HttpOnly${cookieSecure()}; Max-Age=0`,
    ]);
    return sendJSON(res, 200, { ok: true });
  }

  // 网页直聊（原「私聊试用」）：必须登录，按所有者身份跑；不经过 QQ
  if (url.pathname === '/api/trial/chat' && req.method === 'POST') {
    const sess = sessionOf(req);
    if (!sess) return sendJSON(res, 401, { ok: false, error: '请先登录', login: true });
    if (sess.role !== 'owner') return sendJSON(res, 403, { ok: false, error: '只有所有者可以使用网页直聊' });
    if (!trialChat) return sendJSON(res, 503, { ok: false, error: '聊天未就绪（机器人还没起来）' });
    const cid = trialClientId(req, res);   // 每个浏览器一份内存历史，互不串
    const body = await readBody(req);
    let t = String(body.text || '').trim();
    const isVoice = !t && !!body.audio;
    if (isVoice) {
      // 浏览器录的是 16k 单声道 WAV（前端已重采样），直接落临时文件交给 FunASR
      const buf = Buffer.from(String(body.audio), 'base64');
      if (!buf.length) return sendJSON(res, 400, { ok: false, error: '语音内容为空' });
      if (buf.length > 12 * 1024 * 1024) return sendJSON(res, 400, { ok: false, error: '录音太长了（最多 60 秒）' });
      const fmt = /^(wav|mp3|ogg|webm|m4a)$/i.test(String(body.format || '')) ? String(body.format).toLowerCase() : 'wav';
      const tmp = path.join(os.tmpdir(), `xn-trial-${crypto.randomBytes(6).toString('hex')}.${fmt}`);
      fs.writeFileSync(tmp, buf);
      try {
        t = String((await transcribe({ path: tmp, format: fmt })) || '').trim();
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉就算了 */ }
      }
      if (!t) return sendJSON(res, 400, { ok: false, error: '语音没听清，再说一遍？' });
    }
    if (!t) return sendJSON(res, 400, { ok: false, error: '内容为空' });
    if (t.length > 500) return sendJSON(res, 400, { ok: false, error: '太长了（最多 500 字）' });
    try {
      const result = await trialChat(cid, t, { owner: true });
      const reply = typeof result === 'string' ? result : String((result && result.reply) || '');
      const voices = (result && Array.isArray(result.voices)) ? result.voices : [];
      if (!reply && !voices.length) return sendJSON(res, 502, { ok: false, error: '小钠没有返回内容' });
      return sendJSON(res, 200, { ok: true, reply, heard: isVoice ? t : '', voices });
    } catch (e) {
      // 把失败原因原样带回前端展示（如「AI 请求失败 (401)：...」「AI 超时」）
      const reason = String((e && e.message) || e || '未知错误');
      logger.warn(`[网页直聊] 这轮没回成：${reason}`);
      return sendJSON(res, 502, { ok: false, error: reason });
    }
  }

  // 直聊会话不落盘：浏览器关闭时前端用 beacon 打到这，丢弃本客户端的内存历史
  if (url.pathname === '/api/trial/reset' && req.method === 'POST') {
    const sess = sessionOf(req);
    if (!sess) return sendJSON(res, 401, { ok: false, error: '未登录', login: true });
    if (sess.role !== 'owner') return sendJSON(res, 403, { ok: false, error: '只有所有者可以使用网页直聊' });
    if (trialReset) trialReset(trialClientId(req, res));
    return sendJSON(res, 200, { ok: true });
  }

  // 当前登录身份（前端据此决定进管理面板还是「我的账号」）
  if (url.pathname === '/api/session' && req.method === 'GET') {
    const s = sessionOf(req);
    if (!s) return sendJSON(res, 401, { ok: false, error: '未登录', login: true });
    return sendJSON(res, 200, { ok: true, qq: s.qq, role: s.role, viaCode: s.code, hasPassword: hasPassword(s.qq) });
  }

  if (!url.pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });

  // 其余所有接口一律要求登录（含日志、授权列表、接管）
  const sess = sessionOf(req);
  if (!sess) return sendJSON(res, 401, { ok: false, error: '未登录', login: true });
  // 权限隔离：只有所有者能碰全部管理接口；主人/管理员额外可用 /api/admin/*，其他人只能用自己的 /api/me/*
  const adminApi = url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/');
  const heatApi = url.pathname === '/api/heatmap';
  if (sess.role !== 'owner'
    && !url.pathname.startsWith('/api/me')
    && !((adminApi || heatApi) && canAdmin(sess.role))) {
    return sendJSON(res, 403, { ok: false, error: '没有管理权限' });
  }

  // ---------- 我的账号（所有登录用户）：管理自己的游戏绑定 / 改密码 ----------
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const ids = getGameIdsOf(sess.qq).map((id) => ({ id, qq: sess.qq }));
    return sendJSON(res, 200, {
      ok: true, qq: sess.qq, role: sess.role, viaCode: sess.code,
      hasPassword: hasPassword(sess.qq), bindings: ids,
    });
  }
  if (url.pathname === '/api/me/unbind' && req.method === 'POST') {
    const b = await readBody(req);
    const gameId = String(b.gameId || '').trim();
    if (!gameId) return sendJSON(res, 400, { ok: false, error: '请选择要解绑的游戏ID' });
    const r = unbindSelf(sess.qq, gameId);
    if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
    logger.info(`[面板] QQ ${sess.qq} 自助解绑游戏ID ${gameId}`);
    return sendJSON(res, 200, { ok: true, msg: r.msg });
  }
  if (url.pathname === '/api/me/bind/start' && req.method === 'POST') {
    const b = await readBody(req);
    const r = startBind(sess.qq, String(b.gameId || '').trim());
    if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
    // startBind 返回的是 PNG Buffer，转成 data URL 给网页显示
    const img = Buffer.isBuffer(r.image) ? 'data:image/png;base64,' + r.image.toString('base64') : String(r.image || '');
    return sendJSON(res, 200, { ok: true, image: img, gameId: r.gameId, ttlSec: r.ttlSec });
  }
  if (url.pathname === '/api/me/bind/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const ans = String(b.code || '').trim();
    const r = answerCaptcha(sess.qq, ans);
    if (!r.handled) return sendJSON(res, 400, { ok: false, error: '没有待验证的绑定，请先点「发送验证」' });
    if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.msg || '验证失败' });
    logger.info(`[面板] QQ ${sess.qq} 自助绑定成功：${r.msg || ''}`);
    return sendJSON(res, 200, { ok: true, msg: r.msg || '绑定成功' });
  }
  if (url.pathname === '/api/me/password' && req.method === 'POST') {
    const b = await readBody(req);
    const oldPass = String(b.oldPass || '');
    const newPass = String(b.newPass || '');
    // 按 Unicode 字符计数：中文/emoji 都算一位（长度按码点，不按 UTF-16 单元）
    const passLen = [...newPass].length;
    if (passLen < 6 || passLen > 64) return sendJSON(res, 400, { ok: false, error: '新密码长度 6-64 位（支持中文）' });
    // 验证码登录的会话本身就证明了 QQ 归属，允许不输原密码直接重设（忘记密码的恢复路径）
    if (hasPassword(sess.qq) && !sess.code && !verifyPassword(sess.qq, oldPass)) {
      return sendJSON(res, 400, { ok: false, error: '原密码不对' });
    }
    if (!setPassword(sess.qq, newPass)) return sendJSON(res, 500, { ok: false, error: '保存失败' });
    logger.info(`[面板] QQ ${sess.qq} 已修改网页密码`);
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- 位置热力图数据（所有者/主人/管理员） ----------
  if (heatApi && req.method === 'GET') {
    if (!isMcConnected()) return sendJSON(res, 200, { ok: false, error: 'MC 服务器还没连上桥' });
    try {
      const d = await getPlayerPositions();
      return sendJSON(res, 200, { ok: true, ...d });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const old = /404|not\s*found/i.test(msg);
      return sendJSON(res, 502, {
        ok: false,
        error: old
          ? '服务器 mod 版本过旧（需要 2.11.0），请先把新版 mod 放到 MC 服务器'
          : `读取位置失败：${msg}`,
      });
    }
  }

  // ---------- 管理子页：管理所有人的账户与绑定（所有者/主人/管理员） ----------
  if (adminApi) {
    if (!canAdmin(sess.role)) return sendJSON(res, 403, { ok: false, error: '没有管理权限' });

    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      const ov = bindingOverview();
      const map = new Map();
      const add = (qq) => {
        const k = String(qq || '').trim();
        if (!/^\d{5,14}$/.test(k)) return null;
        if (!map.has(k)) {
          map.set(k, {
            qq: k, ids: [], role: perm.role(k), banned: false, banReason: '', hasPassword: hasPassword(k),
          });
        }
        return map.get(k);
      };
      for (const b of ov.bound) {
        const u = add(b.qq);
        if (u) { u.ids = b.ids.slice(); u.banned = !!b.banned; u.banReason = b.banReason || ''; }
      }
      for (const b of ov.bans) {
        const u = add(b.qq);
        if (u) { u.banned = true; u.banReason = b.reason || ''; }
      }
      for (const q of listAccounts()) add(q);
      for (const q of [perm.getMaster2(), ...perm.listExtraOwners(), ...perm.listExtraAdmins(), ...perm.listAuthorized()]) add(q);
      const ROLE_NAME = { owner: '所有者', master: '主人', admin: '管理员', authorized: '授权用户', guest: '普通用户' };
      const RANK = { owner: 0, master: 1, admin: 2, authorized: 3, guest: 4 };
      const users = [...map.values()]
        .map((u) => ({ ...u, roleName: ROLE_NAME[u.role] || u.role }))
        .sort((a, b) => (RANK[a.role] - RANK[b.role]) || a.qq.localeCompare(b.qq));
      return sendJSON(res, 200, { ok: true, group: BRIDGE_GROUP, users, maxPerQQ: ov.maxPerQQ });
    }

    if (url.pathname === '/api/admin/bind' && req.method === 'POST') {
      const b = await readBody(req);
      const target = String(b.qq || '').trim();
      const gameId = String(b.gameId || '').trim();
      const r = forceBind(target, gameId);
      if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
      logger.info(`[面板] ${sess.qq}(${sess.role}) 给 QQ ${target} 绑定游戏ID ${gameId}`);
      return sendJSON(res, 200, { ok: true, ids: r.ids });
    }

    if (url.pathname === '/api/admin/unbind' && req.method === 'POST') {
      const b = await readBody(req);
      const target = String(b.qq || '').trim();
      const gameId = String(b.gameId || '').trim();
      const r = forceUnbind(target, gameId);
      if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
      logger.info(`[面板] ${sess.qq}(${sess.role}) 解绑 QQ ${target} 的游戏ID ${gameId}`);
      return sendJSON(res, 200, { ok: true, ids: r.ids });
    }

    if (url.pathname === '/api/admin/password/clear' && req.method === 'POST') {
      const b = await readBody(req);
      const target = String(b.qq || '').trim();
      if (!/^\d{5,14}$/.test(target)) return sendJSON(res, 400, { ok: false, error: 'QQ 号格式不对' });
      if (target === String(process.env.BOT_OWNER || '').trim()) {
        return sendJSON(res, 403, { ok: false, error: '所有者的密码不能在这里清除' });
      }
      if (!deletePassword(target)) return sendJSON(res, 404, { ok: false, error: '该 QQ 没设置网页密码' });
      logger.info(`[面板] ${sess.qq}(${sess.role}) 清除了 QQ ${target} 的网页密码`);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { ok: false, error: 'api not found' });
  }

  if (url.pathname === '/api/status') {
    const ls = await connectionStatus();
    const bt = getBridgeTarget();
    return sendJSON(res, 200, {
      serviceUp: true,
      model: process.env.AI_MODEL || 'deepseek-flash',
      webuiPort,
      owner: perm.getOwner(),
      // 联网搜索 / 图像识别 / MC 桥：让状态页看得见当前切在哪个后端
      search: { enabled: isSearchEnabled(), provider: searchSettings().provider },
      vision: { provider: String(((config() && config().vision) || {}).provider || 'ai') },
      mcBridge: { mode: bt.mode, base: bt.base, connected: isMcConnected() },
      ...ls,
    });
  }

  // 终端实时日志（与终端输出一致）
  if (url.pathname === '/api/logs') {
    return sendJSON(res, 200, { logs: logs.slice(-200) });
  }

  // 功能列表：直接复用 #帮助 的命令表（help.js 是唯一数据源，避免网页与 QQ 菜单说法不一致）
  if (url.pathname === '/api/features') {
    return sendJSON(res, 200, { commands: HELP_CMDS, tiers: TIERS });
  }

  if (url.pathname === '/api/perms') {
    const master2 = perm.getMaster2();
    const extraOwners = perm.listExtraOwners();
    return sendJSON(res, 200, {
      owner: perm.getOwner(),
      master2,
      masters: [master2, ...extraOwners].filter(Boolean),
      extraOwners,
      admins: [
        ...(process.env.BOT_ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean),
        ...perm.listExtraAdmins(),
      ],
      authorized: perm.listAuthorized(),
      pending: perm.listPending(),
    });
  }

  if (url.pathname === '/api/perm/request' && req.method === 'POST') {
    const { qq } = await readBody(req);
    if (!/^\d{5,14}$/.test(String(qq))) return sendJSON(res, 400, { error: 'QQ 号格式错误' });
    const r = perm.requestAuth(String(qq));
    if (r.ok && notifyOwner) {
      notifyOwner(`🔔 收到授权申请：QQ ${qq}\n主人请回复：\n#授权 ${qq}   同意\n#拒绝授权 ${qq}   拒绝`).catch(() => {});
    }
    return sendJSON(res, 200, { ok: r.ok, msg: r.msg, pending: perm.listPending() });
  }

  // 授权变更仅由主人在 QQ 侧执行，面板不开放直接增删

  // ---------- 绑定管理（已绑定用户 + 解绑记录 + 封禁名单） ----------
  if (url.pathname === '/api/bindings' && req.method === 'GET') {
    // 游戏内封禁名单要问服务器 mod；桥没连上/旧版 mod 时 gameBans 为 null，前端据此提示。
    // gameBansProvider 说明名单来自原版还是 Paradigm，gameBansError 带上失败原因（别冒充"没有封禁"）。
    let gameBans = null;
    let gameBansProvider = '';
    let gameBansError = '';
    if (isMcConnected()) {
      try {
        const gb = await getGameBans();
        gameBans = gb.bans;
        gameBansProvider = gb.provider;
      } catch (e) {
        gameBansError = e.message;
      }
    }
    return sendJSON(res, 200, {
      ok: true, ...bindingOverview(), gameBans, gameBansProvider, gameBansError, mcConnected: isMcConnected(),
    });
  }
  if (url.pathname === '/api/bindings' && req.method === 'POST') {
    const { action, qq, gameId, at, time, reason, player, id } = await readBody(req);
    if (action === 'unbind') {
      const r = forceUnbind(qq, gameId);
      return sendJSON(res, r.ok ? 200 : 400, r.ok ? { ok: true, msg: r.msg, ids: r.ids } : { ok: false, error: r.error });
    }
    // QQ 号封禁：其名下已绑定的游戏ID 逐个同步进服务器封禁名单（每个 ID 单独确认是否真的生效）
    if (action === 'ban') {
      const r = banUser(qq, time, reason);
      if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
      let synced = [];
      let failed = [];
      if (r.ids && r.ids.length && isMcConnected()) {
        const g = await banEachPlayer(r.ids, true, r.reason || 'QQ封禁')
          .catch(() => ({ done: [], failed: r.ids }));
        synced = g.done;
        failed = g.failed;
      }
      return sendJSON(res, 200, { ok: true, permanent: r.permanent, until: r.until, ids: r.ids, synced, failed });
    }
    // 删除 QQ 封禁记录（解封，同时解除封禁时解绑的游戏ID 的游戏内封禁）
    if (action === 'unban') {
      const r = unbanUser(qq);
      if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
      let lifted = [];
      let failed = [];
      if (r.ids && r.ids.length && isMcConnected()) {
        const g = await unbanEachPlayer(r.ids).catch(() => ({ done: [], failed: r.ids }));
        lifted = g.done;
        failed = g.failed;
      }
      return sendJSON(res, 200, { ok: true, ids: r.ids || [], lifted, failed });
    }
    // 按惩罚ID撤销（Paradigm 的 P-xxx；原版不支持）
    if (action === 'revokeGame') {
      const rid = String(id || '').trim();
      if (!/^[A-Za-z0-9_-]{3,64}$/.test(rid)) return sendJSON(res, 400, { ok: false, error: '惩罚ID格式不对' });
      if (!isMcConnected()) return sendJSON(res, 400, { ok: false, error: 'MC 服务器未连接' });
      const g = await revokePunishments([rid]).catch(() => ({ done: [], failed: [rid] }));
      if (!g.done.includes(rid)) return sendJSON(res, 400, { ok: false, error: '撤销失败（原版名单请按玩家名解封）', failed: g.failed });
      return sendJSON(res, 200, { ok: true, done: g.done });
    }
    // 直接封禁 / 解封游戏ID
    if (action === 'banGame' || action === 'unbanGame') {
      const name = String(player || gameId || '').trim();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return sendJSON(res, 400, { ok: false, error: '游戏ID 格式不对' });
      if (!isMcConnected()) return sendJSON(res, 400, { ok: false, error: 'MC 服务器未连接' });
      const banned = action === 'banGame';
      const r = await banPlayers([name], banned, banned ? String(reason || '').trim() : '');
      if (!r) return sendJSON(res, 400, { ok: false, error: '调用服务器失败（mod 版本过旧？）' });
      // 新版 mod 会明确返回 ok:false + error（如 Paradigm 存储后端不支持、命令执行失败）
      if (r.ok === false) return sendJSON(res, 400, { ok: false, error: String(r.error || '服务器执行失败') });
      if (Array.isArray(r.failed) && r.failed.includes(name)) {
        const why = (r.errors && r.errors[name]) || '服务器执行失败';
        return sendJSON(res, 400, { ok: false, error: why });
      }
      return sendJSON(res, 200, { ok: true, provider: r.provider || '' });
    }
    // 解绑记录：撤销（重新绑回） / 删除单条
    if (action === 'restoreUnbind') {
      const r = restoreUnbind(qq, gameId, at);
      return sendJSON(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { ok: false, error: r.error });
    }
    if (action === 'deleteUnbind') {
      const r = deleteUnbind(qq, gameId, at);
      return sendJSON(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { ok: false, error: r.error });
    }
    if (action === 'clearUnbinds') {
      return sendJSON(res, 200, { ok: true, cleared: clearUnbinds() });
    }
    return sendJSON(res, 400, { ok: false, error: '未知操作' });
  }

  // 连接状态：SnowLuma 是否就绪、QQ 是否在跑、机器人是否连上
  if (url.pathname === '/api/connection/status') {
    return sendJSON(res, 200, await connectionStatus());
  }

  // SnowLuma 自己的运行日志（末尾若干行）
  if (url.pathname === '/api/snowluma/logs') {
    return sendJSON(res, 200, { logs: tailSnowlumaLog(80) });
  }

  // ---------- QQ 空间自动说说 ----------
  if (url.pathname === '/api/qzone/status') {
    return sendJSON(res, 200, { ok: true, ...qzoneStatus() });
  }
  if (url.pathname === '/api/qzone/post-now' && req.method === 'POST') {
    try {
      const r = await postQzoneNow();
      return sendJSON(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJSON(res, 502, { ok: false, error: e.message });
    }
  }

  // ---------- 会话管理（群聊/单聊各自覆盖全局设置）----------
  // 会话列表来源：最近消息流里出现过的会话 + 已存有覆盖记录的会话
  if (url.pathname === '/api/chat-settings' && req.method === 'GET') {
    const keys = [];
    for (const k of chatCfg.listKeys()) if (!keys.includes(k)) keys.push(k);
    for (let i = takeover.msgs.length - 1; i >= 0 && keys.length < 200; i--) {
      const k = takeover.msgs[i].key;
      if (k && !keys.includes(k)) keys.push(k);
    }
    return sendJSON(res, 200, {
      global: config(),                       // 全局设置（config.json）
      conversations: chatCfg.allOverrides(),   // 各会话的覆盖项
      keys,
    });
  }
  if (url.pathname === '/api/chat-settings' && req.method === 'POST') {
    const { key, patch } = await readBody(req);
    const r = chatCfg.set(key, patch || {});
    if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
    return sendJSON(res, 200, { ok: true, overrides: r.overrides, effective: chatCfg.getEffective(key) });
  }

  // 会话列表：机器人加入的全部群聊 + 全部好友（主人私聊默认置顶）
  if (url.pathname === '/api/conversations' && req.method === 'GET') {
    const list = await listConversations();
    return sendJSON(res, 200, { ok: true, ...list });
  }
  // 置顶 / 取消置顶
  if (url.pathname === '/api/conversations/pin' && req.method === 'POST') {
    const { key, pinned } = await readBody(req);
    const r = chatCfg.setPin(key, !!pinned);
    if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
    return sendJSON(res, 200, { ok: true, pinned: chatCfg.pinnedKeys() });
  }

  // ---------- 网页 QQ 客户端：最近会话 / 消息 / 发消息 ----------
  // 会话列表来自内存收件箱（机器人收到的 + 发出的消息），名字用群列表/好友列表补全
  if (url.pathname === '/api/qq/conversations' && req.method === 'GET') {
    const fx = await fetchGroupsAndFriends();
    const names = new Map([...fx.groups, ...fx.friends].map((x) => [x.key, x.name]));
    const list = inboxList().map((c) => {
      const name = names.get(c.key) || c.name || c.id;
      if (name !== c.name) setConvName(c.key, name);
      return { ...c, name };
    });
    return sendJSON(res, 200, { ok: true, connected: bot.connected, list });
  }

  // 某会话的消息：after 用于增量拉取（只返回 id 更大的），打开即清未读
  if (url.pathname === '/api/qq/messages' && req.method === 'GET') {
    const key = String(url.searchParams.get('key') || '');
    if (!/^(g|p):\d{5,14}$/.test(key)) return sendJSON(res, 400, { ok: false, error: 'key 格式错误' });
    const after = Number(url.searchParams.get('after') || 0) || 0;
    const fx = await fetchGroupsAndFriends();
    const hit = [...fx.groups, ...fx.friends].find((x) => x.key === key);
    if (hit) setConvName(key, hit.name);
    const name = hit ? hit.name : (convName(key) || key.slice(2));
    const list = inboxMessages(key, after);
    inboxMarkRead(key);
    return sendJSON(res, 200, {
      ok: true, key, name,
      kind: key.startsWith('g:') ? 'group' : 'private',
      messages: list,
      connected: bot.connected,
    });
  }

  // 从网页发消息到真实 QQ（走机器人自己的 OneBot 连接）
  if (url.pathname === '/api/qq/send' && req.method === 'POST') {
    const { key, text } = await readBody(req);
    const k = String(key || '');
    const t = String(text || '').trim();
    if (!/^(g|p):\d{5,14}$/.test(k)) return sendJSON(res, 400, { ok: false, error: 'key 格式错误' });
    if (!t) return sendJSON(res, 400, { ok: false, error: '内容为空' });
    if (t.length > 2000) return sendJSON(res, 400, { ok: false, error: '太长了（最多 2000 字）' });
    const send = getSendMsg();
    if (!send) return sendJSON(res, 200, { ok: false, error: '机器人未连接 SnowLuma' });
    try {
      if (k.startsWith('g:')) await send('send_group_msg', { group_id: k.slice(2), message: [{ type: 'text', data: { text: t } }] });
      else await send('send_private_msg', { user_id: k.slice(2), message: [{ type: 'text', data: { text: t } }] });
      // callApi 里已经记了这条外发消息，这里把最新一条带回去让网页立刻显示
      const msgs = inboxMessages(k, 0);
      const last = msgs[msgs.length - 1] || null;
      return sendJSON(res, 200, { ok: true, message: last && last.dir === 'out' ? last : null });
    } catch (e) {
      return sendJSON(res, 200, { ok: false, error: e.message });
    }
  }

  // 全局设置 = config.json：查看 / 编辑（写入后热加载生效）
  if (url.pathname === '/api/global-config' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, config: config() });
  }
  if (url.pathname === '/api/global-config' && req.method === 'POST') {
    const body = await readBody(req);
    const base = config();
    const next = {
      rateLimit: { ...base.rateLimit },
      cooldown: { ...base.cooldown },
      engage: { ...base.engage },
      chat: { ...base.chat },
      notice: { ...base.notice },
      asr: { ...base.asr },
      bind: { ...base.bind },
      // 搜索 / 图像识别 / MC 桥接：可直接在网页切换后端与地址
      search: { ...base.search },
      vision: { ...base.vision },
      bridge: { ...base.bridge },
      qzone: { ...base.qzone },
      ai: { ...base.ai },
      memory: { ...base.memory },
    };
    // 只接受已知段下的已知键，避免往 config.json 里塞入无关字段
    for (const seg of ['rateLimit', 'cooldown', 'engage', 'chat', 'notice', 'asr', 'bind', 'search', 'vision', 'bridge', 'qzone', 'ai', 'memory']) {
      const b = body && body[seg];
      if (!b || typeof b !== 'object') continue;
      for (const k of Object.keys(next[seg])) if (k in b) next[seg][k] = b[k];
    }
    // 空间动态参数做边界校正：间隔 1~7 天、评论频率 0~10、查看权限只允许支持的值
    next.qzone = normalizeQzone(next.qzone);
    // AI / 记忆参数做边界校正：上下文 5~50 条、温度 0~2、每人记忆 5~20 条、思考强度只认已知值
    next.ai = normalizeAi(next.ai);
    next.memory = normalizeMemory(next.memory);
    if (!writeJsonAtomic(CONFIG_PATH, next)) return sendJSON(res, 500, { ok: false, error: '写入 config.json 失败' });
    reloadConfig(); // 立即热加载生效（MC 桥换地址/开关由 index.js 的配置监听在 1 秒内重连）
    return sendJSON(res, 200, { ok: true, config: config() });
  }

  // ---------- AI 接口管理：增删自定义接口 / 切换当前用哪个 ----------
  if (url.pathname === '/api/ai-providers' && req.method === 'GET') {
    const list = listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      model: p.model,
      hasKey: !!p.key,
      // 只回显前后几位，够辨认就行，别把完整密钥发到浏览器
      keyHint: p.key ? p.key.slice(0, 3) + '…' + p.key.slice(-3) : '',
    }));
    return sendJSON(res, 200, { ok: true, active: getActiveId(), list });
  }
  if (url.pathname === '/api/ai-providers' && req.method === 'POST') {
    const b = await readBody(req);
    const action = String((b && b.action) || '');
    let r;
    if (action === 'save') r = saveProvider(b);
    else if (action === 'delete') r = deleteProvider(b.id);
    else if (action === 'active') r = setActive(b.id);
    else return sendJSON(res, 400, { ok: false, error: '未知操作' });
    if (!r.ok) return sendJSON(res, 400, r);
    logger.info(`[AI接口] ${action === 'save' ? '已保存' : action === 'delete' ? '已删除' : '已切换'}（active=${getActiveId() || '自动'}）`);
    return sendJSON(res, 200, { ok: true, active: getActiveId(), list: listProviders().map((p) => ({ id: p.id, name: p.name, url: p.url, model: p.model, hasKey: !!p.key, keyHint: p.key ? p.key.slice(0, 3) + '…' + p.key.slice(-3) : '' })) });
  }

  // ---------- 人工接管（三态：auto 自动 / manual 人工 / hybrid 混合） ----------
  if (url.pathname === '/api/takeover' && req.method === 'POST') {
    const { key, mode } = await readBody(req);
    if (!/^(p|g):\d{5,14}$/.test(String(key))) return sendJSON(res, 400, { error: 'key 格式错误（p:QQ 或 g:群号）' });
    if (!['auto', 'manual', 'hybrid'].includes(String(mode))) return sendJSON(res, 400, { error: 'mode 应为 auto/manual/hybrid' });
    setTakeoverMode(key, mode, 'gui');
    return sendJSON(res, 200, { ok: true, modes: { ...takeover.modes } });
  }
  if (url.pathname === '/api/takeover') {
    return sendJSON(res, 200, { modes: { ...takeover.modes }, msgs: takeover.msgs.slice(-120), audit: takeover.audit.slice(-20) });
  }
  if (url.pathname === '/api/takeover/send' && req.method === 'POST') {
    const { key, text } = await readBody(req);
    const send = getSendMsg();
    if (!send) return sendJSON(res, 200, { ok: false, error: '机器人未连接 SnowLuma' });
    const text2 = String(text || '').trim();
    if (!/^(p|g):\d{5,14}$/.test(String(key)) || !text2) return sendJSON(res, 400, { error: 'key 或内容格式错误' });
    const isGroup = String(key).startsWith('g:');
    const id = String(key).slice(2);
    try {
      if (isGroup) await send('send_group_msg', { group_id: id, message: [{ type: 'text', data: { text: text2 } }] });
      else await send('send_private_msg', { user_id: id, message: [{ type: 'text', data: { text: text2 } }] });
      pushTakeoverMsg({ key: String(key), dir: 'out', from: 'me', text: text2, t: Date.now() });
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 200, { ok: false, error: e.message });
    }
  }

  return sendJSON(res, 404, { error: 'api not found' });
}

/** HTTP → HTTPS 跳转（默认 80 端口；WEBUI_HTTP_PORT=0 关闭） */
function startHttpRedirect(host, port, httpsPort) {
  const srv = http.createServer((req, res) => {
    const h = String(req.headers.host || '').replace(/:\d+$/, '')
      || (host === '0.0.0.0' ? 'localhost' : host);
    const target = `https://${h}${httpsPort === 443 ? '' : ':' + httpsPort}${req.url || '/'}`;
    res.writeHead(308, { Location: target, 'Cache-Control': 'no-store' });
    res.end();
  });
  srv.on('error', (e) => logger.warn(`⚠️  HTTP 跳转端口 ${port} 监听失败（${e.code || e.message}），请直接用 https 访问面板。`));
  srv.listen(port, host, () => logger.info(`↪️  HTTP :${port} → HTTPS :${httpsPort} 跳转已开启`));
  return srv;
}

export async function startWebUI() {
  if (!PANEL_PASS) {
    throw new Error('WebUI 未启动：请在 .env 里设置 WEBUI_PASSWORD（面板密码，不允许为空）。'
      + '可参考 .env.example。');
  }
  const host = process.env.WEBUI_HOST || '127.0.0.1';
  const httpsOn = useHttps();
  const port = Number(process.env.WEBUI_PORT) || (httpsOn ? 443 : 80);
  const scheme = httpsOn ? 'https' : 'http';

  const handler = (req, res) => {
    const url = new URL(req.url, `${scheme}://localhost`);
    route(req, res, url).catch((e) => sendJSON(res, 500, { error: e.message }));
  };

  // HTTPS 才生成 / 复用证书；HTTP 模式完全不碰证书与证书库
  const server = httpsOn ? https.createServer(ensureTls(), handler) : http.createServer(handler);

  // ---- 网页 QQ（Stapxs）的 OneBot WebSocket 反向代理 ----
  // 浏览器连 ws://<面板地址>/ssqq/ws（同源、免 token），服务端补 ONEBOT_TOKEN 后转到 127.0.0.1:3001。
  // 这样既不用把 OneBot 端口/token 暴露给前端，也不用给 OneBot 开 CORS。
  const ssqqWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* 坏请求直接丢弃 */ }
    if (pathname !== '/ssqq/ws') { socket.destroy(); return; }
    const wsSess = sessionOf(req);
    if (!wsSess) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (wsSess.role !== 'owner') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    ssqqWss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(ONEBOT_WS_URL, {
        headers: ONEBOT_TOKEN ? { Authorization: `Bearer ${ONEBOT_TOKEN}` } : {},
      });
      const pending = [];   // 上游还没 open 时浏览器先发的帧先攒着
      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push([data, isBinary]);
      });
      upstream.on('open', () => {
        logger.info(`🌐 网页 QQ 已接入 OneBot（${ONEBOT_WS_URL}）`);
        for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
      });
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      upstream.on('close', () => { try { client.close(); } catch { /* 已断开 */ } });
      upstream.on('error', (e) => {
        logger.warn(`🌐 网页 QQ 连接 OneBot 失败：${e.message}`);
        try { client.close(); } catch { /* 已断开 */ }
      });
      client.on('close', () => { try { upstream.close(); } catch { /* 已断开 */ } });
      client.on('error', () => { try { upstream.close(); } catch { /* 已断开 */ } });
    });
  });

  // 端口被占用时自动顺延，避免整个面板起不来：
  // 443 常被 IIS、nginx、Steam++(Watt Toolkit) 等占用，硬绑会 EADDRINUSE。
  // 依次尝试「配置端口 → 备选端口 → 由系统分配(0)」，最后一个必然成功。
  const candidates = [...new Set(httpsOn ? [port, 8443, 9443, 0] : [port, 8080, 9080, 0])];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
        const onOk = () => { server.removeListener('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(p, host);
      });
      const actual = server.address().port;
      webuiPort = actual;
      if (p !== port) {
        logger.warn(`⚠️  ${httpsOn ? 'HTTPS' : 'HTTP'} 端口 ${port} 被占用（${p === 0 ? '已改用系统分配的端口' : ''}），WebUI 实际监听 ${actual}。`
          + ' 想固定端口请改 .env 的 WEBUI_PORT。');
      }
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE' && i < candidates.length - 1) continue;
      throw e;
    }
  }

  // 公开到局域网时，把能找到的本机地址都列出来，省得去查 IP
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `${scheme}://${n.address}:${webuiPort}`);
  const shown = host === '0.0.0.0' && lan.length ? lan.join('  ') : `${scheme}://${host}:${webuiPort}`;
  logger.info(`${httpsOn ? '🔒' : '🌐'} WebUI(${httpsOn ? 'HTTPS' : 'HTTP'}): ${shown}  [需 QQ 号登录，所有者：${perm.getOwner() || '未配置'}]`);
  if (httpsOn) {
    logger.info(`   证书：${CERT_FILE}（由本地根 CA 签发；已自动装入当前用户受信任根证书，Firefox 需手动导入 data/tls/ca.crt）`);
  } else {
    logger.info('   面板当前为 HTTP 明文；要启用 HTTPS 只需在 .env 设 WEBUI_HTTPS=true（证书代码已保留）。');
  }
  if (host === '0.0.0.0') logger.info('   面板已公开到局域网，请确保密码足够强，并在系统防火墙里放行端口。');

  // 仅 HTTPS 模式提供「HTTP → HTTPS 跳转」；设 WEBUI_HTTP_PORT=0 可关闭
  const redirectPort = httpsOn
    ? (process.env.WEBUI_HTTP_PORT === undefined
      ? 80
      : (Number(process.env.WEBUI_HTTP_PORT) || 0))
    : 0;
  if (redirectPort) startHttpRedirect(host, redirectPort, webuiPort);

  return server;
}