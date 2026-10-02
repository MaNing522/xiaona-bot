// ============================================================
// memory.js - 记忆模块（按会话隔离，持久化到 data/memory.json）
// 结构：recent(最近消息滑动窗口，区分 user/ai/system) + summary(溢出压缩摘要) + longterm(长期记忆)
// 支持搜索/清理/条数上限/超时清理；旧格式数组自动迁移
// ============================================================
import path from 'path';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';

let FILE = '';
let store = {}; // key -> { recent:[{role,text,t}], summary:[{text,t}], longterm:[{id,text,t}] }

const CFG = {
  maxRecent: 30,   // 最近消息保留条数（滑动窗口）
  maxLongterm: 50, // 长期记忆条数上限
  maxAgeDays: 30,  // 超过该天数的最近消息/摘要自动清理
  summaryKeep: 5,  // 窗口溢出时每次压缩的条数
  summaryCap: 800, // 摘要总字符上限
};

export function initMemory(saveDir, cfg = {}) {
  Object.assign(CFG, cfg);
  FILE = path.join(saveDir, 'memory.json');
  load();
}

function load() {
  try {
    const d = readJsonSafe(FILE, null, 'memory.json');
    if (d && typeof d === 'object') {
      // 迁移旧格式（数组 -> 新结构）
      for (const k of Object.keys(d)) {
        if (Array.isArray(d[k])) {
          d[k] = { recent: [], summary: [], longterm: d[k] };
        } else if (!d[k].longterm) d[k].longterm = [];
        if (!d[k].recent) d[k].recent = [];
        if (!d[k].summary) d[k].summary = [];
      }
      store = d;
    }
  } catch { store = {}; }
  pruneAge();
  save();
}
function save() {
  writeJsonAtomic(FILE, store);
}
function conv(key) {
  if (!store[key]) store[key] = { recent: [], summary: [], longterm: [] };
  return store[key];
}
/** 超时清理：超过 maxAgeDays 的最近消息/摘要移除（长期记忆保留） */
function pruneAge() {
  const limit = Date.now() - CFG.maxAgeDays * 86400000;
  for (const k of Object.keys(store)) {
    const c = store[k];
    if (c.recent) c.recent = c.recent.filter((m) => m.t >= limit);
    if (c.summary) c.summary = c.summary.filter((m) => m.t >= limit);
    if (!c.longterm.length && !c.recent.length && !c.summary.length) delete store[k];
  }
}

/** 历史里的一行该署谁的名：用户消息必须带上"谁说的"，否则 AI 分不清群里谁在说话 */
function label(m) {
  if (m.role === 'ai') return '小钠';
  if (m.role === 'system') return '系统';
  return m.name ? `${m.name}${m.qq ? `(${m.qq})` : ''}${m.isBot ? '[机器人]' : ''}` : '用户';
}

/** 压缩：把窗口最老的 summaryKeep 条压缩进摘要（逐条截断，总量封顶） */
function compress(c) {
  if (c.recent.length <= CFG.maxRecent) return;
  const overflow = c.recent.splice(0, CFG.summaryKeep);
  for (const m of overflow) {
    c.summary.push({ text: `${label(m)}: ${m.text}`.slice(0, 120), t: m.t });
  }
  let total = c.summary.reduce((s, m) => s + m.text.length, 0);
  while (c.summary.length > 1 && total > CFG.summaryCap) {
    total -= c.summary.shift().text.length;
  }
}

/**
 * 记录一条消息（role: user/ai/system）。
 * @param {{name?:string,qq?:string}} [who] 发言人（群名片/昵称 + QQ号），供历史署名
 */
export function recordMessage(key, role, text, who) {
  const c = conv(key);
  const t = Date.now();
  c.recent.push({
    role,
    text: String(text).slice(0, 500),
    t,
    name: who && who.name ? String(who.name).slice(0, 24) : '',
    qq: who && who.qq ? String(who.qq) : '',
    isBot: !!(who && who.isBot),
  });
  compress(c);
  save();
}

/** 保存长期记忆（#记住），返回当前条数 */
export function addMemory(key, text) {
  const c = conv(key);
  c.longterm.push({ id: 'M' + Date.now().toString(36), text: String(text).trim(), t: Date.now() });
  if (c.longterm.length > CFG.maxLongterm) c.longterm.splice(0, c.longterm.length - CFG.maxLongterm);
  save();
  return c.longterm.length;
}

/** 列出长期记忆 */
export function listMemory(key) {
  return (store[key]?.longterm || []).slice();
}

/** 删除单条长期记忆（按序号 1 起） */
export function removeMemory(key, index) {
  const c = store[key];
  if (!c || index < 1 || index > c.longterm.length) return false;
  c.longterm.splice(index - 1, 1);
  save();
  return true;
}

/** 清空某会话全部记忆 */
export function clearMemory(key) {
  if (store[key]) { delete store[key]; save(); return true; }
  return false;
}

/** 搜索记忆（长期/摘要/最近），返回文本片段 */
export function searchMemory(key, kw) {
  const c = store[key];
  if (!c) return '';
  const k = String(kw || '').trim();
  if (!k) return '';
  const hit = (s) => s.includes(k);
  const out = [];
  if (c.longterm.some((m) => hit(m.text))) out.push('【长期记忆】\n' + c.longterm.filter((m) => hit(m.text)).map((m) => '- ' + m.text).join('\n'));
  if (c.summary.some((m) => hit(m.text))) out.push('【对话摘要】\n' + c.summary.filter((m) => hit(m.text)).map((m) => '- ' + m.text).join('\n'));
  if (c.recent.some((m) => hit(m.text))) out.push('【最近对话】\n' + c.recent.filter((m) => hit(m.text)).map((m) => `${label(m)}: ${m.text}`).join('\n'));
  return out.join('\n');
}

/** 生成注入 AI 的上下文片段（无内容返回空串） */
export function memoryContext(key) {
  const c = store[key];
  if (!c) return '';
  const parts = [];
  if (c.longterm.length) parts.push('【长期记忆】\n' + c.longterm.map((m) => `- ${m.text}`).join('\n'));
  if (c.summary.length) parts.push('【对话摘要】\n' + c.summary.slice(-3).map((m) => `- ${m.text}`).join('\n'));
  const last = c.recent.slice(-6);
  if (last.length) parts.push('【最近对话】（下面每条开头的名字就是说话的人，不是每句都在跟你说话）\n'
    + last.map((m) => `${label(m)}: ${m.text}`).join('\n'));
  return parts.join('\n');
}
