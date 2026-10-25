// ============================================================
// start.js - 合并启动器（SnowLuma 版）
// 由 启动.bat / background.vbs 调用（node start.js）
//
// 流程：准备 SnowLuma 配置 → 确保 QQ 在跑（未登录由桌面扫码）→ 启动 SnowLuma
//       → 启动机器人（机器人自己会反复重连 OneBot WS，不必等登录完成）
//
// 说明：SnowLuma 是注入真实 QQ.exe 的 OneBot v11 框架，只能扫码登录；
//       它只有在 QQ 登录成功后才会监听 OneBot WS 端口，所以面板可能先显示"未登录"。
// ============================================================
import { spawn, execFile } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { writeJsonAtomic } from './src/datafile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// ---------- SnowLuma / OneBot 连接参数 ----------
const SNOWLUMA_DIR = path.join(__dirname, 'snowluma');
const SNOWLUMA_ENTRY = path.join(SNOWLUMA_DIR, 'index.mjs');
const SNOWLUMA_CONFIG_DIR = path.join(SNOWLUMA_DIR, 'config');
const SNOWLUMA_GLOBAL_CONFIG = path.join(SNOWLUMA_CONFIG_DIR, 'onebot.json');

// ONEBOT_WS 是机器人侧的连接地址；旧版 .env 里的 NAPCAT_WS 仍兼容
const ONEBOT_WS = String(process.env.ONEBOT_WS || process.env.NAPCAT_WS || 'ws://127.0.0.1:3001').trim();
const WS_PORT = Number((ONEBOT_WS.match(/:(\d+)/) || [])[1] || 3001);
let onebotToken = String(process.env.ONEBOT_TOKEN || process.env.NAPCAT_TOKEN || '').trim();

// .env 未指定 QQ 路径时用 Windows 默认安装位置
const QQ_PATH_DEFAULT = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';

// 本地语音识别服务（FunASR）：默认 http://127.0.0.1:8899/v1/audio/transcriptions
const ASR_ENABLED = String(process.env.ASR_ENABLED || 'true').trim().toLowerCase() !== 'false';
const ASR_URL = String(process.env.ASR_URL || 'http://127.0.0.1:8899/v1/audio/transcriptions').trim();

// ---------- 控制台时间戳 ----------
// 启动器自己的提示不加（交互提示加时间反而碍事），
// 从子进程管道过来的运行日志（[SnowLuma] / [Bot]）要带时间，方便和日志文件对齐。
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- SnowLuma 配置：固定 WS 端口 / token ----------
/**
 * 读写 SnowLuma 的 OneBot 配置：
 * - 全局 config/onebot.json 里固定 ws-default 的 host/port/token/messageFormat
 * - 已存在的按账号配置（onebot_<uin>.json，snapshot 模式会完全覆盖全局）也同步一份，
 *   否则换号后旧的端口/token 会把机器人挡在门外
 *
 * token 优先级：.env 的 ONEBOT_TOKEN > 配置里已有的 > 随机生成（写回配置，重启不变）
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function ensureNetworks(cfg) {
  if (!cfg.networks || typeof cfg.networks !== 'object') cfg.networks = {};
  if (!Array.isArray(cfg.networks.wsServers)) cfg.networks.wsServers = [];
  if (!Array.isArray(cfg.networks.httpServers)) cfg.networks.httpServers = [];
  return cfg.networks;
}

function applyWsEntry(entry) {
  entry.name = 'ws-default';
  entry.host = '127.0.0.1';
  entry.port = WS_PORT;
  entry.path = '/';
  entry.role = 'Universal';
  entry.messageFormat = 'array';
  entry.accessToken = onebotToken;
}

function ensureOneBotConfig() {
  fs.mkdirSync(SNOWLUMA_CONFIG_DIR, { recursive: true });

  // 1) 全局配置：确定 token
  const rawGlobal = readJson(SNOWLUMA_GLOBAL_CONFIG);
  const original = rawGlobal ? JSON.stringify(rawGlobal) : '';
  const global = rawGlobal || {};
  const nets = ensureNetworks(global);
  let ws = nets.wsServers.find((s) => s && s.name === 'ws-default');
  if (!ws) {
    ws = {};
    nets.wsServers.push(ws);
  }
  // .env 配了就用 .env；没配则沿用配置里已有的；都没有才生成
  if (!onebotToken) onebotToken = String(ws.accessToken || '').trim();
  if (!onebotToken) onebotToken = crypto.randomBytes(32).toString('base64url');

  applyWsEntry(ws);
  if (JSON.stringify(global) !== original) writeJsonAtomic(SNOWLUMA_GLOBAL_CONFIG, global);

  // 2) 按账号的覆盖配置：只同步 ws-default，别的设置不动
  let files = [];
  try {
    files = fs.readdirSync(SNOWLUMA_CONFIG_DIR).filter((f) => /^onebot_\d+\.json$/.test(f));
  } catch { /* 目录读不了就算了 */ }
  for (const f of files) {
    const file = path.join(SNOWLUMA_CONFIG_DIR, f);
    const cfg = readJson(file);
    if (!cfg) continue;
    const wsList = cfg.networks && Array.isArray(cfg.networks.wsServers) ? cfg.networks.wsServers : null;
    if (!wsList) continue;
    const item = wsList.find((s) => s && s.name === 'ws-default');
    if (!item) continue;
    const beforeUin = JSON.stringify(cfg);
    applyWsEntry(item);
    if (JSON.stringify(cfg) !== beforeUin) writeJsonAtomic(file, cfg);
  }

  console.log(`[启动器] SnowLuma 配置已就绪：WS 127.0.0.1:${WS_PORT}（token ${onebotToken ? '已设置' : '未设置'}）`);
}

