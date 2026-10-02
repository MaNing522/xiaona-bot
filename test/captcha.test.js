import { describe, it, expect } from 'vitest';
import { renderCaptcha, encodePng } from '../captcha.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('renderCaptcha', () => {
  it('返回 PNG Buffer，magic 正确', () => {
    const buf = renderCaptcha('1234');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it('IHDR 宽高为 176x64', () => {
    const buf = renderCaptcha('0123');
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(buf.readUInt32BE(16)).toBe(176);
    expect(buf.readUInt32BE(20)).toBe(64);
  });

  it('以 IEND 结尾', () => {
    const buf = renderCaptcha('9999');
    expect(buf.subarray(buf.length - 8, buf.length - 4).toString('ascii')).toBe('IEND');
  });
});

describe('encodePng', () => {
  it('相同输入产生完全相同的输出（确定性）', () => {
    const w = 4;
    const h = 3;
    const rgb = Buffer.alloc(w * h * 3, 128);
    const a = encodePng(w, h, rgb);
    const b = encodePng(w, h, rgb);
    expect(a.equals(b)).toBe(true);
    expect(a.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(a.readUInt32BE(16)).toBe(w);
    expect(a.readUInt32BE(20)).toBe(h);
  });
});
