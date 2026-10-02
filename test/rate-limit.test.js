import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initRateLimit,
  acquire,
  reap,
  rateLimitStats,
  rateLimitConfig,
  resetRateLimit,
} from '../rateLimit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一个 promise，超时则抛（防止测试挂死） */
function withTimeout(p, ms = 3000) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('测试等待超时')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 测试用的基准配置：把窗口和冷却都调到几十~几百毫秒，跑得快又不失真。
 * 生产默认值见 rateLimit.js 的 DEFAULTS。
 */
const BASE = {
  userCooldownMs: 60,
  userPerMinute: 100,
  userPerHour: 1000,
  userPerDay: 5000,
  groupPerMinute: 1000,
  groupPerHour: 5000,
  globalMaxConcurrent: 10,
  globalPerMinute: 5000,
  queueMax: 20,
  queueTimeoutMs: 1000,
  violationsToCooldown: 5,
  violationWindowMs: 5000,
  penaltyCooldownMs: 200,
  floodWindowMs: 2000,
  floodCount: 1000,
  penaltyMuteMs: 200,
  minuteWindowMs: 300,
  hourWindowMs: 60000,
  dayWindowMs: 120000,
};

const config = (over = {}) => initRateLimit({ ...BASE, ...over });

/** 申请一次许可；ok 时自动 release（除非 keepOpen） */
async function use(userId, { groupId = '', convKey, keep = false } = {}) {
  const t = await withTimeout(acquire({ userId, groupId, convKey: convKey || convKeyOf(userId, groupId) }));
  if (t.ok && !keep) t.release();
  return t;
}

const convKeyOf = (userId, groupId) => (groupId ? `g:${groupId}:${userId}` : `p:${userId}`);

beforeEach(() => {
  resetRateLimit();
  config();
});

afterEach(() => {
  resetRateLimit();
});

