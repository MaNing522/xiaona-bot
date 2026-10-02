import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initBindings, startBind, answerCaptcha, getGameIdsOf, maxPerQQ } from '../binding.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-binding-'));
  // 固定 Math.random → startBind 生成的答案恒为 '1111'，测试里才能「猜对」
  vi.spyOn(Math, 'random').mockReturnValue(0.1);
  initBindings(dir, { maxPerQq: 3, ttlSec: 300 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('startBind', () => {
  it('合法游戏ID 返回验证码图片', () => {
    const r = startBind('10001', 'Steve');
    expect(r.ok).toBe(true);
    expect(Buffer.isBuffer(r.image)).toBe(true);
    expect(r.gameId).toBe('Steve');
    expect(r.ttlSec).toBe(300);
  });

  it('非法游戏ID 被拒绝，不进入待验证', () => {
    expect(startBind('10001', 'a').ok).toBe(false);
    expect(startBind('10001', '带中文').ok).toBe(false);
    // 没进入待验证 → 随便发数字不该被消费
    expect(answerCaptcha('10001', '1111').handled).toBe(false);
  });

  it('重复绑定同一ID 被拒绝', () => {
    startBind('10001', 'Steve');
    answerCaptcha('10001', '1111');
    const again = startBind('10001', 'steve'); // 大小写不敏感
    expect(again.ok).toBe(false);
    expect(again.error).toContain('已经绑定过');
  });

  it('超过每人上限被拒绝', () => {
    for (const id of ['Aaa', 'Bbb', 'Ccc']) {
      expect(startBind('10001', id).ok).toBe(true);
      expect(answerCaptcha('10001', '1111').ok).toBe(true);
    }
    expect(getGameIdsOf('10001')).toHaveLength(3);
    const r = startBind('10001', 'Ddd');
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`最多绑定 ${maxPerQQ()}`);
  });
});

describe('answerCaptcha', () => {
  it('答对 → 绑定成功', () => {
    startBind('10001', 'Steve');
    const r = answerCaptcha('10001', '1111');
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(true);
    expect(getGameIdsOf('10001')).toEqual(['Steve']);
  });

  it('答错 → 次数+1，剩余次数递减', () => {
    startBind('10001', 'Steve');
    const r1 = answerCaptcha('10001', '0000');
    expect(r1).toMatchObject({ handled: true, ok: false });
    expect(r1.msg).toContain('还能再试 4 次');
    const r2 = answerCaptcha('10001', '0000');
    expect(r2.msg).toContain('还能再试 3 次');
  });

  it('连错 5 次 → 取消待验证', () => {
    startBind('10001', 'Steve');
    let last;
    for (let i = 0; i < 5; i++) last = answerCaptcha('10001', '0000');
    expect(last.ok).toBe(false);
    expect(last.msg).toContain('连错 5 次');
    // 已取消 → 再发正确答案也不再消费
    expect(answerCaptcha('10001', '1111').handled).toBe(false);
  });

  it('非 4 位数字不消费、不扣次数', () => {
    startBind('10001', 'Steve');
    expect(answerCaptcha('10001', '你好呀小钠').handled).toBe(false);
    expect(answerCaptcha('10001', '我买了 1000 个方块').handled).toBe(false);
    // 次数没被扣：第一次答错仍提示「还能再试 4 次」
    expect(answerCaptcha('10001', '0000').msg).toContain('还能再试 4 次');
  });

  it('允许带 @昵称 前缀的答案', () => {
    startBind('10001', 'Steve');
    expect(answerCaptcha('10001', '@小钠 1111').ok).toBe(true);
  });

  it('过期 → 提示重新绑定', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    startBind('10001', 'Steve');
    vi.setSystemTime(1_000_000 + 301 * 1000);
    const r = answerCaptcha('10001', '1111');
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.msg).toContain('已过期');
  });

  it('没有待验证时返回 handled:false', () => {
    expect(answerCaptcha('99999', '1111')).toEqual({ handled: false });
  });
});
