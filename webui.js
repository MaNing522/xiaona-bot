// ============================================================
// webui.js - 响应式网页控制面板（Node 内置 http，无第三方依赖）
// 功能：NapCat 登录管理(二维码/账密/验证码)、授权管理、状态监控、日志流
// ============================================================
import http from 'http';
import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as perm from './permission.js';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import { renderCaptcha } from './captcha.js';
import { bot, logs, takeover, pushTakeoverMsg, getSendMsg, setTakeoverMode } from './state.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAPCAT_DIR = path.join(__dirname, 'napcat');
const NODE_BIN = path.join(NAPCAT_DIR, 'node.exe');
const QR_FILE = path.join(NAPCAT_DIR, 'napcat', 'cache', 'qrcode.png');
const LOGIN_FILE = path.join(__dirname, 'data', 'login.json');
const WEB_DIR = path.join(__dirname, 'web', 'index.html');

const MAX_LOG = 300;

// ---------- 记住上次成功登录的账号（面板与启动脚本共用同一个文件） ----------
function readSavedQq() {
  const d = readJsonSafe(LOGIN_FILE, null, 'login.json');
  return d && /^\d{5,14}$/.test(String(d.qq)) ? String(d.qq) : '';
}
function saveLoginQq(qq) {
  writeJsonAtomic(LOGIN_FILE, { qq: String(qq), at: Date.now() });
}

// 主人通知回调（由 index.js 注入，用于 QQ 通知主人审批）
let notifyOwner = null;
export function setOwnerNotifier(cb) {
  notifyOwner = cb;
}

// ---------- 登录子进程管理 ----------
const login = {
  proc: null,
  mode: '',
  qq: '',
  saved: false,
  logs: [],
  startedAt: 0,
};

function bufLog(line) {
  login.logs.push(line);
  if (login.logs.length > MAX_LOG) login.logs.shift();
}

function detectSuccess() {
  const s = login.logs.join('\n');
  return /登录成功|密码回退登录成功|快速登录成功|READY|已登录|CoreVersion|QQLoginStatus/.test(s);
}
function detectCaptcha() {
  const s = login.logs.join('\n');
  return /验证码|proofWater|需要验证|异常设备|新设备|滑块/.test(s);
}
// 从日志中提取验证链接（NapCat 需要验证码/滑块时会打印验证 URL）
function extractVerifyUrl() {
  const lines = login.logs.filter((l) => /验证|安全|滑块|verify|captcha/i.test(l));
  for (const l of lines) {
    const m = l.match(/https?:\/\/[^\s"'）)]+/);
    if (m) return m[0];
  }
  return '';
}

// ---------- NapCat 在线探测（无论是否由面板启动，与终端一致） ----------
let napcatUp = false;
let napcatProbeAt = 0;
function wsPort() {
  const m = (process.env.NAPCAT_WS || 'ws://127.0.0.1:3001').match(/:(\d+)/);
  return m ? +m[1] : 3001;
}
async function probeNapCat() {
  const now = Date.now();
  if (now - napcatProbeAt < 2000) return napcatUp; // 2s 缓存，避免高频探测
  napcatProbeAt = now;
  const port = wsPort();
  napcatUp = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(1500, () => done(false));
  });
  return napcatUp;
}

