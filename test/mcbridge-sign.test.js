import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { signedHeaders, startMcBridge } from '../mcbridge.js';

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
