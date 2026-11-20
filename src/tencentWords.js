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
import { maskSensitive } from './filter.js';

const WORD_FILE = path.join(ROOT, 'src', 'tencent-sensitive-words.txt');
let cache = null;

/** 用一组词做最长匹配替换（纯函数，方便单测） */
export function maskByWords(text, words, replace) {
  const src = String(text ?? '');
  if (!src) return src;
  const set = new Set();
  let maxLen = 0;
  for (const w of words || []) {
    const s = String(w ?? '').trim().toLowerCase();
    if (s.length < 2) continue; // 单字词太容易误伤，跳过
    if (!set.has(s)) {
      set.add(s);
      if (s.length > maxLen) maxLen = s.length;
    }
  }
  if (!set.size) return src;
  const rep = String(replace || '***');
  const lower = src.toLowerCase();
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
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

function libraryWords() {
  if (cache) return cache;
  try {
    cache = fs.readFileSync(WORD_FILE, 'utf8').split(/\r?\n/);
  } catch (e) {
    cache = []; // 词库缺失时退化为空，不影响正常转发
  }
  return cache;
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
