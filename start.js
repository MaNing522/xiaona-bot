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
import { writeJsonAtomic, readJsonSafe } from './datafile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const NAPCAT_DIR = path.join(__dirname, 'napcat');
const NODE_BIN = path.join(NAPCAT_DIR, 'node.exe');
const QR_FILE = path.join(NAPCAT_DIR, 'napcat', 'cache', 'qrcode.png');
const LOGIN_FILE = path.join(__dirname, 'data', 'login.json');
const WS_PORT = Number((process.env.NAPCAT_WS || 'ws://127.0.0.1:3001').match(/:(\d+)/)?.[1] || 3001);

const AUTO_TIMEOUT = 25000; // 自动登录最长等待

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
    String(chunk).split(/\r?\n/).forEach((l) => l.trim() && console.log(`[NapCat] ${l.trim()}`));
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

// ---------- 启动机器人并联动退出 ----------
async function startBot(napcat) {
  try {
    await waitPort(WS_PORT, 120000);
    console.log(`[启动器] NapCat WS 端口 ${WS_PORT} 已就绪，启动机器人...`);
  } catch {
    console.log('[启动器] 等待 NapCat WS 超时，仍尝试启动机器人（机器人会自动重连）。');
  }
  const bot = spawn(process.execPath, ['index.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((l) => l.trim() && console.log(`[Bot] ${l.trim()}`));
  };
  bot.stdout.on('data', pipe);
  bot.stderr.on('data', pipe);
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

// ---------- 自动登录尝试 ----------
async function tryAutoLogin(qq) {
  console.log(`🔄 尝试自动登录（QQ ${qq} 快速登录）...`);
  // 上一次手动登录留下的二维码图片会让 watchAutoLogin 里的"出现二维码即视为失败"
  // 立刻误判（文件本来就在），快速登录还没开始就被打断、直接掉进手动登录。
  // 每次尝试前先清掉，只认本次真正新生成的二维码。
  try { fs.unlinkSync(QR_FILE); } catch { /* 本来就没有 */ }
  const proc = spawnNapcat({ ...process.env, NAPCAT_QUICK_ACCOUNT: String(qq) });
  const res = await watchAutoLogin(proc, AUTO_TIMEOUT);
  if (res.ok) {
    console.log('✅ 自动登录成功。');
    saveLogin(qq);
    await startBot(proc);
    return true;
  }
  console.log(`⚠️ 自动登录未成功（${res.reason}），停止该进程，改用手动登录。`);
  try { proc.kill(); } catch {}
  return false;
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

async function manualLogin() {
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
  await startBot(napcat);
}

async function main() {
  console.log('==========================================');
  console.log('     小钠 QQ 机器人 · 启动器');
  console.log('==========================================');
  const saved = readSaved();
  if (saved) {
    console.log(`ℹ️ 上次成功登录的账号：${saved.qq}（手动登录时直接回车即可沿用）`);
    if (await tryAutoLogin(saved.qq)) return;
  } else {
    console.log('ℹ️ 未找到历史登录账号，进入手动登录。');
  }
  await manualLogin();
}

main().catch((e) => { console.error('[启动器] 出错:', e.message); process.exit(1); });
