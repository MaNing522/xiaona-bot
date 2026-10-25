// config.js 的单测：注释剥离、默认值兜底、覆盖与非法值回退、热加载。
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripComments, loadConfig, DEFAULTS, config, reloadConfig, watchConfig } from '../src/config.js';

const tmpFiles = [];
function writeTmp(content) {
  const p = path.join(os.tmpdir(), `xiaona-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, content, 'utf8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* 忽略 */ }
  }
});

describe('stripComments', () => {
  it('去掉行注释与块注释', () => {
    const out = stripComments('{\n  "a": 1, // 行注释\n  /* 块\n  注释 */\n  "b": 2\n}');
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });

  it('字符串里的 // 不动', () => {
    const out = stripComments('{ "url": "http://example.com/a" }');
    expect(JSON.parse(out).url).toBe('http://example.com/a');
  });
});

describe('loadConfig', () => {
  it('文件不存在 → 返回默认值副本', () => {
    const c = loadConfig(path.join(os.tmpdir(), 'definitely-not-here-xiaona.json'));
    expect(c.rateLimit.userPerMinute).toBe(DEFAULTS.rateLimit.userPerMinute);
    expect(c.cooldown.pokeMs).toBe(DEFAULTS.cooldown.pokeMs);
  });

  it('覆盖指定字段，未覆盖的用默认值', () => {
    const p = writeTmp('{ "rateLimit": { "userPerMinute": 42 }, "cooldown": { "pokeMs": 100 } }');
    const c = loadConfig(p);
    expect(c.rateLimit.userPerMinute).toBe(42);
    expect(c.cooldown.pokeMs).toBe(100);
    expect(c.rateLimit.userPerHour).toBe(DEFAULTS.rateLimit.userPerHour);
  });

  it('非法数值（负数 / 非数字）回退默认，多余键忽略', () => {
    const p = writeTmp('{ "rateLimit": { "userPerMinute": -5, "userPerDay": "abc", "unknownKey": 1 } }');
    const c = loadConfig(p);
    expect(c.rateLimit.userPerMinute).toBe(DEFAULTS.rateLimit.userPerMinute);
    expect(c.rateLimit.userPerDay).toBe(DEFAULTS.rateLimit.userPerDay);
    expect(c.rateLimit.unknownKey).toBeUndefined();
  });

  it('解析失败 → 回退全部默认值', () => {
    const p = writeTmp('{ 这不是合法 JSON }');
    const c = loadConfig(p);
    expect(c.rateLimit.userPerMinute).toBe(DEFAULTS.rateLimit.userPerMinute);
  });
});

describe('reloadConfig（热加载）', () => {
  it('原地更新配置对象，能读到新值', () => {
    const p = writeTmp('{ "rateLimit": { "userPerMinute": 42 }, "cooldown": { "pokeMs": 100 } }');
    const ref = config();
    const got = reloadConfig(p);
    expect(got).toBe(ref);                                        // 引用不变（已是热加载的前提）
    expect(config().rateLimit.userPerMinute).toBe(42);
    expect(config().cooldown.pokeMs).toBe(100);
    expect(config().rateLimit.userPerHour).toBe(DEFAULTS.rateLimit.userPerHour);
  });

  it('文件写坏时保留上一次的配置（不被默认值冲掉）', () => {
    reloadConfig(writeTmp('{ "rateLimit": { "userPerMinute": 7 } }'));
    expect(config().rateLimit.userPerMinute).toBe(7);
    reloadConfig(writeTmp('{ 这不是 JSON }'));
    expect(config().rateLimit.userPerMinute).toBe(7);
  });

  it('文件不存在时保留当前配置', () => {
    reloadConfig(writeTmp('{ "rateLimit": { "userPerMinute": 5 } }'));
    reloadConfig(path.join(os.tmpdir(), 'definitely-not-here-xiaona-xyz.json'));
    expect(config().rateLimit.userPerMinute).toBe(5);
  });
});

describe('watchConfig（文件变化触发回调）', () => {
  it('修改文件后回调被触发', async () => {
    const p = writeTmp('{ "cooldown": { "pokeMs": 1 } }');
    let hits = 0;
    const stop = watchConfig(() => { hits += 1; }, 50, p);
    try {
      await new Promise((r) => setTimeout(r, 150));               // 让 watchFile 建立基线
      fs.writeFileSync(p, '{ "cooldown": { "pokeMs": 2000 } }', 'utf8');
      for (let i = 0; i < 40 && hits === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(hits).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});