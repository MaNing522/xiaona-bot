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
import { maskSensitive } from './filter.js';

const WORD_FILE = path.join(ROOT, 'src', 'tencent-sensitive-words.txt');
let cache = null;
let lastWarn = 0;

/** 用一组词做最长匹配替换（纯函数，方便单测） */
export function maskByWords(text, words, replace) {
  const src = String(text ?? '');
  if (!src) return src;
  const set = new Set();
  const singles = new Set();
  let maxLen = 0;
  for (const w of words || []) {
    const s = String(w ?? '').trim().toLowerCase();
    if (!s) continue;
    if (s.length === 1) { singles.add(s); continue; } // 单字只在独立出现时匹配，避免“操作”被打码
    if (!set.has(s)) {
      set.add(s);
      if (s.length > maxLen) maxLen = s.length;
    }
  }
  if (!set.size && !singles.size) return src;
  const rep = String(replace || '***');
  const lower = src.toLowerCase();
  const isCjk = (ch) => /[\u3400-\u9fff\uf900-\ufaff]/.test(ch || '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    let last = -1;
    const limit = Math.min(lower.length, i + maxLen);
    for (let j = i + 1; j <= limit; j++) {
      if (set.has(lower.slice(i, j))) last = j;
    }
    if (last > i) {
      out += rep;
      i = last;
      continue;
    }
    // 单字脏话（如“操”）：只有前后不是汉字时才算，避免误伤“操作 / 体操”
    if (singles.has(lower[i])) {
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
export function tencentMask(text, replace) {
  return maskByWords(text, libraryWords(), replace);
}

/** 转发消息统一入口：先过 config.json 的自定义词，再过腾讯词库 */
export function maskForwardText(text, opt) {
  const o = opt || {};
  if (o.enabled === false) return String(text ?? '');
  return tencentMask(maskSensitive(text, o), o.replace);
}
