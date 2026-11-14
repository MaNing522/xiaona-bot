import { describe, it, expect } from 'vitest';
import { yawOfDirection, status, chat, command, nearbyPlayers, login } from '../src/mcbot.js';

describe('mcbot 基础', () => {
  it('指南针方向映射到 MC yaw', () => {
    expect(yawOfDirection('south')).toBe(0);
    expect(yawOfDirection('north')).toBeCloseTo(Math.PI);
    expect(yawOfDirection('east')).toBeCloseTo(-Math.PI / 2);
    expect(yawOfDirection('west')).toBeCloseTo(Math.PI / 2);
    expect(yawOfDirection('forward')).toBe(null);
    expect(yawOfDirection('随便写')).toBe(null);
  });

  it('离线时状态为离线，动作给出明确提示', () => {
    expect(status()).toContain('离线');
    expect(() => chat('你好')).toThrow(/不在服务器/);
    expect(() => command('/spawn')).toThrow(/不在服务器/);
    expect(() => nearbyPlayers()).toThrow(/不在服务器/);
  });

  it('离线时辅助登录也提示先进服', async () => {
    await expect(login('auto')).rejects.toThrow(/不在服务器/);
  });
});
