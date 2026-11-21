import { describe, it, expect } from 'vitest';
import { parseTarget, formatStatus } from '../src/mcbot.js';

describe('mcbot 进服地址解析', () => {
  it('默认端口 25565', () => {
    expect(parseTarget('play.example.com')).toEqual({ host: 'play.example.com', port: 25565 });
  });

  it('地址里带端口优先于参数', () => {
    expect(parseTarget('1.2.3.4:25566', 1234)).toEqual({ host: '1.2.3.4', port: 25566 });
  });

  it('去掉 http:// 和路径', () => {
    expect(parseTarget('https://mc.example.com:25567/', 0)).toEqual({ host: 'mc.example.com', port: 25567 });
  });

  it('空地址与非法端口报错', () => {
    expect(() => parseTarget('')).toThrow(/地址/);
    expect(() => parseTarget('a.com:70000')).toThrow(/端口/);
  });
});

describe('mcbot 状态文本', () => {
  it('未启动时提示先进服', () => {
    expect(formatStatus(null)).toContain('mcbot_join');
  });

  it('未进服 / 连接中', () => {
    const notJoined = formatStatus({ connected: false, spawned: false, server: { host: '1.2.3.4', port: 25565, wantConnect: false } });
    expect(notJoined).toContain('不在服务器');
    const connecting = formatStatus({ connected: false, spawned: false, server: { host: '1.2.3.4', port: 25565, wantConnect: true }, auth: 'unknown' });
    expect(connecting).toContain('正在连接');
  });

  it('已进服时输出坐标、血量和背包', () => {
    const text = formatStatus({
      connected: true,
      spawned: true,
      server: { host: '1.2.3.4', port: 25565, version: '1.21.11' },
      pos: { x: 10, y: 64, z: -3 },
      health: 20,
      food: 18,
      gamemode: 'survival',
      inventory: { dirt: 3, bread: 1 },
      players: [{ name: 'Steve', distance: 12.3 }],
      mode: { kind: 'collect' },
      collect: { type: 'diamond_ore', done: 2, total: 8 },
    });
    expect(text).toContain('10, 64, -3');
    expect(text).toContain('血量：20');
    expect(text).toContain('dirtx3');
    expect(text).toContain('Steve');
    expect(text).toContain('diamond_ore 2/8');
  });
});
