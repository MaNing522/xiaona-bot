// ============================================================
// rateLimit.js - 宽松限速（用户 / 群 / 全局）+ 反刷屏惩罚
//
// 设计原则：**正常聊天几乎无感，只对异常刷屏动手**。
//   · 冷却、分钟级超限 → **静默排队**（等够了自动执行，用户只感觉"回得稍慢"）
//   · 小时 / 日额度用满 → 才给一句友好提示
//   · 惩罚期（连续超限 / 恶意刷屏）→ 静默丢弃，不回复（不跟刷屏的人对话）
//
// 三层限额：
//   用户级（QQ）：2s 冷却、8/分、60/时、200/日
//   群级（群号，私聊不参与）：20/分、200/时
//   全局：并发 3、30/分、队列 15、排队超时 20s
//
// 计数用**滑动窗口**（时间戳数组，按窗口回溯计数），不是固定窗口 —— 固定窗口在
// 整点边界会出现"一分钟内实际放行两倍"的突刺，滑动窗口没有这个问题。
//
// 配置全部由 initRateLimit() 注入（本模块不读 process.env），便于单测直接给定参数。
// ============================================================
import { logger } from './logger.js';

const DEFAULTS = {
  // ---- 用户级（按 QQ 号）----
  userCooldownMs: 2000, // 不足则排队
  userPerMinute: 8, // 超出则排队
  userPerHour: 60, // 超出则提示"稍后再试"
  userPerDay: 200, // 超出则提示"今日额度已用完"
  // ---- 群级（按群号；私聊不参与）----
  groupPerMinute: 20, // 超出则排队
  groupPerHour: 200, // 超出则排队
  // ---- 全局 ----
  globalMaxConcurrent: 3, // 信号量：同时在跑的 AI 请求数
  globalPerMinute: 30,
  queueMax: 15, // 等待队列上限，超出则拒绝
  queueTimeoutMs: 20000, // 排队超过则放弃并提示
  // ---- 惩罚 ----
  violationsToCooldown: 5, // 连续超限 N 次 → 冷却
  violationWindowMs: 60000, // "连续"的判定窗口
  penaltyCooldownMs: 30000, // 冷却时长（静默）
  floodWindowMs: 10000, // 恶意刷屏判定窗口
  floodCount: 15, // 窗口内请求数达到该值 → 禁言
  penaltyMuteMs: 300000, // 禁言时长（静默）
  // ---- 各级窗口长度（一般不用改；单测里会调小以便快速验证）----
  minuteWindowMs: 60000,
  hourWindowMs: 3600000,
  dayWindowMs: 86400000,
};

let cfg = { ...DEFAULTS };
/**
 * qq -> {
 *   hits:number[]        已**放行**的时刻（24h 内）—— 计入额度与冷却
 *   reqs:number[]        所有**到达**的时刻（短期）—— 只用于识别恶意刷屏
 *   last:number          最后一次放行时刻
 *   violations:number[]  最近"超限"次数（需要等待或被拒都算）
 *   penaltyUntil:number  惩罚截止时刻（此期间静默丢弃）
 * }
 */
const users = new Map();
/** gid -> { hits:number[] } */
const groups = new Map();
/** 全局：{ hits:number[](1 分钟内的放行时刻), active:number } */
const global = { hits: [], active: 0 };
/** 等待队列：{ seq, readyAt, userId, groupId, convKey, resolve, timer, settled } */
const queue = [];
/** 正在执行中的会话（同一会话串行，避免两条回复交叉） */
const inFlight = new Set();
let seq = 0;
let wakeTimer = null;
let reapTimer = null;

/** 距上一次因为限速给某个用户记日志的时间（避免刷屏） */
const logThrottle = new Map();
const LOG_THROTTLE_MS = 30000;

function logThrottled(key, msg) {
  const now = Date.now();
  const last = logThrottle.get(key) || 0;
  if (now - last < LOG_THROTTLE_MS) return;
  logThrottle.set(key, now);
  logger.info(msg);
}

