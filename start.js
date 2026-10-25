// ============================================================
// start.js - 合并启动器：先尝试自动登录(快速登录)，不行再让用户选择登录方式
// 由 启动.bat 调用（node start.js）
// ============================================================
import { spawn } from 'child_process';
import net from 'net';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { writeJsonAtomic, readJsonSafe } from './src/datafile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const NAPCAT_DIR = path.join(__dirname, 'napcat');
const NODE_BIN = path.join(NAPCAT_DIR, 'node.exe');
const QR_FILE = path.join(NAPCAT_DIR, 'napcat', 'cache', 'qrcode.png');
const LOGIN_FILE = path.join(__dirname, 'data', 'login.json');
const WS_PORT = Number((process.env.NAPCAT_WS || 'ws://127.0.0.1:3001').match(/:(\d+)/)?.[1] || 3001);

// 本地语音识别服务（FunASR）：默认 http://127.0.0.1:8899/v1/audio/transcriptions
const ASR_ENABLED = String(process.env.ASR_ENABLED || 'true').trim().toLowerCase() !== 'false';
const ASR_URL = String(process.env.ASR_URL || 'http://127.0.0.1:8899/v1/audio/transcriptions').trim();

const AUTO_TIMEOUT = 25000; // 自动登录最长等待
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 控制台时间戳 ----------
// 启动器自己的提示不加（交互提示加时间反而碍事），
// 但从子进程管道过来的运行日志（[NapCat] / [Bot]）要带时间，方便和日志文件对齐。
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 历史登录账号（供自动登录） ----------
function readSaved() {
  const d = readJsonSafe(LOGIN_FILE, null, 'login.json');
  return d && /^\d{5,14}$/.test(String(d.qq)) ? d : null;
}
function saveLogin(qq) {
  writeJsonAtomic(LOGIN_FILE, { qq: String(qq), at: Date.now() });
}

// ---------- 启动 NapCat（日志带前缀输出到终端） ----------
function spawnNapcat(env) {
  // 固定 NapCat 面板（6099）的登录 token 与会话密钥：
  // - NAPCAT_WEBUI_SECRET_KEY：面板登录密码（账号固定是 napcat）；NapCat 检测到它会写回 webui.json
  // - NAPCAT_WEBUI_JWT_SECRET_KEY：面板会话签名密钥。**不固定的话 NapCat 每次启动都用
  //   Math.random() 现生成一个**，一重启所有登录会话就失效 —— 表现就是"每次都得重新输 token"
  if (process.env.NAPCAT_WEBUI_TOKEN) env.NAPCAT_WEBUI_SECRET_KEY = process.env.NAPCAT_WEBUI_TOKEN;
  if (process.env.NAPCAT_WEBUI_JWT_SECRET) env.NAPCAT_WEBUI_JWT_SECRET_KEY = process.env.NAPCAT_WEBUI_JWT_SECRET;
  const args = ['./index.js'];
  const qq = env.NAPCAT_QUICK_ACCOUNT;
  if (qq) args.push('-q', String(qq));
  const proc = spawn(NODE_BIN, args, { cwd: NAPCAT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((l) => l.trim() && console.log(`${stamp()} [NapCat] ${l.trim()}`));
  };
  proc.stdout.on('data', pipe);
  proc.stderr.on('data', pipe);
  return proc;
}

// ---------- 监听登录结果：成功 / 需要验证 / 出二维码 / 超时 / 退出 ----------
function watchAutoLogin(proc, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearInterval(iv);
      proc.stdout.removeAllListeners('data');
      proc.stderr.removeAllListeners('data');
      resolve(r);
    };
    const feed = (chunk) => {
      buf += chunk;
      if (buf.length > 300000) buf = buf.slice(-300000);
      if (/登录成功|快速登录成功|密码回退登录成功|已登录/.test(buf)) finish({ ok: true, reason: 'success' });
      else if (/需要验证|验证码|滑块|异常设备|新设备|登录失败|扫码|二维码/.test(buf)) finish({ ok: false, reason: 'verify' });
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    // 出现二维码文件也视为自动登录未成功（回退到扫码）
    const iv = setInterval(() => { if (fs.existsSync(QR_FILE)) finish({ ok: false, reason: 'qr' }); }, 800);
    setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    proc.on('exit', () => finish({ ok: false, reason: 'exit' }));
  });
}

// ---------- 等待 WS 端口就绪 ----------
function waitPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryConn = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('timeout'));
        else setTimeout(tryConn, 1000);
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
  const bot = spawn(process.execPath, ['src/index.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  // 机器人自己的日志已经带时间戳（logger.js），这里只加来源前缀，避免出现两个时间
  const pipe = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((l) => l.trim() && console.log(`[Bot] ${l.trim()}`));
  };
  bot.stdout.on('data', pipe);
  bot.stderr.on('data', pipe);
  return bot;
}

