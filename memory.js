// ============================================================
// memory.js - 记忆模块（SQLite 存储）
//
// 结构（与旧版 JSON 完全对应）：
//   messages 最近对话滑动窗口（role: user/ai/system，带发言人署名）
//   summary  窗口溢出压缩出的摘要
//   memory   长期记忆（#记住）
//
// 存储从 memory.json 换成 data/memory.db（详见 db.js）：
// 旧版每记录一条消息都要把整份 ~100KB JSON 重写一次，是明确的 IO 热点；
// 换库后写入是单行 INSERT，读取按会话走索引。
//
// 对外 8 个导出与旧版**完全一致**（含同步语义），因此 index.js 的调用点零改动；
// 旧 memory.json 在首次启动时一次性导入，并保留不删，作为回滚点。
// ============================================================
import path from 'path';
import { openMemoryDb, isDbEmpty, importLegacyJson } from './db.js';
import { logger } from './logger.js';

let db = null;

const CFG = {
  maxRecent: 30, // 最近消息保留条数（滑动窗口）
  maxLongterm: 50, // 长期记忆条数上限
  maxAgeDays: 30, // 超过该天数的最近消息/摘要自动清理
  summaryKeep: 5, // 窗口溢出时每次压缩的条数
  summaryCap: 800, // 摘要总字符上限
  contextRecent: 20, // 每次对话注入给 AI 的「最近对话」条数（20~30 比较合适）
};

export function initMemory(saveDir, cfg = {}) {
  Object.assign(CFG, cfg);
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
  pruneAge();
}

/** 超时清理：超过 maxAgeDays 的最近消息/摘要移除（长期记忆保留） */
function pruneAge() {
  const limit = Date.now() - CFG.maxAgeDays * 86400000;
  db.prepare('DELETE FROM messages WHERE ts < ?').run(limit);
  db.prepare('DELETE FROM summary WHERE ts < ?').run(limit);
}

/** 历史里的一行该署谁的名：用户消息必须带上"谁说的"，否则 AI 分不清群里谁在说话 */
function label(m) {
  if (m.role === 'ai') return '小钠';
  if (m.role === 'system') return '系统';
  const isBot = m.is_bot === undefined ? m.isBot : m.is_bot;
  return m.name ? `${m.name}${m.qq ? `(${m.qq})` : ''}${isBot ? '[机器人]' : ''}` : '用户';
}

/** 摘要总量封顶：从最老的开始丢，但至少留 1 条 */
function trimSummary(key) {
  const rows = db.prepare('SELECT id, text FROM summary WHERE conv_key = ? ORDER BY id').all(key);
  let total = rows.reduce((s, r) => s + String(r.text).length, 0);
  let drop = 0;
  while (rows.length - drop > 1 && total > CFG.summaryCap) {
    total -= String(rows[drop].text).length;
    drop += 1;
  }
  const del = db.prepare('DELETE FROM summary WHERE id = ?');
  for (let i = 0; i < drop; i++) del.run(rows[i].id);
}

/** 压缩：窗口超限时把最老的 summaryKeep 条压进摘要（逐条截断，总量封顶） */
function compress(key) {
  const n = Number(db.prepare('SELECT count(*) AS n FROM messages WHERE conv_key = ?').get(key).n);
  if (n <= CFG.maxRecent) return;

  const overflow = db
    .prepare(
      'SELECT id, role, content, name, qq, is_bot, ts FROM messages WHERE conv_key = ? ORDER BY id LIMIT ?',
    )
    .all(key, CFG.summaryKeep);
  const insSum = db.prepare('INSERT INTO summary(conv_key, text, ts) VALUES (?,?,?)');
  const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');

  db.exec('BEGIN');
  try {
    for (const m of overflow) {
      insSum.run(key, `${label(m)}: ${m.content}`.slice(0, 120), m.ts);
      delMsg.run(m.id);
    }
    trimSummary(key);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 记录一条消息（role: user/ai/system）。
 * @param {{name?:string,qq?:string,isBot?:boolean}} [who] 发言人（群名片/昵称 + QQ号），供历史署名
 */
export function recordMessage(key, role, text, who) {
  db.prepare(
    'INSERT INTO messages(conv_key, role, content, name, qq, is_bot, ts) VALUES (?,?,?,?,?,?,?)',
  ).run(
    String(key),
    String(role),
    String(text).slice(0, 500),
    who && who.name ? String(who.name).slice(0, 24) : '',
    who && who.qq ? String(who.qq) : '',
    who && who.isBot ? 1 : 0,
    Date.now(),
  );
  compress(String(key));
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

/** 清空某会话全部记忆 */
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
      `SELECT role, content, name, qq, is_bot FROM messages WHERE conv_key = ? AND content LIKE ? ESCAPE '\\' ORDER BY id`,
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
  const getMsg = db.prepare('SELECT role, content, name, qq, is_bot FROM messages WHERE id = ?');
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
    out.push(
      '【最近对话】\n'
        + hit.rec.map((m) => `${label({ ...m, role: m.role })}: ${m.content}`).join('\n'),
    );
  }
  return out.join('\n');
}

/** 生成注入 AI 的上下文片段（无内容返回空串） */
export function memoryContext(key) {
  const k = String(key);
  const lt = db.prepare('SELECT text FROM memory WHERE conv_key = ? ORDER BY rowid').all(k);
  const sum = db
    .prepare('SELECT text FROM summary WHERE conv_key = ? ORDER BY id DESC LIMIT 3')
    .all(k)
    .reverse();
  const last = db
    .prepare(
      'SELECT role, content, name, qq, is_bot FROM messages WHERE conv_key = ? ORDER BY id DESC LIMIT ?',
    )
    .all(k, Math.max(1, CFG.contextRecent))
    .reverse();

  if (!lt.length && !sum.length && !last.length) return '';

  const parts = [];
  if (lt.length) parts.push('【长期记忆】\n' + lt.map((m) => `- ${m.text}`).join('\n'));
  if (sum.length) parts.push('【对话摘要】\n' + sum.map((m) => `- ${m.text}`).join('\n'));
  if (last.length) {
    parts.push(
      '【最近对话】（下面每条开头的名字就是说话的人，不是每句都在跟你说话）\n'
        + last.map((m) => `${label(m)}: ${m.content}`).join('\n'),
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