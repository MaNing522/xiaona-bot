// mcbridge 假人识别：Carpet 假人（前缀 假的_）的进/退/发言不转发到桥接群。
import { describe, it, expect } from 'vitest';
import { isFakePlayer } from '../src/mcbridge.js';

describe('isFakePlayer（假人前缀识别）', () => {
  it('"假的_" 前缀视为假人', () => {
    expect(isFakePlayer('假的_Steve')).toBe(true);
    expect(isFakePlayer('假的_Alex01')).toBe(true);
  });

  it('正常玩家不是假人', () => {
    expect(isFakePlayer('Steve')).toBe(false);
    expect(isFakePlayer('Steve假的_x')).toBe(false); // 前缀匹配，只看开头
    expect(isFakePlayer('')).toBe(false);
    expect(isFakePlayer(null)).toBe(false);
    expect(isFakePlayer(undefined)).toBe(false);
  });
});