describe('正常聊天无感', () => {
  it('按冷却间隔发送：全部立即通过，不排队', async () => {
    config({ userCooldownMs: 60 });
    for (let i = 0; i < 3; i++) {
      const t = await use('10001');
      expect(t.ok).toBe(true);
      expect(t.waitMs).toBeLessThan(30); // 没有被拖住
      await sleep(70);
    }
  });

  it('第一条永远是立即通过的（不会被自己的空状态挡住）', async () => {
    const t0 = Date.now();
    const t = await use('10002');
    expect(t.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(30);
  });
});

describe('用户级冷却：排队而不是拒绝', () => {
  it('连发两条：第二条静默排队等待冷却，而不是被拒', async () => {
    config({ userCooldownMs: 120, minuteWindowMs: 5000 });
    const a = await use('10003');
    expect(a.ok).toBe(true);
    expect(a.waitMs).toBeLessThan(30);

    const t0 = Date.now();
    const b = await use('10003');
    expect(b.ok).toBe(true); // 关键：是排队放行，不是拒绝
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it('1 秒内连发 5 条：全部正常放行，且被冷却拉开间隔', async () => {
    config({ userCooldownMs: 60, minuteWindowMs: 5000, violationsToCooldown: 100 });
    const start = Date.now();
    const tickets = await Promise.all(
      Array.from({ length: 5 }, (_, i) => use('10004', { convKey: `p:10004:${i}` })),
    );
    for (const t of tickets) expect(t.ok).toBe(true);
    // 5 条按 60ms 冷却依次放行 → 总耗时明显大于 4*60ms，说明确实排了队
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });
});

describe('同一会话串行（原有行为不丢）', () => {
  it('上一条没结束时，同会话的下一条排队等待', async () => {
    config({ userCooldownMs: 0, globalMaxConcurrent: 5, minuteWindowMs: 5000 });
    const first = await use('10005', { keep: true });
    expect(first.ok).toBe(true);

    let secondDone = false;
    const secondP = use('10005').then((t) => {
      secondDone = true;
      return t;
    });
    await sleep(80);
    expect(secondDone).toBe(false); // 还在排队，没有插队

    first.release();
    const second = await withTimeout(secondP);
    expect(second.ok).toBe(true);
  });
});

describe('群级限速', () => {
  it('同群多人小窗口内超限：排队放行', async () => {
    config({ userCooldownMs: 0, groupPerMinute: 1, minuteWindowMs: 250 });
    const a = await use('10006', { groupId: '555' });
    expect(a.ok).toBe(true);

    const t0 = Date.now();
    const b = await use('10007', { groupId: '555' });
    expect(b.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  });

  it('私聊不参与群级限速', async () => {
    config({ userCooldownMs: 0, groupPerMinute: 1, minuteWindowMs: 5000 });
    const a = await use('10008'); // 无 groupId
    const t0 = Date.now();
    const b = await use('10008');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe('全局并发（信号量）', () => {
  it('并发不超过配置值，多出来的排队等待', async () => {
    config({ userCooldownMs: 0, globalMaxConcurrent: 2, minuteWindowMs: 5000 });
    const t1 = await use('20001', { keep: true });
    const t2 = await use('20002', { keep: true });
    expect(t1.ok).toBe(true);
    expect(t2.ok).toBe(true);
    expect(rateLimitStats().active).toBe(2);

    let thirdResolved = false;
    const thirdP = use('20003').then((t) => {
      thirdResolved = true;
      return t;
    });
    await sleep(80);
    expect(thirdResolved).toBe(false); // 并发已满，排队中

    t1.release();
    const third = await withTimeout(thirdP);
    expect(third.ok).toBe(true);
    expect(rateLimitStats().active).toBeLessThanOrEqual(2);

    t2.release();
    third.release();
    expect(rateLimitStats().active).toBe(0);
  });

  it('重复 release 不会把并发数减成负数', async () => {
    config({ userCooldownMs: 0, minuteWindowMs: 5000 });
    const t = await use('20004', { keep: true });
    t.release();
    t.release();
    t.release();
    expect(rateLimitStats().active).toBe(0);
  });
});

describe('队列上限与排队超时', () => {
  it('队列满了直接拒绝（提示友好文案由调用方给）', async () => {
    config({ userCooldownMs: 0, globalMaxConcurrent: 1, queueMax: 2, minuteWindowMs: 5000 });
    const t1 = await use('30001', { keep: true });
    expect(t1.ok).toBe(true);
    // 占满队列的 2 个
    const q1 = use('30002');
    const q2 = use('30003');
    await sleep(30);
    expect(rateLimitStats().queued).toBe(2);

    const overflow = await use('30004');
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toBe('queue-full');

    t1.release();
    await withTimeout(q1);
    await withTimeout(q2);
  });

  it('排队超过上限时间就放弃，返回 timeout', async () => {
    config({ userCooldownMs: 0, globalMaxConcurrent: 1, queueTimeoutMs: 120, minuteWindowMs: 5000 });
    const t1 = await use('30005', { keep: true });
    const t0 = Date.now();
    const waited = await use('30006');
    expect(waited.ok).toBe(false);
    expect(waited.reason).toBe('timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    t1.release();
  });
});

describe('小时 / 日额度：超了才提示', () => {
  it('超过小时上限 → reason=hour', async () => {
    config({ userCooldownMs: 0, userPerHour: 2, hourWindowMs: 60000, minuteWindowMs: 5000 });
    expect((await use('40001')).ok).toBe(true);
    expect((await use('40001')).ok).toBe(true);
    const t = await use('40001');
    expect(t.ok).toBe(false);
    expect(t.reason).toBe('hour');
  });

  it('超过日上限 → reason=day', async () => {
    config({
      userCooldownMs: 0,
      userPerHour: 100,
      userPerDay: 2,
      minuteWindowMs: 5000,
      dayWindowMs: 120000,
    });
    expect((await use('40002')).ok).toBe(true);
    expect((await use('40002')).ok).toBe(true);
    const t = await use('40002');
    expect(t.ok).toBe(false);
    expect(t.reason).toBe('day');
  });

  it('小时窗口滑出后额度恢复', async () => {
    config({ userCooldownMs: 0, userPerHour: 1, hourWindowMs: 250, minuteWindowMs: 5000 });
    expect((await use('40003')).ok).toBe(true);
    expect((await use('40003')).ok).toBe(false);
    await sleep(300);
    expect((await use('40003')).ok).toBe(true);
  });
});

describe('惩罚机制', () => {
  it('连续超限达到阈值 → 进入静默冷却', async () => {
    config({
      userCooldownMs: 120,
      minuteWindowMs: 10000,
      violationsToCooldown: 3,
      penaltyCooldownMs: 250,
    });
    expect((await use('50001')).ok).toBe(true); // 1：立即
    expect((await use('50001')).ok).toBe(true); // 2：等一次 → 超限 1
    expect((await use('50001')).ok).toBe(true); // 3：等一次 → 超限 2

    const punished = await use('50001'); // 超限 3 → 触发冷却
    expect(punished.ok).toBe(false);
    expect(punished.reason).toBe('penalty');

    const during = await use('50001'); // 冷却期内：静默丢弃
    expect(during.ok).toBe(false);
    expect(during.reason).toBe('penalty');

    await sleep(300); // 冷却结束
    expect((await use('50001')).ok).toBe(true);
  });

  it('短时间大量请求 → 直接禁言（静默）', async () => {
    config({
      userCooldownMs: 0,
      minuteWindowMs: 5000,
      floodWindowMs: 300,
      floodCount: 5,
      penaltyMuteMs: 200,
    });
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await acquire({ userId: '50002', convKey: `p:50002:${i}` }));
    }
    const last = results[4];
    expect(last.ok).toBe(false);
    expect(last.reason).toBe('penalty');

    const during = await use('50002');
    expect(during.reason).toBe('penalty');

    // 刷屏窗口内再来还是会被续期，所以必须等过整个刷屏窗口才算真正解禁
    await sleep(400);
    expect((await use('50002')).ok).toBe(true);
  });

  it('惩罚只针对该用户，不影响别人', async () => {
    config({
      userCooldownMs: 0,
      minuteWindowMs: 5000,
      floodWindowMs: 1000,
      floodCount: 3,
      penaltyMuteMs: 300,
    });
    for (let i = 0; i < 3; i++) await acquire({ userId: '50003', convKey: `p:50003:${i}` });
    expect((await use('50003')).reason).toBe('penalty');
    expect((await use('50004')).ok).toBe(true); // 另一个人照常
  });
});

describe('状态清理', () => {
  it('reap 清掉过期用户/群状态，不无限涨', async () => {
    // floodWindowMs 也调小，否则每个用户的"到达"记录会保留更久（生产里是 60 秒，有界且很小）
    config({
      userCooldownMs: 0,
      minuteWindowMs: 100,
      hourWindowMs: 200,
      dayWindowMs: 300,
      floodWindowMs: 100,
    });
    await use('60001', { groupId: '777' });
    expect(rateLimitStats().users).toBe(1);
    expect(rateLimitStats().groups).toBe(1);

    await sleep(400);
    reap();
    expect(rateLimitStats().users).toBe(0);
    expect(rateLimitStats().groups).toBe(0);
  });

  it('配置可注入且能被读回', () => {
    config({ userPerMinute: 42 });
    expect(rateLimitConfig().userPerMinute).toBe(42);
    // 未覆盖的项保持默认
    expect(rateLimitConfig().queueMax).toBe(BASE.queueMax);
  });
});
