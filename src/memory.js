// ============================================================
// memory.js - 记忆模块（SQLite 存储）
//
// 记忆主体是「人」而不是「会话」：同一个 QQ 号在不同群、私聊里说的话，
// 都归到同一个记忆桶（键形如 u:QQ号；游戏内没绑 QQ 的玩家用 n:玩家名）。
// 每条消息额外记 scene，标注它当时来自哪个群 / 私聊 / 游戏，
// 这样 AI 读记忆时仍然知道"这句话是在哪个群说的"。
//
// 只记录**触发过 AI 回复**的对话（由 index.js 在真正调用 AI 时写入），
// 每人最多保留 maxUserMessages 条（5~20，config.json 的 memory.maxUserMessages）。
//
// 长期记忆（#记住）同样按人存；旧的按会话数据会在首次启动时迁移：
//   带 QQ 号的 user 消息 → u:QQ号，原会话键写进 scene（AI 行没有发言人，留在旧键下）。
// 旧的 memory.json 仍一次性导入，原文件保留作回滚点。
// ============================================================
import path from 'path';
import { openMemoryDb, isDbEmpty, importLegacyJson } from './db.js';
import { logger } from './logger.js';

let db = null;

/** 每人最多保留几条「触发过 AI」的消息：只允许 5~20 */
const MIN_USER_MESSAGES = 5;
const MAX_USER_MESSAGES = 20;

const CFG = {
  maxUserMessages: 12, // 每个用户保留的对话条数（5~20）
  maxLongterm: 50, // 长期记忆条数上限
  maxAgeDays: 30, // 超过该天数的消息/摘要自动清理
  contextRecent: 20, // 每次对话注入给 AI 的「最近对话」条数
};

function clampUserMessages(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return CFG.maxUserMessages;
  return Math.min(MAX_USER_MESSAGES, Math.max(MIN_USER_MESSAGES, v));
}

export function initMemory(saveDir, cfg = {}) {
  if (cfg.maxUserMessages !== undefined) CFG.maxUserMessages = clampUserMessages(cfg.maxUserMessages);
  for (const k of ['maxLongterm', 'maxAgeDays', 'contextRecent']) {
    const v = Number(cfg[k]);
    if (Number.isFinite(v) && v > 0) CFG[k] = v;
  }
  if (db) {
    try {
      db.close();
    } catch {
      /* 重开时关不掉旧的也无所谓 */
    }
    db = null;
  }
  const file = path.join(saveDir, 'memory.db');
  db = openMemoryDb(file);
  // 库为空且存在旧的 memory.json → 一次性导入（原文件保留）
  if (isDbEmpty(db)) importLegacyJson(db, path.join(saveDir, 'memory.json'));
  migrateLegacyConvKeys();
  trimAllUsers();
  pruneAge();
}

/**
 * 配置热更新（config.json 改动后由 index.js 调用）：
 * 只刷新条目上限与上下文条数，不重开数据库。
 */
export function setMemoryOptions(cfg = {}) {
  if (!db) return;
  if (cfg.maxUserMessages !== undefined) CFG.maxUserMessages = clampUserMessages(cfg.maxUserMessages);
  const ctx = Number(cfg.contextRecent);
  if (Number.isFinite(ctx) && ctx > 0) CFG.contextRecent = ctx;
  trimAllUsers();
}

/**
 * 旧版按会话（g:群号 / p:QQ号）存消息；新版按人存。
 * 只迁移带 QQ 号的 user 行：把它们改到 u:QQ号，并原会话键写进 scene，
 * 这样历史上的"在哪个群说的"不会丢。AI 行没有发言人，无法归属，留在旧键下。
 */
