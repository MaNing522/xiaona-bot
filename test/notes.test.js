import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initNotes, safeNoteName, writeNote, readNote, listNotes } from '../src/notes.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xn-notes-'));
  initNotes(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('本地文本笔记', () => {
  it('写入后能读回来，未写扩展名自动补 .txt', () => {
    expect(writeNote('购物清单', '牛奶、鸡蛋')).toContain('已写入');
    expect(fs.existsSync(path.join(dir, 'notes', '购物清单.txt'))).toBe(true);
    const text = readNote('购物清单');
    expect(text).toContain('牛奶、鸡蛋');
  });

  it('append=true 追加而不是覆盖', () => {
    writeNote('日志', '第一行');
    writeNote('日志', '第二行', true);
    const text = readNote('日志');
    expect(text).toContain('第一行');
    expect(text).toContain('第二行');
  });

  it('不填文件名时列出全部笔记', () => {
    writeNote('a', '1');
    writeNote('b', '2');
    const list = readNote('');
    expect(list).toContain('a.txt');
    expect(list).toContain('b.txt');
    expect(listNotes()).toContain('a.txt');
  });

  it('文件名中的路径分隔符被净化，不会跳出 notes 目录', () => {
    const safe = safeNoteName('../../evil');
    expect(safe).not.toContain('/');
    expect(safe).not.toContain('\\');
    expect(safe).not.toBe('..');
    writeNote('../../evil', 'x');
    const notesDir = path.join(dir, 'notes');
    const files = fs.readdirSync(notesDir);
    expect(files).toHaveLength(1);
    expect(path.dirname(path.join(notesDir, files[0]))).toBe(notesDir);
  });

  it('超过 200KB 的写入被拒绝', () => {
    const huge = 'x'.repeat(201 * 1024);
    expect(writeNote('big', huge)).toContain('超过 200KB');
    expect(readNote('big')).toContain('没有找到');
  });
});