// ---------- 进程联动：任一退出则关闭另一个并退出 ----------
function linkExit(bot, napcat) {
  bot.on('exit', (code) => {
    console.log(`[启动器] 机器人已退出（code=${code}），关闭 NapCat...`);
    try { napcat.kill(); } catch {}
    process.exit(code || 0);
  });
  napcat.on('exit', (code) => {
    console.log(`[启动器] NapCat 已退出（code=${code}），关闭机器人...`);
    try { bot.kill(); } catch {}
    process.exit(code || 0);
  });
}

// ---------- 启动机器人并联动退出（先等 NapCat WS 就绪） ----------
async function startBot(napcat) {
  try {
    await waitPort(WS_PORT, 120000);
    console.log(`[启动器] NapCat WS 端口 ${WS_PORT} 已就绪，启动机器人...`);
  } catch {
    console.log('[启动器] 等待 NapCat WS 超时，仍尝试启动机器人（机器人会自动重连）。');
  }
  const bot = spawnBot();
  linkExit(bot, napcat);
}

// ---------- 自动登录尝试 ----------
// 只负责把 NapCat 跑起来并判断登录结果；拿到进程句柄后由调用方决定何时起机器人。
// 返回 { ok, proc }：proc 不为空 = NapCat 进程仍然活着（已登录，或正在等扫码/验证）。
async function tryAutoLoginNapcat(qq) {
  // 快速登录失败时常见两种可继续的状态：
  //   qr     已经出了二维码，进程在等人扫
  //   verify 需要验证码/滑块，进程在等人操作
  // 这两种都**不能杀进程**——留着让用户在网页面板处理，杀了就等于把服务弄断。
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`🔄 尝试自动登录（QQ ${qq} 快速登录${attempt > 1 ? '，第 ' + attempt + ' 次' : ''}）...`);
    // 上一次手动登录留下的二维码图片会让 watchAutoLogin 里的"出现二维码即视为失败"
    // 立刻误判（文件本来就在），快速登录还没开始就被打断、直接掉进手动登录。
    // 每次尝试前先清掉，只认本次真正新生成的二维码。
    try { fs.unlinkSync(QR_FILE); } catch { /* 本来就没有 */ }
    const proc = spawnNapcat({ ...process.env, NAPCAT_QUICK_ACCOUNT: String(qq) });
    const res = await watchAutoLogin(proc, AUTO_TIMEOUT);
    if (res.ok) {
      console.log('✅ 自动登录成功。');
      saveLogin(qq);
      return { ok: true, proc };
    }
    if (res.reason === 'qr' || res.reason === 'verify') {
      console.log(`⚠️ 自动登录未完成（${res.reason === 'qr' ? '已出二维码，等待扫码' : '需要验证码/滑块'}）：NapCat 保持运行，请到网页面板完成登录。`);
      return { ok: false, proc };
    }
    console.log(`⚠️ 自动登录未成功（${res.reason}）。`);
    try { proc.kill(); } catch { /* 可能已退出 */ }
    // 刚重启时旧 QQ 进程可能还没完全退出，隔几秒重试一次
    if (attempt === 1 && res.reason === 'exit') {
      console.log('   旧进程可能还在退出中，6 秒后重试一次…');
      await sleep(6000);
      continue;
    }
    return { ok: false, proc: null };
  }
  return { ok: false, proc: null };
}

async function tryAutoLogin(qq) {
  const r = await tryAutoLoginNapcat(qq);
  if (!r.proc) return false;
  await startBot(r.proc);
  return true;
}

