// ============================================================
// webui.js - 响应式网页控制面板（Node 内置 https + 自签名证书，无第三方依赖）
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
import * as perm from './permission.js';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import { renderCaptcha } from './captcha.js';
import { bot, logs, takeover, pushTakeoverMsg, getSendMsg, setTakeoverMode } from './state.js';
import { logger } from './logger.js';
import { isAiEnabled, balanceEndpoint, getProviderInfo } from './aiService.js';
import { isMcConnected, getGameBans, banPlayers, getBridgeTarget, isMcConfigured } from './mcbridge.js';
import { isSearchEnabled, searchSettings } from './search.js';
import * as chatCfg from './chatSettings.js';
import { qzoneStatus, postQzoneNow, normalizeQzone } from './qzone.js';
import { HELP_CMDS, TIERS } from './help.js';
import { config, reloadConfig, CONFIG_PATH } from './config.js';
import {
  bindingOverview, forceUnbind, clearUnbinds, banUser, unbanUser,
  deleteUnbind, restoreUnbind,
} from './binding.js';
import { ROOT } from './paths.js';
import { ensureTls, CERT_FILE } from './tls.js';
import { transcribe } from './asr.js';

const SNOWLUMA_DIR = path.join(ROOT, 'snowluma');
const WEB_DIR = path.join(ROOT, 'web', 'index.html');

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

// ---------- 面板认证：账号密码 + 图形人机验证 + 会话 Cookie ----------
// 面板能以机器人身份发消息、管理授权，公开到局域网后必须挡一层。
const PANEL_USER = process.env.WEBUI_USER || 'admin';
// 密码只从 .env 读，代码里不留任何默认值：没配就直接拒绝启动（fail-closed），
// 避免出现"忘了配密码 → 面板用一个人所共知的默认密码裸奔"的情况
const PANEL_PASS = process.env.WEBUI_PASSWORD || '';
const SESSION_TTL = 24 * 60 * 60 * 1000;    // 登录有效期 24 小时（非正常退出也按这个保留）
const SESSION_FILE = path.join(ROOT, 'data', 'webui-sessions.json');
const CAPTCHA_TTL = 3 * 60 * 1000;         // 验证码 3 分钟
const CAPTCHA_AFTER_FAILS = 5;             // 连续输错密码达到这个次数后，才要求人机验证
const LOGIN_MAX_FAIL = 10;                 // 连续失败上限（含验证码错误），超过则封 5 分钟
const LOGIN_BLOCK_MS = 5 * 60 * 1000;      // 超过上限封 5 分钟

// token → 过期时间。落盘保存：机器人重启、浏览器异常关闭（没点退出登录）都不会丢会话，
// 只有主动调用 /api/logout 或超过 24 小时才失效。
const sessions = new Map();
const preAuth = new Map();     // 预登录 id → { answer, exp }
const failLog = new Map();     // ip → { n, until }

// 启动时恢复上次的登录会话（只认格式正确且未过期的）
for (const [token, exp] of Object.entries(readJsonSafe(SESSION_FILE, {}, 'webui-sessions.json') || {})) {
  if (/^[0-9a-f]{64}$/.test(token) && Number(exp) > Date.now()) sessions.set(token, Number(exp));
}

function saveSessions() {
  const obj = {};
  for (const [token, exp] of sessions) obj[token] = exp;
  writeJsonAtomic(SESSION_FILE, obj);
}

function sweepAuth() {
  const now = Date.now();
  let changed = false;
  for (const [k, exp] of sessions) if (now > exp) { sessions.delete(k); changed = true; }
  for (const [k, v] of preAuth) if (now > v.exp) preAuth.delete(k);
  for (const [k, v] of failLog) if (v.until && now > v.until) failLog.delete(k);
  if (changed) saveSessions();
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
  if (!exp || Date.now() > exp) {
    if (sessions.delete(token)) saveSessions();
    return false;
  }
  return true;
}

