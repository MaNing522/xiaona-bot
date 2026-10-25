// ============================================================
// state.js - 跨模块共享运行时状态（供 WebUI 展示）
// ============================================================
export const bot = {
  connected: false, // 是否已连接 NapCat(OneBot WS)
  lastError: '',
};

export function setBotConnected(v) {
  bot.connected = !!v;
}
export function setBotError(msg) {
  bot.lastError = msg || '';
}

// ---------- 共享日志缓冲（终端 console 输出 → GUI 实时日志） ----------
export const logs = []; // 每行 {t, s}
const MAX_LOGS = 500;

export function pushLog(line) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  logs.push(`[${ts}] ${line}`);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

// ---------- 人工接管（三态：auto 自动 / manual 人工 / hybrid 混合） ----------
export const takeover = {
  modes: {},   // key -> 'manual'|'hybrid'（auto 不存储）
  msgs: [],    // 最近消息流（含所有会话，供 GUI 挑选）
  audit: [],   // 接管/恢复审计日志 [{key,from,to,by,t}]
};
export function takeoverMode(key) {
  return takeover.modes[String(key)] || 'auto';
}
export function setTakeoverMode(key, mode, by) {
  const k = String(key);
  const prev = takeoverMode(k);
  if (mode === 'auto') delete takeover.modes[k];
  else takeover.modes[k] = mode;
  if (mode !== prev) {
    takeover.audit.push({ key: k, from: prev, to: mode, by: by || 'gui', t: Date.now() });
    if (takeover.audit.length > 200) takeover.audit.splice(0, takeover.audit.length - 200);
  }
  return prev;
}
export function takeoverOn(key) {
  return takeoverMode(key) === 'manual'; // 仅人工模式暂停自动回复
}
export function pushTakeoverMsg(m) {
  takeover.msgs.push(m);
  if (takeover.msgs.length > 300) takeover.msgs.splice(0, takeover.msgs.length - 300);
}

// 消息发送回调（由 index.js 注入 callApi，供 webui 人工回复）
let sendMsg = null;
export function setSendMsg(fn) { sendMsg = fn; }
export function getSendMsg() { return sendMsg; }