/** 窗口内计数（hits 按时间升序，从后往前数到窗口外为止） */
function countWithin(hits, now, windowMs) {
  let n = 0;
  for (let i = hits.length - 1; i >= 0; i--) {
    if (hits[i] <= now - windowMs) break;
    n += 1;
  }
  return n;
}

/** 丢掉窗口外的旧时间戳，控制数组长度（保留 24 小时，日限额要用） */
function trimHits(hits, now, keepMs) {
  const cut = now - keepMs;
  let i = 0;
  while (i < hits.length && hits[i] <= cut) i += 1;
  if (i) hits.splice(0, i);
}

/** 要满足"窗口内不超过 limit 条"，最早得等到什么时候（已合规返回 0） */
function windowReadyAt(hits, now, windowMs, limit) {
  const n = countWithin(hits, now, windowMs);
  if (n < limit) return 0;
  // 让最早的那条（第 n-limit+1 个）滑出窗口即可
  return hits[hits.length - limit] + windowMs;
}

function userState(qq) {
  const k = String(qq || '');
  let s = users.get(k);
  if (!s) {
    s = { hits: [], reqs: [], last: 0, violations: [], penaltyUntil: 0 };
    users.set(k, s);
  }
  return s;
}

function groupState(gid) {
  const k = String(gid || '');
  let s = groups.get(k);
  if (!s) {
    s = { hits: [] };
    groups.set(k, s);
  }
  return s;
}

/** 记一次"超限"（需要等待或被拒绝都算）。短时间内攒够次数 → 冷却 */
function addViolation(u, now) {
  u.violations.push(now);
  trimHits(u.violations, now, cfg.violationWindowMs);
  if (u.violations.length >= cfg.violationsToCooldown) {
    u.violations = [];
    u.penaltyUntil = now + cfg.penaltyCooldownMs;
    return true;
  }
  return false;
}

function settle(task, result) {
  if (task.settled) return;
  task.settled = true;
  if (task.timer) clearTimeout(task.timer);
  const i = queue.indexOf(task);
  if (i >= 0) queue.splice(i, 1);
  task.resolve(result);
}

/**
 * 某个排队任务"此刻最早能跑到什么时候"。
 * 必须在**放行时重新计算**，不能用入队时算好的值：同一批排队任务在前一个被放行后，
 * 冷却起点（u.last）已经变了，沿用旧值会让 2 秒冷却失效、几条消息挤在一起发出去。
 */
function effectiveReadyAt(task, now) {
  const u = userState(task.userId);
  return Math.max(
    task.enqueuedAt,
    u.last + cfg.userCooldownMs,
    windowReadyAt(u.hits, now, cfg.minuteWindowMs, cfg.userPerMinute),
    task.groupId
      ? windowReadyAt(groupState(task.groupId).hits, now, cfg.minuteWindowMs, cfg.groupPerMinute)
      : 0,
    windowReadyAt(global.hits, now, cfg.minuteWindowMs, cfg.globalPerMinute),
  );
}

/** 选一个"已到点、且所在会话没有正在跑的任务"的最早入队者；没有返回 -1 */
function pickReadyIndex(now) {
  let best = -1;
  let bestSeq = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    if (inFlight.has(t.convKey)) continue;
    // 重算到点时间并写回，供 scheduleWake 使用
    t.readyAt = effectiveReadyAt(t, now);
    if (t.readyAt > now) continue;
    if (t.seq < bestSeq) {
      bestSeq = t.seq;
      best = i;
    }
  }
  return best;
}

/** 队列里最早的到点时间（用于安排唤醒） */
function nextReadyAt() {
  let min = Infinity;
  for (const t of queue) if (t.readyAt < min) min = t.readyAt;
  return min;
}

function scheduleWake() {
  if (wakeTimer || !queue.length) return;
  const at = nextReadyAt();
  const delay = Math.max(5, Math.min(at - Date.now(), cfg.queueTimeoutMs));
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    pump();
  }, delay);
  wakeTimer.unref?.();
}

