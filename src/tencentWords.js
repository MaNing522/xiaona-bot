// ============================================================
// tencentWords.js - 腾讯离线敏感词库（tencent-sensitive-words）
//
// 词库来自 https://github.com/cjh0613/tencent-sensitive-words
// 文件放在 src/tencent-sensitive-words.txt，随项目一起部署。
// · 首次使用时读入内存（Set），之后复用
// · 单字词（“妈 / 爸 / 操”等）按子串匹配会误伤正常聊天，默认跳过
// · 命中取最长匹配，统一替换成占位符；英文不区分大小写
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import { logger } from './logger.js';
import { maskSensitive, parseSensitiveWords } from './filter.js';

const WORD_FILE = path.join(ROOT, 'src', 'tencent-sensitive-words.txt');
let cache = null;
let lastWarn = 0;

// 纯字母的短缩写（c / cnm / mb / tmd 等）歧义太大，不参与屏蔽；
// 中文脏话（他妈 / 你他妈 等）照常按词库替换成占位符，只替换命中的字，不影响整句转发。
const IGNORED = new Set(['c', 'cnm', 'mb', 'tmd', 'nmd', 'nm']);

/**
 * 标出放行词在文本里占的字符：字库里有不少日常词（服务器 / 管理 / 手机…），
 * 直接打码正常聊天太出戏；放行词整段（含被它包含的短词）都不替换。
 * 例：放行「管理」→“管理员”不会被“管理”这一条打码。
 */
function ignoreCovers(lower, ignoreWords) {
  const covered = new Uint8Array(lower.length);
  for (const w of ignoreWords) {
    if (!w || w.length > lower.length) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(w, from);
      if (at < 0) break;
      covered.fill(1, at, at + w.length);
      from = at + 1;
    }
  }
  return covered;
}

/**
 * 用一组词做最长匹配替换（纯函数，方便单测）
 * @param {string} text 原文
 * @param {string[]} words 词表
 * @param {string} [replace] 占位符
 * @param {string|string[]} [ignore] 放行词（逗号等分隔，或已拆好的数组）
 */
export function maskByWords(text, words, replace, ignore) {
  const src = String(text ?? '');
  if (!src) return src;
  const set = new Set();
  const singles = new Set();
  let maxLen = 0;
  for (const w of words || []) {
    const s = String(w ?? '').trim().toLowerCase();
    if (!s || IGNORED.has(s)) continue;
    // 1~3 个字母的英文 / 拼音缩写（c、cnm、mb、sb…）歧义太大，直接放行，不参与替换
    if (/^[a-z]{1,3}$/.test(s)) continue;
    if (s.length === 1) { singles.add(s); continue; } // 单字只在独立出现时匹配，避免“操作”被打码
    if (!set.has(s)) {
      set.add(s);
      if (s.length > maxLen) maxLen = s.length;
    }
  }
  if (!set.size && !singles.size) return src;
  const rep = String(replace || '***');
  const lower = src.toLowerCase();
  const ignores = (Array.isArray(ignore) ? ignore : parseSensitiveWords(ignore))
    .map((w) => String(w ?? '').trim().toLowerCase())
    .filter(Boolean);
  const covered = ignores.length ? ignoreCovers(lower, ignores) : null;
  const isCjk = (ch) => /[\u3400-\u9fff\uf900-\ufaff]/.test(ch || '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    let pick = -1;
    const limit = Math.min(lower.length, i + maxLen);
    // 从长到短找，跳过落在放行区间里的候选
    for (let j = limit; j > i; j--) {
      if (!set.has(lower.slice(i, j))) continue;
      let clash = false;
      if (covered) for (let k = i; k < j; k++) if (covered[k]) { clash = true; break; }
      if (!clash) { pick = j; break; }
    }
    if (pick > i) {
      out += rep;
      i = pick;
      continue;
    }
    // 单字脏话（如“操”）：只有前后不是汉字时才算，避免误伤“操作 / 体操”
    if (singles.has(lower[i]) && !(covered && covered[i])) {
      const before = i === 0 ? '' : src[i - 1];
      const after = i + 1 >= src.length ? '' : src[i + 1];
      if (!isCjk(before) && !isCjk(after)) {
        out += rep;
        i++;
        continue;
      }
    }
    out += src[i];
    i++;
  }
  return out;
}

function libraryWords() {
  if (cache) return cache;
  try {
    const words = fs.readFileSync(WORD_FILE, 'utf8').split(/\r?\n/);
    if (!words.length) throw new Error('词库是空的');
    cache = words;
    logger.info(`[过滤] 已加载 ${words.length} 条内置敏感词`);
  } catch (e) {
    cache = null; // 不缓存失败：文件后来补上了还能自动生效
    const now = Date.now();
    if (now - lastWarn > 60000) {
      lastWarn = now;
      logger.warn(`[过滤] 敏感词库读取失败（${e.message}），这条消息将不过滤：${WORD_FILE}`);
    }
  }
  return cache || [];
}

/** 当前能用的内置词条数（启动时打进日志，方便确认部署是否带上了词库） */
export function librarySize() {
  return libraryWords().length;
}

/** 腾讯词库过滤（词库文件缺失时原样返回） */
export function tencentMask(text, replace, ignore) {
  return maskByWords(text, libraryWords(), replace, ignore);
}

/** 转发消息统一入口：先过 config.json 的自定义词，再过腾讯词库（filter.ignore 为放行词） */
export function maskForwardText(text, opt) {
  const o = opt || {};
  if (o.enabled === false) return String(text ?? '');
  return tencentMask(maskSensitive(text, o), o.replace, o.ignore);
}