// ---------- 手动登录（账密 / 二维码） ----------
/**
 * 读取隐藏输入（密码）：逐字符读，回显 * 而不是明文。
 * 非交互环境（重定向/管道）无法关闭回显，退化为普通输入。
 */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl2 = readline.createInterface({ input: stdin, output: process.stdout });
      return rl2.question(prompt, (a) => { rl2.close(); resolve(a); });
    }
    const wasRaw = stdin.isRaw;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(!!wasRaw); } catch {}
      stdin.pause();
      process.stdout.write('\n');
      resolve(val);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish(buf);
        if (ch === '\u0003') {            // Ctrl+C：raw 模式下不会自动触发 SIGINT，这里自己处理
          finish('');
          console.log('[启动器] 已取消。');
          process.exit(1);
        }
        if (ch === '\u007f' || ch === '\b') {   // 退格
          if (buf) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue;            // 其它控制字符
        buf += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/** 登录真正成功后才记录账号（避免把输错的账号记成"上次成功登录"） */
function watchLoginSuccess(proc, qq) {
  if (!qq) return;
  let buf = '';
  let saved = false;
  const feed = (chunk) => {
    if (saved) return;
    buf = (buf + chunk).slice(-20000);
    if (/登录成功|快速登录成功|密码回退登录成功|已登录/.test(buf)) {
      saved = true;
      saveLogin(qq);
      console.log(`[启动器] 已记住本次登录账号 ${qq}，下次会自动填充。`);
    }
  };
  proc.stdout.on('data', feed);
  proc.stderr.on('data', feed);
}

// 只负责拿到 NapCat 登录进程（含终端交互），返回进程句柄；机器人由调用方决定何时起。
async function manualLoginNapcat() {
  const saved = readSaved();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const closeRl = () => { try { rl.close(); } catch {} };
  // 账号提示：有历史账号就作为默认值（直接回车即可）
  const qqHint = saved ? `（回车默认上次成功登录的 ${saved.qq}）` : '';

  console.log('请选择登录方式：');
  console.log('  1) 账密登录（配合验证码，日志会提示验证链接）');
  console.log('  2) 二维码登录（手机 QQ 扫码）');
  const choice = (await ask('请输入 1 或 2：')).trim();

  let qq = '', password = '';
  if (choice === '2') {
    qq = (await ask(`请输入要登录的 QQ 号${saved ? qqHint : '（留空则纯扫码）'}：`)).trim() || (saved ? saved.qq : '');
  } else if (choice === '1') {
    qq = (await ask(`请输入 QQ 号${qqHint}：`)).trim() || (saved ? saved.qq : '');
    closeRl();  // 先释放 stdin，才能接管回显
    if (!/^\d{5,14}$/.test(qq)) {
      console.log('❌ QQ 号格式不对（应为 5-14 位数字）。');
      process.exit(1);
    }
    password = (await askHidden('请输入密码（输入时不显示，不保存到磁盘）：')).trim();
    if (!password) {
      console.log('❌ 密码不能为空。');
      process.exit(1);
    }
  } else {
    console.log('无效选择，退出。');
    closeRl();
    process.exit(1);
  }
  closeRl();

  const env = { ...process.env };
  if (choice === '2' && qq) env.NAPCAT_QUICK_ACCOUNT = String(qq);
  if (choice === '1') {
    env.ACCOUNT = String(qq);
    env.NAPCAT_QUICK_ACCOUNT = String(qq);
    env.NAPCAT_QUICK_PASSWORD = password;   // 只经环境变量传给子进程，不落盘、不回显
  }

  console.log(`[启动器] 正在启动 NapCat（${choice === '1' ? '账密登录' : '二维码登录'}${qq ? '，QQ=' + qq : ''}）...`);
  const napcat = spawnNapcat(env);
  watchLoginSuccess(napcat, qq);
  return napcat;
}

async function manualLogin() {
  const napcat = await manualLoginNapcat();
  await startBot(napcat);
}

async function main() {
  console.log('==========================================');
  console.log('     小钠 QQ 机器人 · 启动器');
  console.log('==========================================');
  const saved = readSaved();
  if (saved) {
    console.log(`ℹ️ 上次成功登录的账号：${saved.qq}（手动登录时直接回车即可沿用）`);
  } else {
    console.log('ℹ️ 未找到历史登录账号，进入手动登录。');
  }

  // 语音识别服务如果不主动拉起，重启/开机后就一直没人启动，语音全变 [语音]。
  // 放在最前面异步启动，模型加载十几秒，不阻塞 NapCat 与机器人的启动。
  ensureAsrService().catch(() => {});

  // 网页控制面板启用时：先起机器人（面板立即可用），再进入 NapCat 登录。
  // 这样即使登录要扫码 / 验证码，用户也能先打开面板查看二维码、操作登录，
  // 而不是先被终端登录流程挡住。机器人起来后会自动重连 NapCat，无需担心先后。
  const webuiEnabled = !!String(process.env.WEBUI_PASSWORD || '').trim();
  if (webuiEnabled) {
    console.log('ℹ️ 已启用网页控制面板：先启动面板（机器人），再处理 NapCat 登录。');
    const bot = spawnBot();
    let napcat = null;
    if (saved) {
      const auto = await tryAutoLoginNapcat(saved.qq);
      if (auto.proc) napcat = auto.proc;   // 登录成功，或正在等扫码/验证：进程都留着
    }
    if (!napcat) {
      if (process.stdin.isTTY) {
        napcat = await manualLoginNapcat();
      } else {
        // 后台隐藏运行（计划任务 / background.vbs）没有可交互终端：
        // 绝不能在 stdin 上等输入，否则会一直卡着、NapCat 起不来，机器人连不上 3001。
        // 直接按二维码模式把 NapCat 跑起来，二维码在网页面板里显示。
        console.log('[启动器] 无交互终端（后台运行）：改用二维码登录，NapCat 保持运行，可在网页面板扫码。');
        const qq = saved ? String(saved.qq) : '';
        napcat = spawnNapcat({ ...process.env, ...(qq ? { NAPCAT_QUICK_ACCOUNT: qq } : {}) });
        watchLoginSuccess(napcat, qq);
      }
    }
    linkExit(bot, napcat);
    return;
  }

  if (saved) {
    if (await tryAutoLogin(saved.qq)) return;
  }
  await manualLogin();
}

main().catch((e) => { console.error('[启动器] 出错:', e.message); process.exit(1); });
