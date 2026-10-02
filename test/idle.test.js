import { describe, it, expect, afterEach, vi } from 'vitest';
import { isPeakHour, msUntilIdle, startIdleMaintenance } from '../idle.js';

/** 取一个"工作日"的指定时刻（避开周末，保证与星期几无关地稳定） */
function weekdayAt(h, m = 0) {
  const d = new Date(2026, 9, 5, h, m, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function weekendAt(h, m = 0) {
  const d = new Date(2026, 9, 5, h, m, 0, 0);
  while (d.getDay() !== 0 && d.getDay() !== 6) d.setDate(d.getDate() + 1);
  return d;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isPeakHour', () => {
  it('工作日高峰时段返回 true', () => {
    expect(isPeakHour(weekdayAt(9, 0))).toBe(true);
    expect(isPeakHour(weekdayAt(11, 59))).toBe(true);
    expect(isPeakHour(weekdayAt(14, 0))).toBe(true);
    expect(isPeakHour(weekdayAt(17, 59))).toBe(true);
  });

  it('工作日非高峰时段返回 false（含午休与边界）', () => {
    expect(isPeakHour(weekdayAt(8, 59))).toBe(false);
    expect(isPeakHour(weekdayAt(12, 0))).toBe(false); // 12:00 整已进入午休
    expect(isPeakHour(weekdayAt(13, 59))).toBe(false);
    expect(isPeakHour(weekdayAt(18, 0))).toBe(false); // 18:00 整已下班
    expect(isPeakHour(weekdayAt(3, 0))).toBe(false);
  });

  it('周末不算高峰', () => {
    expect(isPeakHour(weekendAt(10, 0))).toBe(false);
    expect(isPeakHour(weekendAt(15, 0))).toBe(false);
  });
});

describe('msUntilIdle', () => {
  it('非高峰返回 0（可以立刻干）', () => {
    expect(msUntilIdle(weekdayAt(8, 0))).toBe(0);
    expect(msUntilIdle(weekdayAt(13, 0))).toBe(0);
    expect(msUntilIdle(weekendAt(10, 0))).toBe(0);
  });

  it('上午高峰：等到 12:00', () => {
    expect(msUntilIdle(weekdayAt(10, 0))).toBe(2 * 3600000);
  });

  it('下午高峰：等到 18:00', () => {
    expect(msUntilIdle(weekdayAt(14, 30))).toBe(3.5 * 3600000);
  });
});

describe('startIdleMaintenance', () => {
  it('高峰时段不跑任务，会自动推迟到闲时再跑', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(weekdayAt(10, 0)); // 高峰
    let ran = 0;
    const h = startIdleMaintenance(
      [
        {
          name: 't',
          run: () => {
            ran += 1;
          },
        },
      ],
      {
        intervalMs: 1000,
        kickOffMs: 100,
      },
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(ran).toBe(0); // 高峰期一次都没跑

    // 时间推进到 12:00（高峰结束）——任务应当自己醒来执行
    await vi.advanceTimersByTimeAsync(2 * 3600000);
    expect(ran).toBeGreaterThan(0);
    h.stop();
  });

  it('闲时立即执行，并容忍任务内部报错', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(weekdayAt(20, 0)); // 闲时
    let ok = 0;
    const h = startIdleMaintenance(
      [
        {
          name: 'bad',
          run: () => {
            throw new Error('维护任务炸了');
          },
        },
        {
          name: 'good',
          run: () => {
            ok += 1;
          },
        },
      ],
      { intervalMs: 1000, kickOffMs: 50 },
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(ok).toBe(1); // 前一个任务抛错不影响后一个
    h.stop();
  });

  it('stop() 之后不再执行', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(weekdayAt(20, 0));
    let ran = 0;
    const h = startIdleMaintenance(
      [
        {
          name: 't',
          run: () => {
            ran += 1;
          },
        },
      ],
      {
        intervalMs: 100,
        kickOffMs: 10,
      },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(ran).toBe(1);
    h.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toBe(1); // 停了就不再跑
  });
});