function migrateLegacyConvKeys() {
  const rows = db
    .prepare(
      "SELECT id, conv_key, qq FROM messages WHERE qq <> '' AND conv_key NOT LIKE 'u:%' AND conv_key NOT LIKE 'n:%'",
    )
    .all();
  // 旧版 #记住 的长期记忆：私聊键 p:QQ号 明确属于那个人，可以安全搬到 u:QQ号；
  // 群聊键 g:群号 分不清是谁存的，留在原键下不动。
  const ltRows = db
    .prepare("SELECT DISTINCT conv_key FROM memory WHERE conv_key LIKE 'p:%'")
    .all()
    .filter((r) => /^p:\d{5,14}$/.test(String(r.conv_key)));
  if (!rows.length && !ltRows.length) return;
  const upd = db.prepare('UPDATE messages SET conv_key = ?, scene = ? WHERE id = ?');
  const mov = db.prepare('UPDATE memory SET conv_key = ? WHERE conv_key = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) upd.run('u:' + r.qq, r.conv_key, r.id);
    for (const r of ltRows) mov.run('u:' + String(r.conv_key).slice(2), r.conv_key);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    logger.warn('[记忆] 旧会话数据迁移失败（不影响新记忆）:', e.message);
    return;
  }
  if (rows.length) logger.info(`[记忆] 已把 ${rows.length} 条旧会话消息迁移到按人记忆（原群/私聊记入来源）`);
  if (ltRows.length) logger.info(`[记忆] 已把 ${ltRows.length} 个私聊的长期记忆迁移到按人记忆`);
}

/** 把所有用户记忆裁到上限（迁移/配置改小后调用一次） */
function trimAllUsers() {
  const keys = db
    .prepare("SELECT DISTINCT conv_key FROM messages WHERE conv_key LIKE 'u:%' OR conv_key LIKE 'n:%'")
    .all();
  for (const r of keys) trimUser(String(r.conv_key));
}