// ---------- 确认 QQ 进程 ----------
function qqPath() {
  return String(process.env.QQ_PATH || '').trim() || QQ_PATH_DEFAULT;
}

/** tasklist 判断 QQ.exe 是否在跑（不依赖进程权限，普通用户也能查） */
function isQQRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && /QQ\.exe/i.test(String(stdout || '')));
    });
  });
}

/**
 * 确保桌面 QQ 在跑：SnowLuma 靠注入 QQ.exe 工作，没有 QQ 就没有 OneBot。
 * 不负责登录（扫码只能在桌面完成），登录后 SnowLuma 会自动注入。
 * QQ_AUTOLAUNCH=false 时只提示、不代启。
 */
async function ensureQQ() {
  if (await isQQRunning()) {
    console.log('[启动器] QQ 已在运行，等待 SnowLuma 注入…');
    return;
  }
  if (String(process.env.QQ_AUTOLAUNCH || 'true').trim().toLowerCase() === 'false') {
    console.log('[启动器] QQ 未运行，且 QQ_AUTOLAUNCH=false：请手动启动 QQ 并登录。');
    return;
  }
  const exe = qqPath();
  if (!fs.existsSync(exe)) {
    console.log(`[启动器] 未找到 QQ：${exe}（可在 .env 里用 QQ_PATH 指定）`);
    return;
  }
  console.log(`[启动器] QQ 未运行，正在启动：${exe}`);
  const proc = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
  proc.on('error', (e) => console.log(`[启动器] 启动 QQ 失败：${e.message}`));
  proc.unref();
}

// ---------- 启动 SnowLuma ----------
function spawnSnowluma() {
  // HOOK_AUTOLOAD 保证 QQ 一登录就注入，不必在 SnowLuma 控制台手动点
  const env = { ...process.env, SNOWLUMA_HOOK_AUTOLOAD: '1' };
  const proc = spawn(process.execPath, ['index.mjs'], { cwd: SNOWLUMA_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((l) => l.trim() && console.log(`${stamp()} [SnowLuma] ${l.trim()}`));
  };
  proc.stdout.on('data', pipe);
  proc.stderr.on('data', pipe);
  console.log(`[启动器] SnowLuma 已启动（pid=${proc.pid || '未知'}）`);
  return proc;
}

// ---------- 等待 WS 端口就绪（仅用于日志提示，机器人自己会重连） ----------
function waitPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryConn = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('timeout'));
        else setTimeout(tryConn, 1500);
      });
    };
    tryConn();
  });
}

// ---------- 本地语音识别服务（FunASR） ----------
// 后台隐藏运行时控制台输出看不到，ASR 的启动过程单独记一份文件日志，方便排查
const ASR_LOG = path.join(__dirname, 'logs', 'asr-service.log');
function asrLog(msg) {
  const line = `${stamp()} ${msg}`;
  console.log(`[启动器] ${msg}`);
  try { fs.appendFileSync(ASR_LOG, line + '\r\n'); } catch { /* 日志写不了就算了 */ }
}

