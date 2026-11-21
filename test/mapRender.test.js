import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderMap, encodePng } = require('../src/mcheadless/mapRender.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xn-map-'));

/** 假客户端：y=64 是地表（x<-3 为水），y=70 有一层树叶，下面是石头 */
function fakeBot() {
  return {
    username: 'xiaona',
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    game: { dimension: 'minecraft:overworld' },
    players: { xiaona: { username: 'xiaona', entity: { position: { x: 0.5, y: 64, z: 0.5 } } } },
    blockAt(p) {
      if (p.y > 64) return p.y === 70 ? { name: 'oak_leaves', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
      if (p.y === 64) return p.x < -3 ? { name: 'water', boundingBox: 'empty' } : { name: 'grass_block', boundingBox: 'block' };
      return { name: 'stone', boundingBox: 'block' };
    },
  };
}

afterAll(() => {
  delete process.env.MC_MAP_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('MC 地图渲染', () => {
  it('能编码出合法 PNG', () => {
    const png = encodePng(2, 2, Buffer.alloc(2 * 2 * 4, 255));
    expect(png.slice(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('渲染地图并给出摘要', () => {
    process.env.MC_MAP_DIR = tmp;
    const r = renderMap(fakeBot(), { radius: 16 });
    expect(fs.existsSync(r.file)).toBe(true);
    const png = fs.readFileSync(r.file);
    expect(png.slice(1, 4).toString()).toBe('PNG');
    expect(png.length).toBeGreaterThan(100);
    expect(r.radius).toBe(16);
    expect(r.center).toEqual({ x: 0, z: 0 });
    expect(r.summary).toContain('主世界');
    expect(r.summary).toContain('红点是你自己');
    const stat = fs.statSync(r.file);
    expect(stat.size).toBeGreaterThan(100);
  });

  it('半径会夹在 8~64', () => {
    process.env.MC_MAP_DIR = tmp;
    expect(renderMap(fakeBot(), { radius: 999 }).radius).toBe(64);
    expect(renderMap(fakeBot(), { radius: 1 }).radius).toBe(8);
  });
});
