import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { signedHeaders, startMcBridge, bridgeTargetOf, planAvailableFrom, getBridgeCaps } from '../src/mcbridge.js';

const SECRET = 's'.repeat(40);

/** 用给定 ts/nonce/body 重算签名，用于和被测函数对拍 */
const hmac = (ts, nonce, body) =>
  crypto.createHmac('sha256', SECRET).update(`${ts}\n${nonce}\n${body}`).digest('hex');

beforeEach(() => {
  // base 留空 → startMcBridge 只初始化 cfg，不发起任何网络连接
  vi.stubEnv('MC_BRIDGE_URL', '');
  vi.stubEnv('MC_BRIDGE_SECRET', SECRET);
  vi.stubEnv('MC_BRIDGE_FROM', '');
  startMcBridge({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('signedHeaders', () => {
  it('返回 ts / nonce / sig 三个头', () => {
    const h = signedHeaders('hello');
    expect(h['X-Xiaona-Ts']).toBeDefined();
    expect(h['X-Xiaona-Nonce']).toBeDefined();
    expect(h['X-Xiaona-Sig']).toBeDefined();
  });

  it('ts 为 10 位秒级时间戳', () => {
    const h = signedHeaders('');
    expect(h['X-Xiaona-Ts']).toMatch(/^\d{10}$/);
    expect(Math.abs(Number(h['X-Xiaona-Ts']) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
  });

  it('nonce 为 32 位小写 hex', () => {
    const h = signedHeaders('');
    expect(h['X-Xiaona-Nonce']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('签名串为 ts\\nnonce\\nbody，算法 HMAC-SHA256 hex 小写', () => {
    const h = signedHeaders('{"a":1}');
    const expected = hmac(h['X-Xiaona-Ts'], h['X-Xiaona-Nonce'], '{"a":1}');
    expect(h['X-Xiaona-Sig']).toBe(expected);
    expect(h['X-Xiaona-Sig']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('body 为 null（GET）时按空串签名', () => {
    const h = signedHeaders(null);
    expect(h['X-Xiaona-Sig']).toBe(hmac(h['X-Xiaona-Ts'], h['X-Xiaona-Nonce'], ''));
  });

  it('每次签名的 nonce 都不同', () => {
    expect(signedHeaders('')['X-Xiaona-Nonce']).not.toBe(signedHeaders('')['X-Xiaona-Nonce']);
  });

  it('未配置 MC_BRIDGE_FROM 时不带 From 头', () => {
    expect(signedHeaders('')['X-Xiaona-From']).toBeUndefined();
  });

  it('配置 MC_BRIDGE_FROM 后带上 From 头', () => {
    vi.stubEnv('MC_BRIDGE_FROM', '203.0.113.7');
    startMcBridge({}); // 重新读取配置
    expect(signedHeaders('')['X-Xiaona-From']).toBe('203.0.113.7');
  });
});

describe('bridgeTargetOf（连接模式 → 地址）', () => {
  it('mode 为空 → 沿用 .env 的 MC_BRIDGE_URL（并去掉结尾斜杠）', () => {
    expect(bridgeTargetOf({}, 'http://1.2.3.4:43733/'))
      .toEqual({ mode: '', base: 'http://1.2.3.4:43733' });
  });

  it('off → 不连接（即使 .env 填了地址）', () => {
    expect(bridgeTargetOf({ mode: 'off' }, 'http://1.2.3.4:43733'))
      .toEqual({ mode: 'off', base: '' });
  });

  it('loopback → 127.0.0.1 + 配置端口', () => {
    expect(bridgeTargetOf({ mode: 'loopback', port: 25565 }, 'http://1.2.3.4:43733'))
      .toEqual({ mode: 'loopback', base: 'http://127.0.0.1:25565' });
  });

  it('lan → 填的局域网主机 + 端口，允许写成带协议的地址', () => {
    expect(bridgeTargetOf({ mode: 'lan', lanHost: '192.168.1.9', port: 43733 }, ''))
      .toEqual({ mode: 'lan', base: 'http://192.168.1.9:43733' });
    expect(bridgeTargetOf({ mode: 'lan', lanHost: 'http://server.lan/', port: 43733 }, ''))
      .toEqual({ mode: 'lan', base: 'http://server.lan:43733' });
  });

  it('lan 没填主机 → 空地址（视为未配置）', () => {
    expect(bridgeTargetOf({ mode: 'lan', port: 43733 }, 'http://1.2.3.4:1').base).toBe('');
  });

  it('public → 原样使用公网地址', () => {
    expect(bridgeTargetOf({ mode: 'public', publicUrl: 'http://example.com:43733/' }, ''))
      .toEqual({ mode: 'public', base: 'http://example.com:43733' });
  });

  it('端口非法时回退 25565', () => {
    expect(bridgeTargetOf({ mode: 'loopback', port: 70000 }, '').base)
      .toBe('http://127.0.0.1:25565');
    expect(bridgeTargetOf({ mode: 'loopback', port: 'abc' }, '').base)
      .toBe('http://127.0.0.1:25565');
  });
});

describe('planAvailableFrom（服务器有没有 Plan）', () => {
  it('新版 mod 明确 available=false → 不可用', () => {
    expect(planAvailableFrom({ plan: { available: false, reason: '未安装 Plan' } })).toBe(false);
  });

  it('available=true → 可用', () => {
    expect(planAvailableFrom({ plan: { available: true } })).toBe(true);
  });

  it('旧版 mod 没有 plan 字段 / status 为空 → 按可用处理（保持升级前行为）', () => {
    expect(planAvailableFrom({ version: '2.6.0' })).toBe(true);
    expect(planAvailableFrom(null)).toBe(true);
    expect(planAvailableFrom(undefined)).toBe(true);
  });

  it('能力位默认返回空（未连桥时不误报）', () => {
    expect(getBridgeCaps()).toEqual({ plan: null, ban: null });
  });
});
