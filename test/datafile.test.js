import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeJsonAtomic, readJsonSafe } from '../datafile.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-datafile-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('写入后可原样读回', () => {
    const file = path.join(dir, 'a.json');
    expect(writeJsonAtomic(file, { x: 1, s: '你好' })).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ x: 1, s: '你好' });
  });

  it('不残留 .tmp 文件', () => {
    const file = path.join(dir, 'b.json');
    writeJsonAtomic(file, [1, 2, 3]);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['b.json']);
  });

  it('目录不存在时自动创建', () => {
    const file = path.join(dir, 'nested', 'deep', 'c.json');
    expect(writeJsonAtomic(file, { ok: true })).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('写入失败返回 false 且不抛异常', () => {
    // 把一个「普通文件」当目录用：dirname 存在但不是目录 → 写入必定失败
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    const file = path.join(blocker, 'x.json');
    expect(() => writeJsonAtomic(file, { a: 1 })).not.toThrow();
    expect(writeJsonAtomic(file, { a: 1 })).toBe(false);
  });

  it('连续写入后读回的是最后一次的值', async () => {
    const file = path.join(dir, 'seq.json');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => writeJsonAtomic(file, { i }))),
    );
    expect(readJsonSafe(file, null)).toEqual({ i: 19 });
  });
});

describe('readJsonSafe', () => {
  it('文件不存在返回 fallback', () => {
    expect(readJsonSafe(path.join(dir, 'none.json'), { d: true })).toEqual({ d: true });
  });

  it('坏 JSON 返回 fallback 且不抛异常', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ 这不是合法 JSON');
    expect(() => readJsonSafe(file, 'FB')).not.toThrow();
    expect(readJsonSafe(file, 'FB')).toBe('FB');
  });

  it('正常 JSON 返回解析结果', () => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, JSON.stringify({ n: 42 }));
    expect(readJsonSafe(file, null)).toEqual({ n: 42 });
  });
});