async function startLogin({ mode, qq, password }) {
  if (login.proc) return { error: '已有登录进程在运行，请先停止。' };
  if (mode === 'password' && (!qq || !password)) return { error: '账密登录需要账号和密码。' };
  // NapCat 已在外部运行（如 启动.bat 拉起）时，避免重复启动两个 NapCat
  if (await probeNapCat()) return { error: '检测到 NapCat 已在运行（可能由启动脚本外部启动），请勿重复启动。' };

  const args = ['./index.js'];
  if (qq) args.push('-q', String(qq));
  const env = { ...process.env };
  if (mode === 'password') {
    env.ACCOUNT = String(qq);
    env.NAPCAT_QUICK_ACCOUNT = String(qq);
    env.NAPCAT_QUICK_PASSWORD = String(password);
  } else if (qq) {
    env.NAPCAT_QUICK_ACCOUNT = String(qq);
  }

  login.mode = mode;
  login.qq = qq ? String(qq) : '';
  login.saved = false;          // 只有真的登录成功才落盘（避免记住输错的账号）
  login.logs = [];
  login.startedAt = Date.now();

  const proc = spawn(NODE_BIN, args, { cwd: NAPCAT_DIR, env, windowsHide: true });
  login.proc = proc;

  const onData = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((l) => l.trim() && bufLog(l.trim()));
    if (!login.saved && login.qq && detectSuccess()) {
      login.saved = true;
      saveLoginQq(login.qq);
      bufLog(`[进程] 已记住账号 ${login.qq}，下次登录自动填充。`);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code) => {
    bufLog(`[进程] NapCat 已退出 (code=${code})`);
    login.proc = null;
  });
  bufLog(`[进程] 已启动 NapCat，登录方式: ${mode}${qq ? `，账号 ${qq}` : ''}`);
  return { ok: true };
}

function stopLogin() {
  if (login.proc) {
    try { login.proc.kill(); } catch {}
    login.proc = null;
  }
  login.logs = [];
  return { ok: true };
}

