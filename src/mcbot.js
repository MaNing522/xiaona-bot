// ============================================================
// mcbot.js - 小钠自己的 MC 客户端（headless 子进程 + 本机 HTTP 控制）
//
// 实际进服的是 src/mcheadless/headless.js（Baritone 式寻路/采矿/飞行），
// 这个模块只负责：
//   · 按需拉起子进程（MC_AUTOCONNECT=false，不自动进服）
//   · 用 HTTP 把 AI 的指令转给它（进服/退服、任务指令、服务器命令）
//   · 把 /state 整理成中文状态文本
// 账号密码从 .env 读：MC_BOT_USER（默认 xiaona）、MC_BOT_PASSWORD。
// ============================================================
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { ROOT } from './paths.js';

const HOST = '127.0.0.1';
const CTL_PORT = Number(process.env.MC_BOT_CTL_PORT || 2319) || 2319;
const SCRIPT = path.join(ROOT, 'src', 'mcheadless', 'headless.js');
const STATE_FILE = path.join(ROOT, 'data', 'mcbot-state.json');
const START_TIMEOUT_MS = 20000;

let child = null;
let starting = null;

// ---------- 纯函数（方便单测） ----------
/** "host:port" / "host" + port → { host, port } */
export function parseTarget(address, port) {
  let host = String(address || '').trim();
  if (!host) throw new Error('服务器地址不能为空');
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  let p = Number(port) || 0;
  const m = host.match(/^([^\s:]+):(\d+)$/);
  if (m) {
    host = m[1];
    p = Number(m[2]);
  }
  if (!p) p = 25565;
  if (!(p >= 1 && p <= 65535)) throw new Error(`端口不合法：${p}`);
  return { host, port: p };
}

/** /state 返回的 JSON → 给人看的中文状态 */
export function formatStatus(st) {
  if (!st) return 'MC 客户端还没启动；要进服先用 mcbot_join。';
  const srv = st.server || {};
  const addr = srv.host ? `${srv.host}:${srv.port}` : '未指定';
  if (!st.spawned) {
    if (srv.wantConnect && st.connected) return `正在进入 ${addr}（已连上，等待出生）`;
    if (srv.wantConnect) return `正在连接 ${addr}（认证：${st.auth || '未知'}）`;
    return '当前不在服务器里；可用 mcbot_join 进服。';
  }
  const lines = [];
  lines.push(`服务器：${addr}（${srv.version || '未知版本'}）`);
  lines.push(`坐标：${st.pos.x}, ${st.pos.y}, ${st.pos.z}${st.gamemode ? `（${st.gamemode}）` : ''}`);
  lines.push(`血量：${st.health ?? '?'}　饥饿：${st.food ?? '?'}　鞘翅：${st.elytraFlying ? '飞行中' : '未飞'}`);
  if (st.collect) lines.push(`收集：${st.collect.type} ${st.collect.done}/${st.collect.total}`);
  if (st.pvp) lines.push(`PvP：${st.pvp}`);
  if (st.mace) lines.push(`重锤：${st.mace}`);
  if (st.follow) lines.push(`跟随：${st.follow.name || st.follow.type || '目标'}`);
  if (st.mode && st.mode.kind) lines.push(`运行模式：${st.mode.kind}`);
  const inv = st.inventory && Object.keys(st.inventory).length
    ? Object.entries(st.inventory).slice(0, 15).map(([k, v]) => `${k}x${v}`).join('、')
    : '空';
  lines.push(`背包：${inv}`);
  if (Array.isArray(st.players) && st.players.length) {
    const list = st.players.slice(0, 10).map((p) => `${p.name}(${Math.round(p.distance)}格)`).join('、');
    lines.push(`附近玩家（${st.players.length}）：${list}`);
  } else {
    lines.push('附近玩家：无');
  }
  return lines.join('\n');
}

// ---------- 子进程 ----------
function baseUrl() {
  return `http://${HOST}:${CTL_PORT}`;
}

async function http(pathname, { method = 'GET', body = null, timeout = 20000 } = {}) {
  const res = await fetch(baseUrl() + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error((json && (json.error || json.reply)) || `HTTP ${res.status}`);
  return json || {};
}

async function alive() {
  try {
    await http('/state', { timeout: 1200 });
    return true;
  } catch {
    return false;
  }
}

function wireChild(c) {
  const feed = (tag) => (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (line.trim()) logger.info(`[MCbot${tag}] ${line}`);
    }
  };
  c.stdout.on('data', feed(''));
  c.stderr.on('data', feed(':err'));
  c.on('exit', (code, sig) => {
    logger.info(`[MCbot] 子进程退出（${sig || code}）`);
    if (child === c) child = null;
  });
}

