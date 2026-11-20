// ============================================================
// convStats.js - 每个会话（群 / 私聊）累计的「唤起」「回复」次数
//
// 落盘 data/conv-stats.json，结构：
//   { "g:123456": { "wake": 12, "reply": 9, "updatedAt": 1700000000000 } }
// 写入做了 1.5 秒防抖，避免每条消息都碰磁盘；进程退出前会补一次落盘。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import { logger } from './logger.js';

const FILE = path.join(ROOT, 'data', 'conv-stats.json');
let data = null;
let timer = null;

function ensure() {
  if (data) return data;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    data = {};
  }
  return data;
}

function saveNow() {
  timer = null;
  if (!data) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    logger.warn('[统计] 保存会话统计失败:', e.message);
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(saveNow, 1500);
  if (timer.unref) timer.unref();
}

process.once('exit', () => { if (timer) saveNow(); });

/** 给某个会话的 wake / reply 计数 +1 */
export function bump(key, field) {
  if (!key || (field !== 'wake' && field !== 'reply')) return;
  const d = ensure();
  const s = d[key] || (d[key] = { wake: 0, reply: 0 });
  s[field] = (Number(s[field]) || 0) + 1;
  s.updatedAt = Date.now();
  schedule();
}

/** 取某个会话的统计（没有记录时返回 0 / 0） */
export function get(key) {
  const s = ensure()[key];
  return {
    wake: Number(s && s.wake) || 0,
    reply: Number(s && s.reply) || 0,
  };
}

/** 全部会话的统计（供网页一次取回） */
export function all() {
  return ensure();
}