async function loginStatus() {
  const up = await probeNapCat(); // NapCat 实际在线（含外部启动）
  return {
    running: !!login.proc,
    mode: login.mode,
    startedAt: login.startedAt,
    qrExists: fs.existsSync(QR_FILE),
    success: detectSuccess(),
    captcha: detectCaptcha(),
    verifyUrl: extractVerifyUrl(),
    napcatUp: up,
    external: !login.proc && up, // 外部启动（非面板启动）
    savedQq: readSavedQq(),      // 上次成功登录的账号，供面板自动填充
    logs: login.logs.slice(-80),
  };
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

// ---------- 面板认证：账号密码 + 图形人机验证 + 会话 Cookie ----------
// 面板能控制机器人（以机器人身份发消息、用 QQ 账密启动登录），公开到局域网后必须挡一层。
const PANEL_USER = process.env.WEBUI_USER || 'admin';
// 密码只从 .env 读，代码里不留任何默认值：没配就直接拒绝启动（fail-closed），
// 避免出现"忘了配密码 → 面板用一个人所共知的默认密码裸奔"的情况
const PANEL_PASS = process.env.WEBUI_PASSWORD || '';
const SESSION_TTL = 12 * 60 * 60 * 1000;   // 登录有效期 12 小时
const CAPTCHA_TTL = 3 * 60 * 1000;         // 验证码 3 分钟
const LOGIN_MAX_FAIL = 5;                  // 连续失败上限
const LOGIN_BLOCK_MS = 5 * 60 * 1000;      // 超过上限封 5 分钟

const sessions = new Map();    // token → 过期时间
const preAuth = new Map();     // 预登录 id → { answer, exp }
const failLog = new Map();     // ip → { n, until }

function sweepAuth() {
  const now = Date.now();
  for (const [k, exp] of sessions) if (now > exp) sessions.delete(k);
  for (const [k, v] of preAuth) if (now > v.exp) preAuth.delete(k);
  for (const [k, v] of failLog) if (v.until && now > v.until) failLog.delete(k);
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

function authed(req) {
  sweepAuth();
  const token = parseCookies(req).xn_sess;
  if (!/^[0-9a-f]{64}$/.test(token || '')) return false;
  const exp = sessions.get(token);
  if (!exp || Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function loginPage(msg = '') {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0f1420">
<title>小钠控制面板 · 登录</title>
<style>
:root{
  --bg:#0f1420; --card:#171f31; --card2:#121a2a; --line:#27314a;
  --txt:#e8eef9; --sub:#94a3bd; --accent:#4f8cff; --accent2:#7c5cff; --danger:#ef5350; --radius:16px;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
  background:radial-gradient(1200px 600px at 15% -10%, rgba(79,140,255,.18), transparent 60%),
             radial-gradient(900px 500px at 100% 0%, rgba(124,92,255,.14), transparent 55%),
             var(--bg);
  color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{width:340px;max-width:100%;padding:26px 24px;border-radius:var(--radius);
  background:linear-gradient(180deg,rgba(255,255,255,.02),transparent),var(--card);
  border:1px solid var(--line);box-shadow:0 10px 40px rgba(0,0,0,.4)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.logo{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:20px;flex:0 0 auto;
  background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 6px 18px rgba(79,140,255,.35)}
h1{margin:0;font-size:17px}
.sub{color:var(--sub);font-size:12px;line-height:1.5}
label{display:block;font-size:13px;color:var(--sub);margin:12px 0 5px}
input{width:100%;min-height:44px;padding:0 14px;border-radius:13px;border:1px solid var(--line);
  background:var(--card2);color:var(--txt);font-size:15px}
input:focus{outline:none;border-color:var(--accent)}
.row{display:flex;gap:10px;align-items:center;margin-top:8px}
.row input{flex:1}
.row img{height:44px;border-radius:10px;border:1px solid var(--line);background:#fff;cursor:pointer}
button{width:100%;margin-top:18px;min-height:46px;border:0;border-radius:13px;
  background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
  font-family:inherit;font-size:15px;font-weight:600;cursor:pointer}
button:active{transform:scale(.98)}
button:disabled{opacity:.6;cursor:default}
.err{margin-top:12px;color:#ff8b8b;font-size:12px;min-height:16px}
@media (prefers-color-scheme:light){
  body{background:radial-gradient(1200px 600px at 15% -10%, rgba(79,140,255,.12), transparent 60%),#eef2f9;
       color:#1a2436}
  .card{background:#fff;border-color:#dbe3f1}
  .sub,label{color:#5b6b86}
  input{background:#f4f7ff;border-color:#dbe3f1;color:#1a2436}
  .row img{border-color:#dbe3f1}
}
</style></head><body>
<form class="card" id="f">
  <div class="brand">
    <div class="logo">🤖</div>
    <div>
      <h1>小钠控制面板</h1>
      <div class="sub">需要登录后使用（点验证码可换一张）</div>
    </div>
  </div>
  <label>账号</label><input id="u" value="${PANEL_USER}" autocomplete="username">
  <label>密码</label><input id="p" type="password" autocomplete="current-password">
  <label>人机验证</label>
  <div class="row">
    <input id="c" inputmode="numeric" maxlength="4" placeholder="4 位数字" autocomplete="off">
    <img id="cap" src="/api/captcha" alt="验证码" title="点一下换一张">
  </div>
  <button id="b">登录</button>
  <div class="err" id="e">${msg}</div>
</form>
<script>
var $ = function (i) { return document.getElementById(i); };
function fresh() { $('cap').src = '/api/captcha?t=' + Date.now(); }
$('cap').onclick = fresh;
$('f').onsubmit = async function (ev) {
  ev.preventDefault();
  $('b').disabled = true; $('e').textContent = '';
  try {
    var r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: $('u').value, pass: $('p').value, captcha: $('c').value }),
    });
    var j = await r.json().catch(function () { return {}; });
    if (r.ok && j.ok) { location.reload(); return; }
    $('e').textContent = j.error || '登录失败';
  } catch (e) { $('e').textContent = '网络错误'; }
  $('b').disabled = false; $('c').value = ''; $('p').value = ''; fresh();
};
</script></body></html>`;
}

// ---------- 路由 ----------
async function route(req, res, url) {
  sweepAuth();

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // 未登录只给登录页，真实面板不落给未认证的人
    if (!authed(req)) return sendHtml(res, 200, loginPage());
    if (!fs.existsSync(WEB_DIR)) return sendJSON(res, 500, { error: '缺少 web/index.html' });
    const html = fs.readFileSync(WEB_DIR);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
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
      'Set-Cookie': `xn_pre=${pid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CAPTCHA_TTL / 1000}`,
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
    const pid = parseCookies(req).xn_pre || '';
    const p = preAuth.get(pid);
    preAuth.delete(pid);      // 验证码一次性，无论对错都用掉

    let bad = '';
    if (!p || Date.now() > p.exp) bad = '验证码已过期，请重新输入';
    else if (String(body.captcha || '').trim() !== p.answer) bad = '验证码不对';
    else if (!(safeEq(body.user, PANEL_USER) && safeEq(body.pass, PANEL_PASS))) bad = '账号或密码不对';

    if (bad) {
      const n = ((f && f.n) || 0) + 1;
      failLog.set(ip, { n, until: n >= LOGIN_MAX_FAIL ? Date.now() + LOGIN_BLOCK_MS : 0 });
      logger.info(`🔒 面板登录失败（${ip}）: ${bad}（连续第 ${n} 次）`);
      return sendJSON(res, 401, {
        ok: false,
        error: bad + (n >= LOGIN_MAX_FAIL ? `，已锁定 ${LOGIN_BLOCK_MS / 60000} 分钟` : ''),
      });
    }

    failLog.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL);
    logger.info(`🔓 面板登录成功（${ip}）`);
    res.setHeader('Set-Cookie', `xn_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`);
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/logout') {
    const token = parseCookies(req).xn_sess;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'xn_sess=; Path=/; HttpOnly; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  if (!url.pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });

  // 其余所有接口一律要求登录（含二维码、日志、授权列表、接管）
  if (!authed(req)) return sendJSON(res, 401, { ok: false, error: '未登录', login: true });

  // 登录二维码：等于账号的登录凭据，必须登录后才给
  if (url.pathname === '/api/qrcode') {
    if (!fs.existsSync(QR_FILE)) return sendJSON(res, 404, { error: '暂无二维码' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(QR_FILE));
  }

  if (url.pathname === '/api/status') {
    const ls = await loginStatus();
    return sendJSON(res, 200, {
      serviceUp: true,
      model: process.env.AI_MODEL || 'deepseek-chat',
      wsUrl: process.env.NAPCAT_WS || 'ws://127.0.0.1:3001',
      botConnected: bot.connected,
      botError: bot.lastError,
      owner: perm.getOwner(),
      ...ls,
    });
  }

  // 终端实时日志（与终端输出一致）
  if (url.pathname === '/api/logs') {
    return sendJSON(res, 200, { logs: logs.slice(-200) });
  }

  if (url.pathname === '/api/perms') {
    return sendJSON(res, 200, {
      owner: perm.getOwner(),
      admins: (process.env.BOT_ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean),
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

  if (url.pathname === '/api/login/start' && req.method === 'POST') {
    const { mode, qq, password } = await readBody(req);
    return sendJSON(res, 200, await startLogin({ mode: mode || 'qrcode', qq, password }));
  }

  if (url.pathname === '/api/login/stop' && req.method === 'POST') {
    return sendJSON(res, 200, stopLogin());
  }

  if (url.pathname === '/api/login/status') {
    return sendJSON(res, 200, await loginStatus());
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
    if (!send) return sendJSON(res, 200, { ok: false, error: '机器人未连接 NapCat' });
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

export async function startWebUI() {
  if (!PANEL_PASS) {
    throw new Error('WebUI 未启动：请在 .env 里设置 WEBUI_PASSWORD（面板密码，不允许为空）。'
      + '可参考 .env.example。');
  }
  const host = process.env.WEBUI_HOST || '127.0.0.1';
  const port = Number(process.env.WEBUI_PORT) || 8080;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    route(req, res, url).catch((e) => sendJSON(res, 500, { error: e.message }));
  });

  await new Promise((resolve, reject) => {
    server.listen(port, host, resolve);
    server.on('error', reject);
  });

  // 公开到局域网时，把能找到的本机地址都列出来，省得去查 IP
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n.address}:${port}`);
  const shown = host === '0.0.0.0' && lan.length ? lan.join('  ') : `http://${host}:${port}`;
  logger.info(`🌐 WebUI: ${shown}  [需登录，账号 ${PANEL_USER}]`);
  if (host === '0.0.0.0') logger.info('   面板已公开到局域网，请确保密码足够强，并在系统防火墙里放行端口。');
  if (PANEL_PASS === 'mn123456') logger.info('⚠️  面板密码仍是弱口令 mn123456，局域网内请尽快改掉 .env 的 WEBUI_PASSWORD。');
  return server;
}