/** 某人超出上限时丢掉最老的（按 id 顺序） */
function trimUser(key) {
  const max = clampUserMessages(CFG.maxUserMessages);
  const n = Number(db.prepare('SELECT count(*) AS n FROM messages WHERE conv_key = ?').get(key).n);
  if (n <= max) return;
  const victims = db
    .prepare('SELECT id FROM messages WHERE conv_key = ? ORDER BY id LIMIT ?')
    .all(key, n - max);
  const del = db.prepare('DELETE FROM messages WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of victims) del.run(r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 超时清理：超过 maxAgeDays 的消息/摘要移除（长期记忆保留） */
function pruneAge() {
  const limit = Date.now() - CFG.maxAgeDays * 86400000;
  db.prepare('DELETE FROM messages WHERE ts < ?').run(limit);
  db.prepare('DELETE FROM summary WHERE ts < ?').run(limit);
}

/**
 * 对外暴露的过期清理（供闲时维护任务调用）。
 * 启动时会清一次，但长期运行的进程也得定期清，否则消息/摘要会一直堆到下次重启。
 * @returns {{messages:number, summary:number}} 清掉的条数
 */
export function pruneExpired() {
  if (!db) return { messages: 0, summary: 0 };
  const limit = Date.now() - CFG.maxAgeDays * 86400000;
  const m = db.prepare('DELETE FROM messages WHERE ts < ?').run(limit);
  const s = db.prepare('DELETE FROM summary WHERE ts < ?').run(limit);
  return { messages: Number(m.changes) || 0, summary: Number(s.changes) || 0 };
}

/** 历史里的一行该署谁的名：用户消息必须带上"谁说的"，否则 AI 分不清群里谁在说话 */
function label(m) {
  if (m.role === 'ai') return '小钠';
  if (m.role === 'system') return '系统';
  const isBot = m.is_bot === undefined ? m.isBot : m.is_bot;
  return m.name ? `${m.name}${m.qq ? `(${m.qq})` : ''}${isBot ? '[机器人]' : ''}` : '用户';
}

/** 来源标注：这条记忆是当时在哪个群 / 私聊 / 游戏里说的 */
function sceneTag(scene) {
  const s = String(scene || '');
  if (/^g:\d+$/.test(s)) return `[群${s.slice(2)}]`;
  if (s.startsWith('p:')) return '[私聊]';
  if (s.startsWith('mc:')) return '[游戏]';
  return '';
}

/** 历史的一行：发言人 + 来源 + 内容 */
function lineOf(m) {
  return `${label(m)}${sceneTag(m.scene)}: ${m.content}`;
}

/**
 * 记录一条消息（role: user/ai/system）。
 * 只应由「真正触发 AI」的流程调用（见 index.js 的 runAI），避免把群里所有闲聊都存下来。
 * @param {{name?:string,qq?:string,isBot?:boolean,scene?:string}} [who]
 *   发言人（群名片/昵称 + QQ号），以及当时的来源会话（g:群号 / p:QQ号 / mc:玩家）
 */
export function recordMessage(key, role, text, who) {
  db.prepare(
    'INSERT INTO messages(conv_key, role, content, name, qq, is_bot, scene, ts) VALUES (?,?,?,?,?,?,?,?)',
  ).run(
    String(key),
    String(role),
    String(text).slice(0, 500),
    who && who.name ? String(who.name).slice(0, 24) : '',
    who && who.qq ? String(who.qq) : '',
    who && who.isBot ? 1 : 0,
    who && who.scene ? String(who.scene) : '',
    Date.now(),
  );
  trimUser(String(key));
}

/** 保存长期记忆（#记住），返回当前条数 */
export function addMemory(key, text) {
  const t = Date.now();
  const id = 'M' + t.toString(36) + Math.random().toString(36).slice(2, 6);
  db.prepare('INSERT INTO memory(id, conv_key, text, ts) VALUES (?,?,?,?)').run(
    id,
    String(key),
    String(text).trim(),
    t,
  );
  // 超上限就丢最老的
  const ids = db.prepare('SELECT id FROM memory WHERE conv_key = ? ORDER BY rowid').all(String(key));
  if (ids.length > CFG.maxLongterm) {
    const del = db.prepare('DELETE FROM memory WHERE id = ?');
    for (const r of ids.slice(0, ids.length - CFG.maxLongterm)) del.run(r.id);
    return CFG.maxLongterm;
  }
  return ids.length;
}

/** 列出长期记忆（按写入顺序） */
export function listMemory(key) {
  return db
    .prepare('SELECT id, text, ts FROM memory WHERE conv_key = ? ORDER BY rowid')
    .all(String(key))
    .map((r) => ({ id: r.id, text: r.text, t: r.ts }));
}

/** 删除单条长期记忆（按序号 1 起） */
export function removeMemory(key, index) {
  const rows = db.prepare('SELECT id FROM memory WHERE conv_key = ? ORDER BY rowid').all(String(key));
  if (index < 1 || index > rows.length) return false;
  db.prepare('DELETE FROM memory WHERE id = ?').run(rows[index - 1].id);
  return true;
}

/** 清空某个人的全部记忆（长期 + 历史消息 + 旧摘要） */
export function clearMemory(key) {
  const k = String(key);
  const n =
    Number(db.prepare('SELECT count(*) AS n FROM memory WHERE conv_key = ?').get(k).n) +
    Number(db.prepare('SELECT count(*) AS n FROM messages WHERE conv_key = ?').get(k).n) +
    Number(db.prepare('SELECT count(*) AS n FROM summary WHERE conv_key = ?').get(k).n);
  if (!n) return false;
  db.prepare('DELETE FROM messages WHERE conv_key = ?').run(k);
  db.prepare('DELETE FROM summary WHERE conv_key = ?').run(k);
  db.prepare('DELETE FROM memory WHERE conv_key = ?').run(k);
  return true;
}

/** LIKE 通配符转义（用户输入里的 % _ \ 要当普通字符） */
function likePattern(kw) {
  return '%' + String(kw).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** 回退方案：三张表各自 LIKE 模糊匹配 */
function likeSearch(key, kw) {
  const p = likePattern(kw);
  const mem = db
    .prepare(`SELECT text FROM memory WHERE conv_key = ? AND text LIKE ? ESCAPE '\\' ORDER BY rowid`)
    .all(key, p);
  const sum = db
    .prepare(`SELECT text FROM summary WHERE conv_key = ? AND text LIKE ? ESCAPE '\\' ORDER BY id`)
    .all(key, p);
  const rec = db
    .prepare(
      `SELECT role, content, name, qq, is_bot, scene FROM messages WHERE conv_key = ? AND content LIKE ? ESCAPE '\\' ORDER BY id`,
    )
    .all(key, p);
  return { mem, sum, rec };
}

/**
 * 全文搜索：FTS5（trigram 分词）+ 触发器同步的索引。
 * trigram 对 < 3 个字符的查询无效（如 2 字中文），这类查询以及 FTS 异常时回退 LIKE。
 */
function ftsSearch(key, kw) {
  const q = '"' + String(kw).replace(/"/g, '""') + '"';
  const rows = db
    .prepare('SELECT kind, ref, text FROM search_fts WHERE conv_key = ? AND search_fts MATCH ?')
    .all(key, q);
  const mem = [];
  const sum = [];
  const rec = [];
  for (const r of rows) {
    if (r.kind === 'longterm') mem.push({ text: r.text });
    else if (r.kind === 'summary') sum.push({ text: r.text });
    else rec.push({ ref: r.ref, text: r.text });
  }
  // 最近对话需要按原顺序 + 带发言人署名，回表取一次
  const getMsg = db.prepare('SELECT role, content, name, qq, is_bot, scene FROM messages WHERE id = ?');
  const recFull = rec
    .map((r) => ({ id: Number(r.ref), ...getMsg.get(r.ref) }))
    .filter((m) => m.id)
    .sort((a, b) => a.id - b.id);
  return { mem, sum, rec: recFull };
}

/** 搜索记忆（长期/摘要/最近），返回文本片段 */
export function searchMemory(key, kw) {
  const k = String(kw || '').trim();
  if (!k) return '';
  const ck = String(key);
  let hit;
  if (db.ftsEnabled && k.length >= 3) {
    try {
      hit = ftsSearch(ck, k);
    } catch (e) {
      logger.warn('[记忆] 全文索引查询失败，回退 LIKE:', e.message);
      hit = likeSearch(ck, k);
    }
  } else {
    hit = likeSearch(ck, k);
  }

  const out = [];
  if (hit.mem.length) out.push('【长期记忆】\n' + hit.mem.map((m) => '- ' + m.text).join('\n'));
  if (hit.sum.length) out.push('【对话摘要】\n' + hit.sum.map((m) => '- ' + m.text).join('\n'));
  if (hit.rec.length) {
    out.push('【最近对话】\n' + hit.rec.map((m) => lineOf({ ...m, role: m.role })).join('\n'));
  }
  return out.join('\n');
}

/**
 * 生成注入 AI 的上下文片段（无内容返回空串）。
 * @param {string} key 人的记忆键（u:QQ号 / n:玩家名）
 * @param {number} [limit] 本次注入的历史消息条数（默认取 contextRecent，来自 config.json 的 ai.contextMessages）
 */
export function memoryContext(key, limit) {
  const k = String(key);
  const n = Number(limit);
  const take = Number.isFinite(n) && n > 0 ? Math.round(n) : CFG.contextRecent;
  const lt = db.prepare('SELECT text FROM memory WHERE conv_key = ? ORDER BY rowid').all(k);
  const sum = db
    .prepare('SELECT text FROM summary WHERE conv_key = ? ORDER BY id DESC LIMIT 3')
    .all(k)
    .reverse();
  const last = db
    .prepare(
      'SELECT role, content, name, qq, is_bot, scene FROM messages WHERE conv_key = ? ORDER BY id DESC LIMIT ?',
    )
    .all(k, Math.max(1, take))
    .reverse();

  if (!lt.length && !sum.length && !last.length) return '';

  const parts = [];
  if (lt.length) parts.push('【长期记忆】\n' + lt.map((m) => `- ${m.text}`).join('\n'));
  if (sum.length) parts.push('【对话摘要】\n' + sum.map((m) => `- ${m.text}`).join('\n'));
  if (last.length) {
    parts.push(
      '【最近对话】（按人记录，方括号里是当时所在的群 / 私聊；每条开头的名字就是说话的人，不是每句都在跟你说话）\n'
        + last.map((m) => lineOf(m)).join('\n'),
    );
  }
  return parts.join('\n');
}

/** 关闭数据库（主要供测试与优雅退出使用） */
export function closeMemory() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = null;
}
