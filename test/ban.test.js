import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initBindings, startBind, answerCaptcha, banUser, unbanUser, isBanned, parseBanTime, humanDuration, getGameIdsOf } from '../binding.js';

const YEAR = 365 * 24 * 3600 * 1000;

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-ban-'));
  // 固定 Math.random → 验证码答案恒为 '1111'
  vi.spyOn(Math, 'random').mockReturnValue(0.1);
  initBindings(dir, { maxPerQq: 3, ttlSec: 300 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseBanTime（封禁时间解析）', () => {
  it('组合单位 → 毫秒', () => {
    const r = parseBanTime('5y3d3h3m3s');
    expect(r.permanent).toBe(false);
    expect(r.ms).toBe(5 * YEAR + 3 * 24 * 3600 * 1000 + 3 * 3600 * 1000 + 3 * 60 * 1000 + 3 * 1000);
  });

  it('部分单位：1h5s', () => {
    expect(parseBanTime('1h5s').ms).toBe(3600 * 1000 + 5 * 1000);
  });

  it('空 / n / 永久 → 永久', () => {
    expect(parseBanTime('').permanent).toBe(true);
    expect(parseBanTime('n').permanent).toBe(true);
    expect(parseBanTime('n').ms).toBe(0);
    expect(parseBanTime('永久').permanent).toBe(true);
  });

  it('不是时间 → null', () => {
    expect(parseBanTime('开挂')).toBeNull();
    expect(parseBanTime('y')).toBeNull();
  });
});

describe('humanDuration', () => {
  it('按年天时分秒拼装，空为 0秒', () => {
    expect(humanDuration(5 * YEAR + 3 * 24 * 3600 * 1000 + 3 * 3600 * 1000 + 3 * 60 * 1000 + 3 * 1000)).toBe('5年3天3小时3分3秒');
    expect(humanDuration(0)).toBe('0秒');
  });
});

describe('banUser / isBanned（封禁与解绑）', () => {
  async function bindQq(qq, id) {
    expect(startBind(qq, id).ok).toBe(true);
    expect(answerCaptcha(qq, '1111').ok).toBe(true);
  }

  it('封禁 → 解绑名下所有账号，且 isBanned 命中', async () => {
    await bindQq('10001', 'Steve');
    await bindQq('10001', 'Alex');
    const r = banUser('10001', '5y3d3h3m3s', '开挂');
    expect(r.ok).toBe(true);
    expect(r.permanent).toBe(false);
    expect(r.reason).toBe('开挂');
    expect(r.ids.slice().sort()).toEqual(['Alex', 'Steve']);
    expect(getGameIdsOf('10001')).toEqual([]);
    expect(isBanned('10001')).not.toBeNull();
  });

  it('不填时间 → 永久', async () => {
    const r = banUser('10002');
    expect(r.ok).toBe(true);
    expect(r.permanent).toBe(true);
    expect(r.until).toBe(0);
    expect(isBanned('10002')).toEqual({ until: 0, reason: '', at: expect.any(Number) });
  });

  it('时间位置填了非时间内容 → 当作原因，按永久处理', () => {
    const r = banUser('10003', '破坏', '');
    expect(r.ok).toBe(true);
    expect(r.permanent).toBe(true);
    expect(r.reason).toBe('破坏');
  });

  it('n → 永久', () => {
    expect(banUser('10004', 'n', '破坏').permanent).toBe(true);
  });

  it('被封禁的 QQ 无法再发起绑定', () => {
    banUser('10005', '1h', '骂人');
    const r = startBind('10005', 'Steve');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已被封禁');
    expect(r.error).toContain('骂人');
  });

  it('过期后自动解封', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    banUser('10006', '1h', '');
    expect(isBanned('10006')).not.toBeNull();
    vi.setSystemTime(1_000_000 + 3600 * 1000 + 1);
    expect(isBanned('10006')).toBeNull();
    expect(startBind('10006', 'Steve').ok).toBe(true);
  });

  it('封禁时若已有待验证，验证码不再放行', () => {
    startBind('10007', 'Steve');
    banUser('10007');
    const r = answerCaptcha('10007', '1111');
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(false);
    expect(getGameIdsOf('10007')).toEqual([]);
  });

  it('QQ 号格式不对 → 拒绝', () => {
    expect(banUser('abc').ok).toBe(false);
  });

  it('封禁记录落盘，重新初始化后仍在', () => {
    banUser('10008', 'n', '测试');
    initBindings(dir, { maxPerQq: 3, ttlSec: 300 });
    expect(isBanned('10008')).not.toBeNull();
  });
});

describe('unbanUser（解封）', () => {
  it('解封后在名单中消失，可重新绑定', () => {
    banUser('20001', 'n', '测试');
    expect(isBanned('20001')).not.toBeNull();
    expect(unbanUser('20001').ok).toBe(true);
    expect(isBanned('20001')).toBeNull();
    expect(startBind('20001', 'Steve').ok).toBe(true);
  });

  it('不在封禁名单 → 返回错误', () => {
    const r = unbanUser('20002');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不在封禁名单');
  });

  it('QQ 号格式不对 → 拒绝', () => {
    expect(unbanUser('abc').ok).toBe(false);
  });

  it('解封会落盘', () => {
    banUser('20003', 'n', '');
    unbanUser('20003');
    initBindings(dir, { maxPerQq: 3, ttlSec: 300 });
    expect(isBanned('20003')).toBeNull();
  });
});
