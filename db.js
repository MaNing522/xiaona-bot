// ============================================================
// db.js - SQLite 连接 / 建表 / 迁移（node:sqlite，免原生编译）
//
// 为什么用 node:sqlite：Node >= 22 内置（本项目跑 Node 24），同步 API、零原生依赖，
// 不用赌 better-sqlite3 的预编译二进制能不能在 Windows 上装成功。
//
// 三张业务表 + 一张 FTS5 全文索引表：
//   messages  最近对话（滑动窗口，会被压缩裁剪）
//   summary   对话摘要（窗口溢出时把最老的几条压进来）
//   memory    长期记忆（#记住）
//   search_fts  上面三张表的全文索引，用触发器自动同步
//
// 分词器用 trigram：中文无需额外分词器即可子串匹配。
// 注意 trigram 只对 **>= 3 个字符** 的查询有效（2 字中文查不到），
// 因此 memory.js 会对短查询走 LIKE 回退。
// ============================================================
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { logger } from './logger.js';

/** 全文索引表名；不可用时 db.ftsEnabled = false，调用方回退 LIKE */
const FTS_DDL = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
     conv_key UNINDEXED, kind UNINDEXED, ref UNINDEXED, text,
     tokenize = 'trigram'
   )`,
];

/** 三张业务表 + 索引 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     conv_key TEXT    NOT NULL,
     role     TEXT    NOT NULL,
     content  TEXT    NOT NULL,
     name     TEXT    NOT NULL DEFAULT '',
     qq       TEXT    NOT NULL DEFAULT '',
     is_bot   INTEGER NOT NULL DEFAULT 0,
     ts       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_key, id)`,
  `CREATE TABLE IF NOT EXISTS summary (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     conv_key TEXT    NOT NULL,
     text     TEXT    NOT NULL,
     ts       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_summary_conv ON summary(conv_key, id)`,
  `CREATE TABLE IF NOT EXISTS memory (
     id       TEXT    PRIMARY KEY,
     conv_key TEXT    NOT NULL,
     text     TEXT    NOT NULL,
     ts       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_conv ON memory(conv_key, ts)`,
];

/** 触发器：三张业务表的增删改自动同步进 search_fts（ref 存原表行号/主键） */
function triggerDdl() {
  const out = [];
  for (const [table, kind, textCol] of [
    ['messages', 'recent', 'content'],
    ['summary', 'summary', 'text'],
    ['memory', 'longterm', 'text'],
  ]) {
    out.push(
      `CREATE TRIGGER IF NOT EXISTS ${table}_fts_ai AFTER INSERT ON ${table} BEGIN
         INSERT INTO search_fts(conv_key, kind, ref, text) VALUES (new.conv_key, '${kind}', new.id, new.${textCol});
       END`,
      `CREATE TRIGGER IF NOT EXISTS ${table}_fts_ad AFTER DELETE ON ${table} BEGIN
         DELETE FROM search_fts WHERE kind = '${kind}' AND ref = old.id;
       END`,
      `CREATE TRIGGER IF NOT EXISTS ${table}_fts_au AFTER UPDATE ON ${table} BEGIN
         DELETE FROM search_fts WHERE kind = '${kind}' AND ref = old.id;
         INSERT INTO search_fts(conv_key, kind, ref, text) VALUES (new.conv_key, '${kind}', new.id, new.${textCol});
       END`,
    );
  }
  return out;
}

/**
 * 打开（必要时创建）记忆数据库。
 * @param {string} file 数据库文件路径
 * @returns {import('node:sqlite').DatabaseSync & {ftsEnabled:boolean}}
 */
export function openMemoryDb(file) {
  const dir = file.replace(/[\\/][^\\/]*$/, '');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file);
  // WAL：读写并发更好，断电时更不容易损坏
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  } catch (e) {
    logger.warn('[DB] 设置 WAL 失败（不影响使用）:', e.message);
  }

  for (const sql of SCHEMA) db.exec(sql);

  // FTS5 可用性：个别构建可能没有；没有就整体降级为 LIKE 查询
  let ftsEnabled = true;
  try {
    for (const sql of FTS_DDL) db.exec(sql);
    for (const sql of triggerDdl()) db.exec(sql);
  } catch (e) {
    ftsEnabled = false;
    logger.warn('[DB] FTS5 不可用，全文搜索回退为 LIKE:', e.message);
  }
  db.ftsEnabled = ftsEnabled;
  return db;
}

/** 数据库是否为空（用于判断要不要做一次性迁移） */
export function isDbEmpty(db) {
  const row = db
    .prepare(
      'SELECT (SELECT count(*) FROM messages) + (SELECT count(*) FROM summary) + (SELECT count(*) FROM memory) AS n',
    )
    .get();
  return !row || Number(row.n) === 0;
}

/**
 * 把旧的 data/memory.json 一次性导入 SQLite。
 * 旧文件**保留不删**，作为回滚点。
 * @returns {{conversations:number, recent:number, summary:number, longterm:number}|null}
 */
export function importLegacyJson(db, jsonFile) {
  if (!fs.existsSync(jsonFile)) return null;
  let store;
  try {
    store = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch (e) {
    logger.error(`[DB] 旧记忆文件解析失败，跳过迁移：${e.message}`);
    return null;
  }
  if (!store || typeof store !== 'object') return null;

  const insMsg = db.prepare(
    'INSERT INTO messages(conv_key, role, content, name, qq, is_bot, ts) VALUES (?,?,?,?,?,?,?)',
  );
  const insSum = db.prepare('INSERT INTO summary(conv_key, text, ts) VALUES (?,?,?)');
  const insMem = db.prepare('INSERT INTO memory(id, conv_key, text, ts) VALUES (?,?,?,?)');
  const stats = { conversations: 0, recent: 0, summary: 0, longterm: 0 };

  db.exec('BEGIN');
  try {
    for (const [key, conv] of Object.entries(store)) {
      if (!conv || typeof conv !== 'object') continue;
      // 兼容 v1 的旧格式：整个会话就是个长期记忆数组
      const recent = Array.isArray(conv.recent) ? conv.recent : [];
      const summary = Array.isArray(conv.summary) ? conv.summary : [];
      const longterm = Array.isArray(conv.longterm) ? conv.longterm : Array.isArray(conv) ? conv : [];

      for (const m of recent) {
        insMsg.run(
          key,
          String(m.role || 'user'),
          String(m.text || ''),
          String(m.name || ''),
          String(m.qq || ''),
          m.isBot ? 1 : 0,
          Number(m.t) || Date.now(),
        );
        stats.recent += 1;
      }
      for (const m of summary) {
        insSum.run(key, String(m.text || ''), Number(m.t) || Date.now());
        stats.summary += 1;
      }
      for (const m of longterm) {
        insMem.run(
          String(m.id || 'M' + Math.random().toString(36).slice(2)),
          key,
          String(m.text || ''),
          Number(m.t) || Date.now(),
        );
        stats.longterm += 1;
      }
      stats.conversations += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    logger.error('[DB] 旧记忆迁移失败，已回滚（原 JSON 未受影响）:', e.message);
    return null;
  }

  logger.info(
    `[DB] 已从 memory.json 迁移 ${stats.conversations} 个会话：最近对话 ${stats.recent}、摘要 ${stats.summary}、长期记忆 ${stats.longterm}（原 JSON 保留作回滚点）`,
  );
  return stats;
}