/** 确保 headless 子进程在跑（幂等，并发调用共用同一个启动流程） */
async function ensureStarted() {
  if (await alive()) return;
  if (starting) return starting;
  starting = (async () => {
    if (!fs.existsSync(SCRIPT)) throw new Error(`找不到 MC 客户端脚本：${SCRIPT}`);
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const env = {
      ...process.env,
      MC_AUTOCONNECT: 'false', // 进服由 join 指令决定
      MC_CTL_PORT: String(CTL_PORT),
      MC_USER: String(process.env.MC_BOT_USER || 'xiaona').trim(),
      MC_PASSWORD: process.env.MC_BOT_PASSWORD || process.env.MC_PASSWORD || '',
      MC_STATE_FILE: STATE_FILE,
    };
    logger.info(`[MCbot] 启动客户端（用户 ${env.MC_USER}，控制口 ${CTL_PORT}）`);
    child = spawn(process.execPath, [SCRIPT], {
      cwd: path.dirname(SCRIPT),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    wireChild(child);
    const t0 = Date.now();
    while (Date.now() - t0 < START_TIMEOUT_MS) {
      if (await alive()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('MC 客户端启动超时（20 秒内控制口没起来）');
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

async function sendCmd(cmd) {
  const r = await http('/cmd', { method: 'POST', body: { cmd }, timeout: 30000 });
  if (r && r.ok === false) throw new Error(r.error || '执行失败');
  const reply = String(r.reply || '').trim();
  if (r.pending) return `${reply || '指令已接受'}（后台执行中，稍后用 mcbot_status 看进度）`;
  return reply || '完成';
}

/** 需要已经在游戏里的操作：先看 /state，不在服里直接给出明确提示 */
async function requireOnline() {
  if (!(await alive())) throw new Error('小钠还没进服务器，先用 mcbot_join 进去');
  const st = await http('/state', { timeout: 2000 });
  if (!st || !st.spawned) throw new Error('小钠现在不在服务器里，先用 mcbot_join 进去');
  return st;
}

// ---------- 对外能力 ----------
export async function join(address, port, version) {
  const t = parseTarget(address, port);
  await ensureStarted();
  const v = String(version || '').trim();
  const r = await sendCmd(`join ${t.host} ${t.port}${v ? ` ${v}` : ''}`);
  return `正在进入 ${t.host}:${t.port}：${r}`;
}

export async function leave() {
  if (!(await alive())) return '小钠当前没有在服务器里。';
  const r = await sendCmd('leave');
  return `已退出服务器：${r}`;
}

export async function status() {
  if (!(await alive())) return formatStatus(null);
  try {
    const st = await http('/state', { timeout: 2000 });
    return formatStatus(st);
  } catch (e) {
    return `MC 客户端状态读取失败：${e.message}`;
  }
}

export async function chat(text) {
  const msg = String(text || '').trim();
  if (!msg) throw new Error('要发送的内容不能为空');
  await requireOnline();
  const r = await sendCmd(`say ${msg}`);
  return `已在游戏里发言：${msg}（${r}）`;
}

export async function command(command) {
  const c = String(command || '').trim();
  if (!c) throw new Error('命令不能为空');
  await requireOnline();
  return sendCmd(`srvcmd ${c}`);
}

/** 任务指令：goto / fly / collect / pvp / mace / develop / follow / stop / xray / toss 等 */
export async function run(command) {
  const c = String(command || '').trim();
  if (!c) throw new Error('指令不能为空');
  await requireOnline();
  return sendCmd(c);
}

export async function stop() {
  if (!(await alive())) return '小钠当前没有在服务器里。';
  return sendCmd('stop');
}

export async function nearbyPlayers(radius) {
  const r = Math.max(1, Math.min(Number(radius) || 64, 256));
  const st = await requireOnline();
  const list = (st.players || []).filter((p) => p.distance <= r);
  if (!list.length) return `${r} 格内没有看到其他玩家。`;
  return `看到 ${list.length} 名玩家：\n${list
    .map((p) => `${p.name}：距离 ${Math.round(p.distance)} 格`)
    .join('\n')}`;
}

export async function inventory() {
  const st = await requireOnline();
  const inv = st.inventory || {};
  const keys = Object.keys(inv);
  if (!keys.length) return '背包是空的。';
  return `背包（${keys.length} 种）：\n${keys.map((k) => `${k} x${inv[k]}`).join('\n')}`;
}

// 机器人进程退出时把子进程带走，避免留下孤立的 MC 客户端
process.once('exit', () => {
  try { child?.kill('SIGKILL'); } catch { /* 已经退出 */ }
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    try { child?.kill('SIGTERM'); } catch { /* 已经退出 */ }
  });
}