/** 试用页客户端标识：按浏览器分配（会话级 Cookie，关掉浏览器即失效） */
const TRIAL_COOKIE = 'xn_tid';
function trialClientId(req, res) {
  let id = parseCookies(req)[TRIAL_COOKIE];
  if (!/^[0-9a-f]{32}$/.test(id || '')) {
    id = crypto.randomBytes(16).toString('hex');
    // 不设 Max-Age：会话级 Cookie，浏览器关闭即失效，试用历史随之被丢弃
    if (res && !res.headersSent) {
      res.setHeader('Set-Cookie', `${TRIAL_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    }
  }
  return id;
}

/**
 * 免登录试用限速：按浏览器（Cookie）+ IP 双维度，防止外人白嫖 AI 额度。
 * 只限制未登录访客；登录后的所有者试用不受影响。
 */
const TRIAL_WINDOW_MS = 10 * 60 * 1000;
const TRIAL_GUEST_LIMIT = 20;     // 每个浏览器 10 分钟最多 20 句
const TRIAL_IP_LIMIT = 50;        // 每个 IP 10 分钟最多 50 句
const TRIAL_GUEST_GAP_MS = 1200;  // 两句之间至少隔 1.2 秒
const trialRate = new Map();
let trialGuestBusy = 0;

/** 记一次试用；超限返回需要等待的秒数，0 表示放行 */
function trialRateHit(key, limit, gapMs, now) {
  let v = trialRate.get(key);
  if (!v || now - v.at > TRIAL_WINDOW_MS) { v = { at: now, n: 0, last: 0 }; trialRate.set(key, v); }
  if (gapMs && v.last && now - v.last < gapMs) return Math.max(1, Math.ceil((gapMs - (now - v.last)) / 1000));
  if (v.n >= limit) return Math.max(1, Math.ceil((TRIAL_WINDOW_MS - (now - v.at)) / 1000));
  v.n++;
  v.last = now;
  return 0;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of trialRate) if (now - v.at > TRIAL_WINDOW_MS * 2) trialRate.delete(k);
}, 10 * 60 * 1000).unref?.();

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
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
  <label>账号</label><input id="u" value="${PANEL_USER}" autocomplete="username">
  <label>密码</label><input id="p" type="password" autocomplete="current-password">
  <div id="capBox" style="display:${needCaptcha ? 'block' : 'none'}">
    <label>人机验证</label>
    <div class="row">
      <input id="c" inputmode="numeric" maxlength="4" placeholder="4 位数字" autocomplete="off">
      <img id="cap" alt="验证码" title="点一下换一张">
    </div>
  </div>
  <button id="b">登录</button>
  <div class="err" id="e">${msg}</div>
  <a class="alt" href="/trial">🧪 先试用一下（无需登录）</a>
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
// 用 XHR 而不是 fetch/async：老旧浏览器也能登录
$('f').onsubmit = function (ev) {
  ev.preventDefault();
  $('b').disabled = true; $('e').textContent = '';
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/login', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    var j = {};
    try { j = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
    if (xhr.status >= 200 && xhr.status < 300 && j.ok) { location.reload(); return; }
    $('e').textContent = j.error || ('登录失败（HTTP ' + xhr.status + '）');
    if (j.captchaRequired) showCaptcha(true);
    $('b').disabled = false; $('c').value = ''; $('p').value = '';
    if ($('capBox').style.display !== 'none') fresh();
  };
  xhr.onerror = function () {
    $('e').textContent = '网络错误';
    $('b').disabled = false;
  };
  xhr.send(JSON.stringify({ user: $('u').value, pass: $('p').value, captcha: $('c').value }));
};
</script></body></html>`;
}

/**
 * 试用页（登录前也能用）：以「小锂 · 普通用户」身份跟小钠私聊，不经过 QQ。
 * 刻意只用 ES5 + XHR + 老式 CSS，保证老旧手机浏览器也能打开。
 */
function trialPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f0f2f5">
<title>小钠 · 私聊试用</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f0f2f5;color:#1f2329;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:24px}
.card{width:100%;max-width:560px;background:#fff;border:1px solid #e8ebf0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.06);display:flex;flex-direction:column;height:86vh;max-height:1400px;min-height:420px;overflow:hidden}
.head{padding:14px 16px;border-bottom:1px solid #e8ebf0;display:flex;align-items:center}
.head .logo{font-size:22px;margin-right:10px}
.head h1{margin:0;font-size:15px}
.head .sub{font-size:12px;color:#8a919f}
.head .who{margin-left:auto;font-size:12px;color:#8a919f;white-space:nowrap}
.head .who a{color:#1677ff;text-decoration:none}
.msgs{flex:1;overflow-y:auto;padding:16px;background:#fafbfc}
.row{display:flex;margin-bottom:10px}
.row.me{justify-content:flex-end}
.bub{max-width:78%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.me .bub{background:#1677ff;color:#fff;border-bottom-right-radius:4px}
.na .bub{background:#fff;border:1px solid #e8ebf0;border-bottom-left-radius:4px}
.tip{color:#8a919f;font-size:12px;text-align:center;margin:6px 0}
.foot{display:flex;padding:12px;border-top:1px solid #e8ebf0}
textarea{flex:1;resize:none;height:44px;padding:10px 12px;border:1px solid #e8ebf0;border-radius:8px;font:inherit;outline:none}
textarea:focus{border-color:#1677ff}
button{border:0;background:#1677ff;color:#fff;border-radius:8px;padding:0 18px;font:inherit;cursor:pointer;margin-left:8px}
button:disabled{opacity:.6;cursor:default}
.bub.wait{color:#8a919f}
.bub.err{background:#fff5f5;border:1px solid #ffd6d6;color:#c0392b}
</style></head><body>
<div class="card">
  <div class="head">
    <div class="logo">🤖</div>
    <div><h1>小钠 · 私聊试用</h1><div class="sub">发消息看看小钠怎么回</div></div>
    <div class="who">你是 小锂 · 普通用户 · <a href="/">登录面板</a></div>
  </div>
  <div class="msgs" id="m"><div class="tip">这里模拟普通用户「小锂」跟小钠私聊，不经过 QQ。登录面板后会以所有者身份试用。</div></div>
  <div class="foot">
    <textarea id="t" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
    <button id="s">发送</button>
  </div>
</div>
<script>
var $=function(i){return document.getElementById(i);};
var busy=false;
function add(cls,text,kind){var r=document.createElement('div');r.className='row '+cls;var b=document.createElement('div');b.className='bub'+(kind?' '+kind:'');b.textContent=text;$('m').appendChild(r);r.appendChild(b);$('m').scrollTop=$('m').scrollHeight;return b;}
// 逐字显示：约 60 帧吐完；老浏览器没有 matchMedia 时也能正常走
function typeInto(b,text,done){
  var reduce=false;
  try{reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;}catch(e){}
  if(reduce){b.className='bub';b.textContent=text;done();return;}
  var n=text.length,step=Math.max(1,Math.round(n/60)),i=0;
  (function tick(){
    i=Math.min(n,i+step);
    b.textContent=text.slice(0,i);
    $('m').scrollTop=$('m').scrollHeight;
    if(i<n) setTimeout(tick,26);
    else {b.className='bub';done();}
  })();
}
function fail(b,msg){b.className='bub err';b.textContent='⚠️ 小钠这次没回成：'+msg;}
function send(){
  if(busy)return;
  var t=$('t').value.replace(/^\\s+|\\s+$/g,''); if(!t)return;
  busy=true;$('s').disabled=true;$('t').value='';
  add('me',t);
  var b=add('na','小钠正在输入…','wait');
  var xhr=new XMLHttpRequest();
  xhr.open('POST','/api/trial/chat',true);
  xhr.setRequestHeader('Content-Type','application/json');
  xhr.onreadystatechange=function(){
    if(xhr.readyState!==4)return;
    var j={};
    try{j=JSON.parse(xhr.responseText||'{}');}catch(e){}
    if(xhr.status>=200&&xhr.status<300&&j.ok){
      var reply=String(j.reply||'');
      if(!reply){fail(b,'返回内容为空');}
      else {b.className='bub';b.textContent='';typeInto(b,reply,function(){busy=false;$('s').disabled=false;$('t').focus();});return;}
    }else{
      fail(b,j.error||('HTTP '+xhr.status));
    }
    busy=false;$('s').disabled=false;$('t').focus();
  };
  xhr.onerror=function(){fail(b,'网络错误');busy=false;$('s').disabled=false;};
  xhr.send(JSON.stringify({text:t}));
}
$('s').onclick=send;
$('t').onkeydown=function(e){
  e=e||window.event;
  var k=e.keyCode||e.which;
  if(k===13&&!e.shiftKey){if(e.preventDefault)e.preventDefault();send();return false;}
};
$('t').focus();
// 试用会话不落盘：浏览器关闭/离开时通知服务端丢弃内存历史
window.onpagehide=function(){try{if(navigator.sendBeacon)navigator.sendBeacon('/api/trial/reset');}catch(e){}};
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

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // 未登录只给登录页，真实面板不落给未认证的人
    if (!authed(req)) return sendHtml(res, 200, loginPage('', captchaNeeded(clientIp(req))));
    if (!fs.existsSync(WEB_DIR)) return sendJSON(res, 500, { error: '缺少 web/index.html' });
    const html = fs.readFileSync(WEB_DIR);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // 试用页：登录前也能用（普通用户身份）；登录后再打开会按所有者身份跑
  if (url.pathname === '/trial' || url.pathname === '/trial.html') {
    return sendHtml(res, 200, trialPage());
  }

  // 老旧浏览器兼容页（纯 ES5 + XHR，只保留状态 / 登录 / 试用）
  if (url.pathname === '/legacy' || url.pathname === '/legacy.html') {
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
      'Set-Cookie': `xn_pre=${pid}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${CAPTCHA_TTL / 1000}`,
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
    if (!bad && !(safeEq(body.user, PANEL_USER) && safeEq(body.pass, PANEL_PASS))) bad = '账号或密码不对';

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
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL);
    saveSessions();
    logger.info(`🔓 面板登录成功（${ip}）`);
    res.setHeader('Set-Cookie', `xn_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL / 1000}`);
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/logout') {
    const token = parseCookies(req).xn_sess;
    if (token && sessions.delete(token)) saveSessions();
    // 退出登录也丢弃**本客户端**的试用会话（不落盘），并清掉试用客户端 Cookie
    if (trialReset) trialReset(parseCookies(req)[TRIAL_COOKIE]);
    res.setHeader('Set-Cookie', [
      'xn_sess=; Path=/; HttpOnly; Secure; Max-Age=0',
      `${TRIAL_COOKIE}=; Path=/; HttpOnly; Secure; Max-Age=0`,
    ]);
    return sendJSON(res, 200, { ok: true });
  }

  // 试用聊天：登录前是「小锂 · 普通用户」，登录后按所有者身份跑；都不经过 QQ
  if (url.pathname === '/api/trial/chat' && req.method === 'POST') {
    if (!trialChat) return sendJSON(res, 503, { ok: false, error: '试用聊天未就绪（机器人还没起来）' });
    const isOwner = authed(req);
    const cid = trialClientId(req, res);   // 每个浏览器一份内存历史，互不串
    const body = await readBody(req);
    let t = String(body.text || '').trim();
    const isVoice = !t && !!body.audio;
    if (isVoice && !isOwner) {
      return sendJSON(res, 403, { ok: false, error: '语音试用需要先登录面板' });
    }
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
    const maxLen = isOwner ? 500 : 300;
    if (t.length > maxLen) return sendJSON(res, 400, { ok: false, error: `太长了（最多 ${maxLen} 字）` });
    // 未登录访客限速，避免外人白嫖 AI 额度
    if (!isOwner) {
      const now = Date.now();
      let wait = trialRateHit('c:' + cid, TRIAL_GUEST_LIMIT, TRIAL_GUEST_GAP_MS, now);
      if (!wait) wait = trialRateHit('ip:' + clientIp(req), TRIAL_IP_LIMIT, 0, now);
      if (wait) return sendJSON(res, 429, { ok: false, error: `试用太频繁，请 ${wait} 秒后再试` });
      if (trialGuestBusy >= 2) return sendJSON(res, 503, { ok: false, error: '当前试用的人有点多，稍后再试' });
    }
    if (!isOwner) trialGuestBusy++;
    try {
      const result = await trialChat(cid, t, { owner: isOwner });
      const reply = typeof result === 'string' ? result : String((result && result.reply) || '');
      const voices = (result && Array.isArray(result.voices)) ? result.voices : [];
      if (!reply && !voices.length) return sendJSON(res, 502, { ok: false, error: '小钠没有返回内容' });
      return sendJSON(res, 200, { ok: true, reply, heard: isVoice ? t : '', voices });
    } catch (e) {
      // 把失败原因原样带回前端展示（如「AI 请求失败 (401)：...」「AI 超时」）
      const reason = String((e && e.message) || e || '未知错误');
      logger.warn(`[试用] 这轮没回成：${reason}`);
      return sendJSON(res, 502, { ok: false, error: reason });
    } finally {
      if (!isOwner) trialGuestBusy--;
    }
  }

  // 试用会话不落盘：浏览器关闭时前端用 beacon 打到这，丢弃本客户端的内存历史
  if (url.pathname === '/api/trial/reset' && req.method === 'POST') {
    if (trialReset) trialReset(trialClientId(req, res));
    return sendJSON(res, 200, { ok: true });
  }

  if (!url.pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });

  // 其余所有接口一律要求登录（含日志、授权列表、接管）
  if (!authed(req)) return sendJSON(res, 401, { ok: false, error: '未登录', login: true });

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
    const { action, qq, gameId, at, time, reason, player } = await readBody(req);
    if (action === 'unbind') {
      const r = forceUnbind(qq, gameId);
      return sendJSON(res, r.ok ? 200 : 400, r.ok ? { ok: true, msg: r.msg, ids: r.ids } : { ok: false, error: r.error });
    }
    // QQ 号封禁：同时把其名下已绑定的游戏ID 同步进服务器封禁名单
    if (action === 'ban') {
      const r = banUser(qq, time, reason);
      if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error });
      let synced = [];
      if (r.ids && r.ids.length && isMcConnected()) {
        const g = await banPlayers(r.ids, true, r.reason || 'QQ封禁').catch(() => null);
        if (g && Array.isArray(g.done)) synced = g.done;
      }
      return sendJSON(res, 200, { ok: true, permanent: r.permanent, until: r.until, ids: r.ids, synced });
    }
    // 删除 QQ 封禁记录（解封，不恢复被封时已解绑的游戏ID）
    if (action === 'unban') {
      const r = unbanUser(qq);
      return sendJSON(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { ok: false, error: r.error });
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
    };
    // 只接受已知段下的已知键，避免往 config.json 里塞入无关字段
    for (const seg of ['rateLimit', 'cooldown', 'engage', 'chat', 'notice', 'asr', 'bind', 'search', 'vision', 'bridge', 'qzone']) {
      const b = body && body[seg];
      if (!b || typeof b !== 'object') continue;
      for (const k of Object.keys(next[seg])) if (k in b) next[seg][k] = b[k];
    }
    // 空间动态参数做边界校正：间隔 1~7 天、评论频率 0~10、查看权限只允许支持的值
    next.qzone = normalizeQzone(next.qzone);
    if (!writeJsonAtomic(CONFIG_PATH, next)) return sendJSON(res, 500, { ok: false, error: '写入 config.json 失败' });
    reloadConfig(); // 立即热加载生效（MC 桥换地址/开关由 index.js 的配置监听在 1 秒内重连）
    return sendJSON(res, 200, { ok: true, config: config() });
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
  const port = Number(process.env.WEBUI_PORT) || 443; // HTTPS 默认 443

  // 自签名证书：首次启动自动生成到 data/tls/，之后复用；过期 / 损坏时自动重签
  const tlsOpts = ensureTls();

  const server = https.createServer(tlsOpts, (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    route(req, res, url).catch((e) => sendJSON(res, 500, { error: e.message }));
  });

  // 端口被占用时自动顺延，避免整个面板起不来：
  // 443 常被 IIS、nginx、Steam++(Watt Toolkit) 等占用，硬绑会 EADDRINUSE。
  // 依次尝试「配置端口 → 8443 → 9443 → 由系统分配(0)」，最后一个必然成功。
  const candidates = [...new Set([port, 8443, 9443, 0])];
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
        logger.warn(`⚠️  HTTPS 端口 ${port} 被占用（${p === 0 ? '已改用系统分配的端口' : ''}），WebUI 实际监听 ${actual}。`
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
    .map((n) => `https://${n.address}:${webuiPort}`);
  const shown = host === '0.0.0.0' && lan.length ? lan.join('  ') : `https://${host}:${webuiPort}`;
  logger.info(`🔒 WebUI(HTTPS): ${shown}  [需登录，账号 ${PANEL_USER}]`);
  logger.info(`   自签名证书：${CERT_FILE}（浏览器首次访问点「高级 → 继续访问」；也可导入系统受信任的根证书）`);
  if (host === '0.0.0.0') logger.info('   面板已公开到局域网，请确保密码足够强，并在系统防火墙里放行端口。');
  if (PANEL_PASS === 'mn123456') logger.info('⚠️  面板密码仍是弱口令 mn123456，局域网内请尽快改掉 .env 的 WEBUI_PASSWORD。');

  // 老地址（HTTP）自动跳到 HTTPS；设 WEBUI_HTTP_PORT=0 可关闭
  const redirectPort = process.env.WEBUI_HTTP_PORT === undefined
    ? 80
    : (Number(process.env.WEBUI_HTTP_PORT) || 0);
  if (redirectPort) startHttpRedirect(host, redirectPort, webuiPort);

  return server;
}