/** 发放执行许可：并发没满就按序放行；满了/没到点就等 */
function pump() {
  const now = Date.now();
  while (global.active < cfg.globalMaxConcurrent) {
    const idx = pickReadyIndex(now);
    if (idx < 0) break;
    const t = queue[idx];
    queue.splice(idx, 1);
    if (t.timer) clearTimeout(t.timer);

    // 放行：此刻才真正计入各层窗口（排队等待不计额度，用户不该为"排队"买单）
    global.active += 1;
    global.hits.push(now);
    const u = userState(t.userId);
    u.last = now;
    u.hits.push(now);
    if (t.groupId) groupState(t.groupId).hits.push(now);

    const task = t;
    let released = false;
    task.settled = true;
    inFlight.add(task.convKey);
    task.resolve({
      ok: true,
      waitMs: now - task.enqueuedAt,
      release: () => {
        if (released) return; // 重复 release 不重复计数（调用方 finally 里可能兜底调用）
        released = true;
        inFlight.delete(task.convKey);
        global.active = Math.max(0, global.active - 1);
        pump();
      },
    });
  }
  scheduleWake();
}

/** 惰性清理：空的用户/群状态删掉，时间戳裁到 24 小时内 */
export function reap() {
  const now = Date.now();
  for (const [k, s] of users) {
    trimHits(s.hits, now, cfg.dayWindowMs);
    trimHits(s.reqs, now, Math.max(cfg.floodWindowMs * 3, cfg.minuteWindowMs));
    trimHits(s.violations, now, cfg.violationWindowMs);
    if (!s.hits.length && !s.reqs.length && !s.violations.length && s.penaltyUntil <= now) users.delete(k);
  }
  for (const [k, s] of groups) {
    trimHits(s.hits, now, cfg.hourWindowMs);
    if (!s.hits.length) groups.delete(k);
  }
  trimHits(global.hits, now, cfg.minuteWindowMs);
  for (const [k, t] of logThrottle) if (now - t > LOG_THROTTLE_MS) logThrottle.delete(k);
}

/**
 * 申请一次"可以调用 AI"的许可。
 * @param {{userId:string, groupId?:string, convKey:string}} req
 * @returns {Promise<{ok:true, waitMs:number, release:Function}
 *                 | {ok:false, reason:'penalty'|'hour'|'day'|'queue-full'|'timeout'}>}
 */
