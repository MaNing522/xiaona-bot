import { describe, it, expect } from 'vitest';
import { randomDelayMs, normalizeQzone, qzoneStatus, postQzoneNow } from '../src/qzone.js';

const DAY = 24 * 60 * 60 * 1000;

describe('QQ 空间自动说说', () => {
  it('随机间隔落在设定天数范围内', () => {
    expect(randomDelayMs(1, 7, () => 0)).toBe(DAY);
    expect(randomDelayMs(1, 7, () => 1)).toBe(7 * DAY);
    expect(randomDelayMs(1, 7, () => 0.5)).toBe(4 * DAY);
  });

  it('参数校正：天数夹在 1~7，min/max 颠倒时自动交换', () => {
    const q = normalizeQzone({ minDays: 9, maxDays: 0, commentEvery: 99, checkMinutes: 1, maxLength: 1 });
    expect(q.minDays).toBe(1);
    expect(q.maxDays).toBe(7);
    expect(q.commentEvery).toBe(10);
    expect(q.checkMinutes).toBe(5);
    expect(q.maxLength).toBe(20);
  });

  it('未知查看权限回落到公开，开关默认开启', () => {
    const q = normalizeQzone({ ugcRight: 9999 });
    expect(q.ugcRight).toBe(1);
    expect(q.enabled).toBe(true);
    expect(normalizeQzone({ enabled: false }).enabled).toBe(false);
    expect(normalizeQzone({ replyComments: false }).replyComments).toBe(false);
  });

  it('状态里带当前参数和调度信息', () => {
    const s = qzoneStatus();
    expect(s).toHaveProperty('nextAt');
    expect(s).toHaveProperty('postCount');
    expect(s.commentEvery).toBeGreaterThanOrEqual(0);
    expect([1, 4, 64]).toContain(s.ugcRight);
  });

  it('未初始化时手动发布给出明确错误', async () => {
    await expect(postQzoneNow()).rejects.toThrow('机器人未连接');
  });
});
