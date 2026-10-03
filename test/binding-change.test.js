import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initBindings, startBind, answerCaptcha, unbind, forceUnbind, getQqOf } from '../binding.js';

let dir;
/** 回调收到的游戏ID（按调用顺序累积） */
let seen;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-bindchange-'));
  // 固定 Math.random → 验证码答案恒为 '1111'
  vi.spyOn(Math, 'random').mockReturnValue(0.1);
  seen = [];
  initBindings(dir, { maxPerQq: 3, ttlSec: 300, onChange: (ids) => seen.push(...ids) });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('绑定变化通知（用于刷新游戏内计分板）', () => {
  it('绑定成功后通知该游戏ID', () => {
    startBind('10001', 'Steve');
    expect(answerCaptcha('10001', '1111').ok).toBe(true);
    expect(seen).toEqual(['Steve']);
  });

  it('验证码答错 / 未答完，不通知', () => {
    startBind('10001', 'Steve');
    answerCaptcha('10001', '0000');
    expect(seen).toEqual([]);
  });

  it('解绑单个ID → 通知该ID', () => {
    startBind('10001', 'Steve');
    answerCaptcha('10001', '1111');
    seen.length = 0;
    expect(unbind('10001', 'Steve').ok).toBe(true);
    expect(seen).toEqual(['Steve']);
  });

  it('解绑全部 → 逐个通知被解绑的ID', () => {
    for (const id of ['Aaa', 'Bbb']) {
      startBind('10001', id);
      answerCaptcha('10001', '1111');
    }
    seen.length = 0;
    unbind('10001', 'all');
    expect(seen.slice().sort()).toEqual(['Aaa', 'Bbb']);
  });

  it('强制解绑单个ID → 通知该ID', () => {
    startBind('10001', 'Steve');
    answerCaptcha('10001', '1111');
    seen.length = 0;
    expect(forceUnbind('10001', 'Steve').ok).toBe(true);
    expect(seen).toEqual(['Steve']);
  });

  it('强制解绑该QQ全部 → 逐个通知', () => {
    for (const id of ['Aaa', 'Bbb']) {
      startBind('10001', id);
      answerCaptcha('10001', '1111');
    }
    seen.length = 0;
    forceUnbind('10001');
    expect(seen.slice().sort()).toEqual(['Aaa', 'Bbb']);
  });

  it('没找到要解绑的ID时，不通知', () => {
    startBind('10001', 'Steve');
    answerCaptcha('10001', '1111');
    seen.length = 0;
    expect(unbind('10001', 'NotExist').ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it('回调抛错不影响绑定本身的结果', () => {
    initBindings(dir, {
      maxPerQq: 3,
      ttlSec: 300,
      onChange: () => {
        throw new Error('回调炸了');
      },
    });
    startBind('10001', 'Steve');
    const r = answerCaptcha('10001', '1111');
    expect(r.ok).toBe(true); // 绑定依然成功
  });

  it('重新初始化未传 onChange 时不再回调（不沿用上一轮）', () => {
    initBindings(dir, { maxPerQq: 3, ttlSec: 300 });
    startBind('10001', 'Steve');
    answerCaptcha('10001', '1111');
    expect(seen).toEqual([]);
  });
});

describe('getQqOf（游戏ID → QQ 反查，游戏内指令靠它认身份）', () => {
  it('已绑定的ID能反查到QQ，且大小写不敏感', () => {
    startBind('10001', 'Steve');
    answerCaptcha('10001', '1111');
    expect(getQqOf('Steve')).toBe('10001');
    expect(getQqOf('steve')).toBe('10001');
  });

  it('没绑定的ID / 空输入 → 空串', () => {
    expect(getQqOf('Nobody')).toBe('');
    expect(getQqOf('')).toBe('');
    expect(getQqOf(undefined)).toBe('');
  });

  it('解绑之后就反查不到了', () => {
    startBind('10001', 'Steve');
    answerCaptcha('10001', '1111');
    expect(getQqOf('Steve')).toBe('10001');
    unbind('10001', 'Steve');
    expect(getQqOf('Steve')).toBe('');
  });

  it('多个QQ绑同名ID时，反查得到其中一个', () => {
    startBind('10001', 'Alex');
    answerCaptcha('10001', '1111');
    expect(['10001', '10002']).toContain(getQqOf('Alex'));
  });
});
