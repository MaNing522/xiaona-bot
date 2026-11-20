// ============================================================
// updateWatchdog.js - 更新重启看门狗
//
// 由 bot 在 pm2 restart 前以 detached 方式拉起，参数：
//   node src/updateWatchdog.js <oldHead> <newHead> <pm2进程名>
// 新版本 90 秒内没起来（面板 /health 不通且 PM2 未稳定在线）就：
//   1. git reset --hard 回旧版本（先备份 config.json，回滚后原样放回）
//   2. 在 restart-notice.json 里标 failed，让重启后的机器人回原会话说一声
//   3. pm2 restart 拉起旧版本
// 正常起来则什么也不做，直接退出。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { execFileSync, spawn } from 'node:child_process';
import { ROOT } from './paths.js';

const [oldHead, newHead, pm2Name = 'xiaona-bot'] = process.argv.slice(2);
const NOTICE = path.join(ROOT, 'data', 'restart-notice.json');
const LOG = path.join(ROOT, 'logs', 'update-watchdog.log');
const httpsOn = String(process.env.WEBUI_HTTPS || '').toLowerCase() === 'true';
const rawHost = process.env.WEBUI_HOST || '127.0.0.1';
const host = rawHost === '0.0.0.0' ? '127.0.0.1' : rawHost;
const port = Number(process.env.WEBUI_PORT) || (httpsOn ? 443 : 80);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* 日志写不了不影响回滚 */ }
}

function runtimePort() {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'webui-port.json'), 'utf8'));
    if (Number(w.port) > 0) return { port: Number(w.port), https: !!w.https };
  } catch { /* 还没写过就按 .env 猜 */ }
  return { port, https: httpsOn };
}

function httpHealthy(rt) {
  return new Promise((resolve) => {
    const mod = rt.https ? https : http;
    const req = mod.request({
      host,
      port: rt.port,
      path: '/health',
      method: 'GET',
      timeout: 2500,
      rejectUnauthorized: false, // 自签证书
    }, (res) => {
      // 只要能拿到我们 /health 的 JSON 就算起来了（QQ 未连时是 503，也说明进程活着）
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 4096) data += c; });
      res.on('end', () => resolve(/"uptime"\s*:/.test(data)));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** PM2 里已稳定在线超过 60 秒（面板端口被改 / 健康检查走不通时的兜底） */
function pm2Stable() {
  try {
    const out = execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] });
    const list = JSON.parse(out || '[]');
    const p = list.find((x) => x && x.name === pm2Name);
    const env = p && p.pm2_env;
    return !!(env && env.status === 'online' && Date.now() - Number(env.pm_uptime || 0) > 60000);
  } catch {
    return false;
  }
}

function writeFailed(reason) {
  let n = null;
  try { n = JSON.parse(fs.readFileSync(NOTICE, 'utf8')); } catch { /* 没有通知就不写 */ }
  if (!n || !n.id) return;
  n.failed = true;
  n.error = String(reason || '').slice(0, 300);
  n.at = Date.now();
  try {
    fs.mkdirSync(path.dirname(NOTICE), { recursive: true });
    const tmp = NOTICE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(n));
    fs.renameSync(tmp, NOTICE);
  } catch (e) {
    log('写失败通知出错: ' + e.message);
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    log(`git ${args.join(' ')} 失败: ${String(e.stderr || e.message).slice(0, 200)}`);
    return null;
  }
}

/** 绕过机器人，直接通过 OneBot WS 到原会话说一声（回滚后旧版本代码不认识 failed 标记） */
function sendOneBot(n, text) {
  return new Promise((resolve) => {
    const url = process.env.ONEBOT_WS || process.env.NAPCAT_WS || 'ws://127.0.0.1:3001';
    const token = process.env.ONEBOT_TOKEN || process.env.NAPCAT_TOKEN || '';
    let ws;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* 已关闭 */ }
      resolve(ok);
    };
    try {
      ws = new WebSocket(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        handshakeTimeout: 5000,
      });
    } catch {
      return resolve(false);
    }
    const params = n.type === 'group'
      ? { group_id: Number(n.id), message: [{ type: 'text', data: { text } }] }
      : { user_id: Number(n.id), message: [{ type: 'text', data: { text } }] };
    ws.on('open', () => {
      ws.send(JSON.stringify({
        action: n.type === 'group' ? 'send_group_msg' : 'send_private_msg',
        params,
        echo: 'update-watchdog',
      }));
    });
    ws.on('message', (raw) => {
      try {
        const j = JSON.parse(String(raw));
        if (j.echo === 'update-watchdog') finish(j.status === 'ok' || j.retcode === 0);
      } catch { /* 忽略非 JSON */ }
    });
    ws.on('error', () => finish(false));
    ws.on('close', () => finish(false));
    setTimeout(() => finish(false), 8000);
  });
}

async function notifyFailure(n, text) {
  for (let i = 0; i < 3; i++) {
    if (await sendOneBot(n, text)) return true;
    await sleep(2000);
  }
  return false;
}

async function main() {
  if (!oldHead || !newHead) return;
  // 先给新进程留出启动时间，再开始探活
  await sleep(15000);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (await httpHealthy(runtimePort()) || pm2Stable()) {
      log(`新版本 ${newHead} 已正常启动`);
      return;
    }
    await sleep(3000);
  }

  // 只回滚自己更新的那个版本，避免误伤后来手动改的代码
  const head = git(['rev-parse', '--short', 'HEAD']);
  if (head !== newHead) {
    log(`当前 HEAD=${head} 已不是新版本 ${newHead}，不执行回滚`);
    return;
  }
  log(`新版本 ${newHead} 90 秒内未就绪，回滚到 ${oldHead}`);

  let cfg = null;
  try { cfg = fs.readFileSync(path.join(ROOT, 'config.json')); } catch { /* 没配置就算了 */ }
  if (git(['reset', '--hard', oldHead]) === null) {
    writeFailed('回滚失败：git reset 出错');
    return;
  }
  if (cfg) {
    try { fs.writeFileSync(path.join(ROOT, 'config.json'), cfg); } catch { /* 恢复配置失败不阻塞重启 */ }
  }
  writeFailed(`新版本 ${newHead} 启动失败，已回滚到 ${oldHead}`);

  // 旧版本代码不认识 failed 标记，这里直接通过 OneBot 回原会话通知；发完删掉通知避免旧版重复报“重启完成”
  let n = null;
  try { n = JSON.parse(fs.readFileSync(NOTICE, 'utf8')); } catch { /* 没记会话就不通知 */ }
  if (n && n.id) {
    const ok = await notifyFailure(n, '刚才更新没成功，我已经退回上一个版本了，现在能正常说话。');
    log(ok ? '已通知原会话回滚结果' : '回滚通知发送失败（OneBot 未就绪）');
  }
  try { fs.unlinkSync(NOTICE); } catch { /* 没有就算了 */ }

  try {
    const child = spawn('pm2', ['restart', pm2Name, '--update-env'], { detached: true, stdio: 'ignore' });
    child.unref();
    log(`已重启 ${pm2Name} 使用旧版本 ${oldHead}`);
  } catch (e) {
    log('pm2 restart 失败: ' + e.message);
  }
}

main().catch((e) => log('看门狗异常: ' + (e && e.stack ? e.stack : e)));
