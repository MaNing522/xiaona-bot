import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initBindings, startBind, answerCaptcha, getGameIdsOf, maxPerQQ, limitOf, setLimit, setGlobalMaxPerQQ } from '../src/binding.js';

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

  it('中文与短ID 可以绑定', () => {
    expect(startBind('10003', '带中文').ok).toBe(true);
    expect(startBind('10004', 'a').ok).toBe(true);
  });

  it('非法游戏ID 被拒绝，不进入待验证', () => {
    expect(startBind('10001', 'bad name').ok).toBe(false);
    expect(startBind('10001', 'a'.repeat(17)).ok).toBe(false);
    expect(startBind('10001', '小明!').ok).toBe(false);
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

describe('一个游戏ID只能绑定一个QQ', () => {
  it('已被别人绑定的ID 不能再发起绑定（大小写不敏感）', () => {
    startBind('10001', 'Steve');
    expect(answerCaptcha('10001', '1111').ok).toBe(true);
    const r = startBind('20002', 'steve');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已经被其他 QQ 绑定');
  });

  it('验证码期间被别的QQ抢先绑定 → 答对也不生效', () => {
    expect(startBind('10001', 'Steve').ok).toBe(true);
    expect(startBind('20002', 'Steve').ok).toBe(true);
    expect(answerCaptcha('20002', '1111').ok).toBe(true);
    const r = answerCaptcha('10001', '1111');
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.msg).toContain('已经被其他 QQ 绑定');
    expect(getGameIdsOf('10001')).toEqual([]);
  });

  it('同一个QQ 仍然可以绑定多个不同ID', () => {
    expect(startBind('10001', 'Steve').ok).toBe(true);
    expect(answerCaptcha('10001', '1111').ok).toBe(true);
    expect(startBind('10001', 'Alex').ok).toBe(true);
    expect(answerCaptcha('10001', '1111').ok).toBe(true);
    expect(getGameIdsOf('10001')).toEqual(['Steve', 'Alex']);
  });
});

describe('每人绑定上限（全局默认 + 单QQ覆盖）', () => {
  it('默认用全局上限', () => {
    expect(limitOf('10001')).toBe(3);
  });

  it('setLimit 单人覆盖后按其上限拦截', () => {
    setLimit('10001', 1);
    expect(limitOf('10001')).toBe(1);
    expect(limitOf('10002')).toBe(3); // 其他人不受影响
    expect(startBind('10001', 'Steve').ok).toBe(true);
    expect(answerCaptcha('10001', '1111').ok).toBe(true);
    expect(startBind('10001', 'Alex').ok).toBe(false);
  });

  it('setLimit(0) 清除覆盖、回退全局默认', () => {
    setLimit('10001', 1);
    const r = setLimit('10001', 0);
    expect(r.ok).toBe(true);
    expect(limitOf('10001')).toBe(3);
  });

  it('覆盖值落盘：重新 init 后仍生效', () => {
    setLimit('10001', 2);
    initBindings(dir, { maxPerQq: 3, ttlSec: 300 });
    expect(limitOf('10001')).toBe(2);
  });

  it('setGlobalMaxPerQQ 改全局默认，不影响已有覆盖', () => {
    setLimit('10001', 1);
    setGlobalMaxPerQQ(5);
    expect(maxPerQQ()).toBe(5);
    expect(limitOf('10002')).toBe(5);
    expect(limitOf('10001')).toBe(1);
  });
});
