// ============================================================
// notes.js - AI 可读写的本地文本笔记
//
// 说明：AI 通过 write_note / read_note 两个工具把资料写进 data/notes/，
// 以后需要时再读回来。文件名做净化处理，禁止跳出 notes 目录；
// 单个文件限制 200KB，避免模型把整份日志塞进来。
// ============================================================
import fs from 'fs';
import path from 'path';

const MAX_BYTES = 200 * 1024;
let NOTES_DIR = '';

/** 初始化笔记目录（由 index.js 在拿到 SAVE_DIR 后调用） */
export function initNotes(dir) {
  NOTES_DIR = path.join(dir, 'notes');
  fs.mkdirSync(NOTES_DIR, { recursive: true });
}

/** 把任意名字净化成安全的文件名（保留中文，去掉路径分隔符与非法字符） */
export function safeNoteName(raw) {
  let n = String(raw == null ? '' : raw).trim();
  if (!n) n = 'note';
  n = Array.from(n).map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch)).join('');
  n = n.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!n) n = 'note';
  if (!/\.(txt|md)$/i.test(n)) n += '.txt';
  if (Buffer.byteLength(n, 'utf8') > 120) {
    const ext = /\.md$/i.test(n) ? '.md' : '.txt';
    n = Buffer.from(n, 'utf8').subarray(0, 100).toString('utf8').replace(/\uFFFD+$/g, '') + ext;
  }
  return n;
}

function noteFile(name) {
  if (!NOTES_DIR) throw new Error('笔记目录未初始化');
  const safe = safeNoteName(name);
  const file = path.join(NOTES_DIR, safe);
  if (path.dirname(file) !== NOTES_DIR) throw new Error('文件名不合法');
  return { safe, file };
}

/** 写入笔记：append=true 时追加，否则覆盖 */
export function writeNote(name, content, append = false) {
  const text = String(content == null ? '' : content);
  if (!text.trim()) return '内容为空，没有写入。';
  const { safe, file } = noteFile(name);
  const old = append && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const next = old + (old && !old.endsWith('\n') ? '\n' : '') + text;
  if (Buffer.byteLength(next, 'utf8') > MAX_BYTES) {
    return `写入失败：${safe} 超过 200KB 上限。`;
  }
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return `已${append ? '追加' : '写入'}笔记 ${safe}（${Buffer.byteLength(next, 'utf8')} 字节）。`;
}

/** 读取笔记；name 为空时返回笔记目录清单 */
export function readNote(name) {
  const key = String(name == null ? '' : name).trim();
  if (!key) return listNotes();
  const { safe, file } = noteFile(key);
  if (!fs.existsSync(file)) return `没有找到笔记 ${safe}。可先不带文件名调用 read_note 查看已有笔记。`;
  const text = fs.readFileSync(file, 'utf8');
  return `【${safe}】\n${text.length > 12000 ? text.slice(0, 12000) + '\n…（已截断，共 ' + text.length + ' 字）' : text}`;
}

/** 列出全部笔记（名字 + 大小） */
export function listNotes() {
  if (!NOTES_DIR || !fs.existsSync(NOTES_DIR)) return '还没有任何笔记。';
  const files = fs.readdirSync(NOTES_DIR)
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(NOTES_DIR, f));
      return `${f}（${st.size} 字节）`;
    })
    .sort();
  return files.length ? `本地笔记（${files.length} 个）：\n${files.join('\n')}` : '还没有任何笔记。';
}
