// ============================================================
// logger.js - 统一日志出口（pino 作为引擎，三个 sink）
//
//   · 终端：保留历史行为 —— emoji 等终端无字形的字符换成 [表情]
//   · WebUI：调 state.pushLog()，写「原始文本」（保留 emoji，浏览器能渲染）
//   · 文件：logs/YYYY-MM-DD.log，按天滚动
//
// 为什么不用 pino 默认的 JSON 输出：WebUI 的日志是字符串数组、终端要人看的纯文本，
// JSON 行两边都不合适。这里把 pino 当「分级 + 记录封装」的引擎，输出格式由本文件决定，
// 这样既保留分级/级别过滤，又不破坏既有的终端与面板契约。
//
// 注意：ESM 的 import 先于 dotenv.config() 执行，所以 LOG_LEVEL 不能在模块顶层读死，
// 由 index.js 在 dotenv 之后调用 setLogLevel()。
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Writable } from 'stream';
import pino from 'pino';
import { pushLog } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'logs');
// 跑测试时不写文件：否则 npm test 会把用例输出灌进运行日志里（Vitest 会设 VITEST）
const FILE_LOG = !process.env.VITEST;

/**
 * 终端字体（Consolas/宋体这类等宽字体）基本没有 emoji 和部分符号的字形，
 * 直接输出会被画成空白或豆腐块 —— 看起来就是"没显示出来"。
 * 这里把连续的一串换成 [表情]，保证终端里一定看得到东西。
 * 注意别把箭头/几何图形/带圈数字也吞掉：那些在中文字体里是能正常显示的。
 */
// ZWJ / 变体选择符本就在字符类里做「表情组成符」匹配，是刻意为之（用块注释，避免被 Prettier 换行后失效）
/* eslint-disable no-misleading-character-class */
const TERM_UNSAFE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{200D}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]+/gu;
/* eslint-enable no-misleading-character-class */
export function termSafe(v) {
  return typeof v === 'string' ? v.replace(TERM_UNSAFE, '[表情]') : v;
}

/** 把任意参数拼成一行可读文本（Error 取堆栈，对象取 JSON） */
function toText(a) {
  return a
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x instanceof Error) return x.stack || x.message;
      if (x === undefined) return 'undefined';
      if (x === null) return 'null';
      if (typeof x === 'object') {
        try {
          return JSON.stringify(x);
        } catch {
          return String(x);
        }
      }
      return String(x);
    })
    .join(' ');
}

const pad = (n) => String(n).padStart(2, '0');
const LEVEL_NAME = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

function dailyFile(d) {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return path.join(LOG_DIR, `${day}.log`);
}

function writeAll(levelName, msg) {
  // 1) 终端（emoji → [表情]）
  try {
    process.stdout.write(termSafe(msg) + '\n');
  } catch {
    /* 终端写失败（如管道已关）不能反过来影响业务 */
  }
  // 2) WebUI（原始文本；error/warn 加前缀，与改造前的观感一致）
  try {
    if (levelName === 'error' || levelName === 'fatal') pushLog('❌ ' + msg);
    else if (levelName === 'warn') pushLog('⚠️ ' + msg);
    else pushLog(msg);
  } catch {
    /* pushLog 失败绝不能抛 */
  }
  // 3) 文件（按天；时间戳用本地时间，和文件名一致，排查时不必再换算时区）
  if (!FILE_LOG) return;
  try {
    const d = new Date();
    const ts =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    fs.appendFileSync(dailyFile(d), `${ts} ${levelName.toUpperCase().padEnd(5)} ${msg}\n`);
  } catch {
    /* 落盘失败不影响运行 */
  }
}

const sink = new Writable({
  write(chunk, _enc, cb) {
    try {
      const rec = JSON.parse(chunk.toString());
      writeAll(LEVEL_NAME[rec.level] || 'info', rec.msg == null ? '' : String(rec.msg));
    } catch {
      /* 解析失败就丢弃这一行 */
    }
    cb();
  },
});

if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* 建不了目录就只写终端/WebUI */
  }
}

const pinoLogger = pino({ level: 'info', base: undefined, timestamp: false }, sink);

/** dotenv 之后调用，让 .env 里的 LOG_LEVEL 生效（trace/debug/info/warn/error/fatal） */
export function setLogLevel(level) {
  const l = String(level || '')
    .trim()
    .toLowerCase();
  if (l) pinoLogger.level = l;
}

/**
 * 唯一日志出口。方法与 console 同款：接受任意个参数，会被拼成一行。
 * 之所以包一层而不是直接用 pino 实例：pino 只对「首个字符串里的 %s/%d」做插值，
 * 多余的参数会被丢掉，而现有代码大量使用 `console.error('x', e.message)` 这种写法。
 */
export const logger = {
  trace: (...a) => pinoLogger.trace(toText(a)),
  debug: (...a) => pinoLogger.debug(toText(a)),
  info: (...a) => pinoLogger.info(toText(a)),
  warn: (...a) => pinoLogger.warn(toText(a)),
  error: (...a) => pinoLogger.error(toText(a)),
  fatal: (...a) => pinoLogger.fatal(toText(a)),
};

export default logger;