/** 端口是否已被监听（ASR 已由别人/上次启动拉起来时就不用再起一个） */
function portIsOpen(port, timeoutMs = 1200) {
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

/** 从 ASR_URL 取本机端口；配的是外部地址则返回 0（外部服务不归启动器管） */
function asrLocalPort() {
  try {
    const u = new URL(ASR_URL);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return 0;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return 0;
  }
}

/**
 * 确保本地语音识别服务在跑：没在跑就隐藏启动 asr-venv 里的 funasr-server。
 * 以前只能靠手动双击 startASR.bat，开机/重启后经常忘，语音就全变成 [语音] 占位。
 * 起不来只记一行日志，不影响机器人本体。
 */
async function ensureAsrService() {
  if (!ASR_ENABLED) return null;
  const port = asrLocalPort();
  if (!port) { asrLog('语音识别指向外部地址，启动器不拉起本地服务'); return null; }
  if (await portIsOpen(port)) {
    asrLog(`语音识别服务已在运行（127.0.0.1:${port}）`);
    return null;
  }
  const exe = path.join(__dirname, 'asr-venv', 'Scripts', 'funasr-server.exe');
  if (!fs.existsSync(exe)) {
    asrLog('未找到本地语音识别服务（asr-venv\\Scripts\\funasr-server.exe），语音消息将只显示 [语音]');
    return null;
  }
  asrLog(`启动本地语音识别服务（FunASR SenseVoice，端口 ${port}），模型加载需要十几秒...`);
  const proc = spawn(
    exe,
    ['--host', '127.0.0.1', '--port', String(port), '--model', 'sensevoice', '--device', 'cpu'],
    { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  asrLog(`语音识别服务进程已拉起（pid=${proc.pid || '未知'}）`);
  const pipe = (chunk) => String(chunk).split(/\r?\n/).forEach((l) => l.trim() && asrLog(`[ASR] ${l.trim()}`));
  proc.stdout.on('data', pipe);
  proc.stderr.on('data', pipe);
  proc.on('error', (e) => asrLog(`语音识别服务启动失败：${e.message}`));
  proc.on('exit', (code) => asrLog(`语音识别服务已退出（code=${code}），语音消息将只显示 [语音]`));
  return proc;
}

// ---------- 启动机器人（index.js：含网页控制面板、MC桥、QQ 逻辑） ----------
function spawnBot() {
  // OneBot 连接参数直接注给机器人，避免它去猜 SnowLuma 配置里的 token
  const env = { ...process.env, ONEBOT_WS, ONEBOT_TOKEN: onebotToken };
  const bot = spawn(process.execPath, ['src/index.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // 机器人自己的日志已经带时间戳（logger.js），这里只加来源前缀，避免出现两个时间
  const pipe = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((l) => l.trim() && console.log(`[Bot] ${l.trim()}`));
  };
  bot.stdout.on('data', pipe);
  bot.stderr.on('data', pipe);
  return bot;
}

// ---------- 进程联动：任一退出则关闭另一个并退出 ----------
function linkExit(bot, snowluma) {
  bot.on('exit', (code) => {
    console.log(`[启动器] 机器人已退出（code=${code}），关闭 SnowLuma...`);
    try { snowluma.kill(); } catch {}
    process.exit(code || 0);
  });
  snowluma.on('exit', (code) => {
    console.log(`[启动器] SnowLuma 已退出（code=${code}），关闭机器人...`);
    try { bot.kill(); } catch {}
    process.exit(code || 0);
  });
}

async function main() {
  console.log('==========================================');
  console.log('     小钠 QQ 机器人 · 启动器（SnowLuma）');
  console.log('==========================================');

  if (!fs.existsSync(SNOWLUMA_ENTRY)) {
    console.error(`[启动器] 缺少 ${SNOWLUMA_ENTRY}，请先下载 SnowLuma 并放到项目根的 snowluma/ 目录。`);
    process.exit(1);
  }

  // 语音识别服务模型加载十几秒，先异步拉起来，不阻塞 QQ / 机器人
  ensureAsrService().catch(() => {});

  ensureOneBotConfig();
  await ensureQQ();

  const snowluma = spawnSnowluma();
  // 机器人先起来：面板立刻可用，且 MC 桥/定时任务不必等 QQ 登录。
  // 它自己每 3 秒重连一次 OneBot WS，SnowLuma 登录成功后自然连上。
  const bot = spawnBot();
  linkExit(bot, snowluma);

  try {
    await waitPort(WS_PORT, 180000);
    console.log(`[启动器] SnowLuma OneBot WS 端口 ${WS_PORT} 已就绪。`);
  } catch {
    console.log('[启动器] 等待 SnowLuma WS 超时（可能还没扫码登录），机器人会继续自动重连。');
  }
}

main().catch((e) => { console.error('[启动器] 出错:', e.message); process.exit(1); });
