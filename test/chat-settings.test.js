// chatSettings：进出群提醒的会话级覆盖（开关 + 文案），留空回退全局。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initChatSettings, set, getEffective } from '../chatSettings.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  initChatSettings(dir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('进出群提醒（会话级覆盖）', () => {
  it('没覆盖时用全局默认（开启、文案带占位符）', () => {
    const e = getEffective('g:123456789');
    expect(e.notice.enabled).toBe(true);
    expect(e.notice.joinText).toContain('欢迎');
    expect(e.notice.leaveText).toContain('{name}');
  });

  it('可单独关开关 / 改文案；再置空则回退全局', () => {
    set('g:123456789', { notice: { enabled: false, joinText: '来了来了！' } });
    let e = getEffective('g:123456789');
    expect(e.notice.enabled).toBe(false);
    expect(e.notice.joinText).toBe('来了来了！');
    expect(e.notice.leaveText).toContain('{name}');   // 未覆盖 → 仍用全局

    set('g:123456789', { notice: { enabled: null, joinText: '' } });
    e = getEffective('g:123456789');
    expect(e.notice.enabled).toBe(true);
    expect(e.notice.joinText).toContain('欢迎');
  });
});