export function acquire(req = {}) {
  const now = Date.now();
  const userId = String(req.userId || '');
  const groupId = req.groupId ? String(req.groupId) : '';
  const convKey = String(req.convKey || (groupId ? 'g:' + groupId : 'p:' + userId));
  const u = userState(userId);

  // 记录"到达"（用于识别恶意刷屏：看的是请求得多快，不是放行得多快）
  u.reqs.push(now);
  trimHits(u.reqs, now, Math.max(cfg.floodWindowMs * 3, cfg.minuteWindowMs));

  // 1) 惩罚期：静默丢弃
  if (u.penaltyUntil > now) {
    return Promise.resolve({ ok: false, reason: 'penalty', penaltyUntil: u.penaltyUntil });
  }

  // 2) 恶意刷屏：单位时间内请求数远超正常值 → 直接禁言（静默）
  const floodN = countWithin(u.reqs, now, cfg.floodWindowMs);
  if (floodN >= cfg.floodCount) {
    u.penaltyUntil = now + cfg.penaltyMuteMs;
    logger.warn(
      `[限速] QQ ${userId} ${cfg.floodWindowMs / 1000}s 内 ${floodN} 次请求，禁言 ${cfg.penaltyMuteMs / 1000}s`,
    );
    return Promise.resolve({ ok: false, reason: 'penalty', penaltyUntil: u.penaltyUntil });
  }

  // 3) 小时 / 日额度用满：这两个排队也解决不了（要等很久），只能提示
  if (countWithin(u.hits, now, cfg.dayWindowMs) >= cfg.userPerDay) {
    if (addViolation(u, now))
      logger.warn(`[限速] QQ ${userId} 连续超限，冷却 ${cfg.penaltyCooldownMs / 1000}s`);
    else logThrottled('day:' + userId, `[限速] QQ ${userId} 触发日额度上限`);
    return Promise.resolve({ ok: false, reason: 'day' });
  }
  if (countWithin(u.hits, now, cfg.hourWindowMs) >= cfg.userPerHour) {
    if (addViolation(u, now))
      logger.warn(`[限速] QQ ${userId} 连续超限，冷却 ${cfg.penaltyCooldownMs / 1000}s`);
    else logThrottled('hour:' + userId, `[限速] QQ ${userId} 触发小时额度上限`);
    return Promise.resolve({ ok: false, reason: 'hour' });
  }

  // 4) 队列满：宁可提示也不无限积压
  if (queue.length >= cfg.queueMax) {
    if (addViolation(u, now))
      logger.warn(`[限速] QQ ${userId} 连续超限，冷却 ${cfg.penaltyCooldownMs / 1000}s`);
    else logThrottled('qfull', `[限速] 等待队列已满（${cfg.queueMax}），拒绝新请求`);
    return Promise.resolve({ ok: false, reason: 'queue-full' });
  }

  // 5) 冷却 + 三层分钟限额：算出"最早什么时候合规"，到点前静静排队（不拒绝）
  const readyAt = Math.max(
    now,
    u.last + cfg.userCooldownMs,
    windowReadyAt(u.hits, now, cfg.minuteWindowMs, cfg.userPerMinute),
    groupId ? windowReadyAt(groupState(groupId).hits, now, cfg.minuteWindowMs, cfg.groupPerMinute) : 0,
    windowReadyAt(global.hits, now, cfg.minuteWindowMs, cfg.globalPerMinute),
  );
  const needsWait = readyAt > now + 50; // 50ms 容差：正常间隔聊天不算"超限"
  if (needsWait && addViolation(u, now)) {
    logger.warn(`[限速] QQ ${userId} 连续超限，冷却 ${cfg.penaltyCooldownMs / 1000}s`);
    return Promise.resolve({ ok: false, reason: 'penalty', penaltyUntil: u.penaltyUntil });
  }

  const task = {
    seq: (seq += 1),
    readyAt,
    userId,
    groupId,
    convKey,
    enqueuedAt: now,
    resolve: null,
    timer: null,
    settled: false,
  };
  return new Promise((resolve) => {
    task.resolve = resolve;
    // 排队超时：等太久就别等了（对方多半已经忘了自己问过什么）
    task.timer = setTimeout(() => {
      if (task.settled) return;
      logThrottled(
        'timeout:' + userId,
        `[限速] QQ ${userId} 排队超时（${cfg.queueTimeoutMs / 1000}s），放弃本次请求`,
      );
      settle(task, { ok: false, reason: 'timeout' });
    }, cfg.queueTimeoutMs);
    task.timer.unref?.();
    queue.push(task);
    pump();
  });
}

/** 注入配置（可只给要覆盖的项） */
export function initRateLimit(overrides = {}) {
  cfg = { ...DEFAULTS, ...overrides };
  if (!reapTimer) {
    reapTimer = setInterval(reap, 60000);
    reapTimer.unref?.();
  }
  return { ...cfg };
}

/** 当前配置（只读副本） */
export function rateLimitConfig() {
  return { ...cfg };
}

/** 运行态快照（排查 / 测试用） */
export function rateLimitStats() {
  return {
    users: users.size,
    groups: groups.size,
    active: global.active,
    queued: queue.length,
    globalLastMinute: countWithin(global.hits, Date.now(), cfg.minuteWindowMs),
  };
}

/** 清空全部状态（测试用；也会停掉后台清理定时器） */
export function resetRateLimit() {
  users.clear();
  groups.clear();
  global.hits.length = 0;
  global.active = 0;
  inFlight.clear();
  logThrottle.clear();
  for (const t of queue) {
    if (t.timer) clearTimeout(t.timer);
    if (!t.settled) {
      t.settled = true;
      t.resolve({ ok: false, reason: 'timeout' });
    }
  }
  queue.length = 0;
  if (wakeTimer) clearTimeout(wakeTimer);
  if (reapTimer) clearInterval(reapTimer);
  wakeTimer = null;
  reapTimer = null;
  seq = 0;
}
