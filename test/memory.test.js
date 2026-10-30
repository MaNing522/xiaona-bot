import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initMemory,
  setMemoryOptions,
  recordMessage,
  addMemory,
  listMemory,
  removeMemory,
  clearMemory,
  memoryContext,
  searchMemory,
  closeMemory,
} from '../src/memory.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-memory-'));
});

afterEach(() => {
  closeMemory();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recordMessage / memoryContext（按人记忆）', () => {
  it('最近对话带发言人署名与来源群标注', () => {
    initMemory(dir, { contextRecent: 10 });
    recordMessage('u:10001', 'user', '你好', { name: '小明', qq: '10001', scene: 'g:123' });
    recordMessage('u:10001', 'ai', '你好呀', { scene: 'g:123' });
    const ctx = memoryContext('u:10001');
    expect(ctx).toContain('【最近对话】');
    expect(ctx).toContain('小明(10001)[群123]: 你好');
    expect(ctx).toContain('小钠[群123]: 你好呀');
  });

  it('同一个人在不同群/私聊说的话归到同一份记忆', () => {
    initMemory(dir, {});
    recordMessage('u:10001', 'user', '在群里说的', { name: '小明', qq: '10001', scene: 'g:111' });
    recordMessage('u:10001', 'user', '私聊说的', { name: '小明', qq: '10001', scene: 'p:10001' });
    recordMessage('u:10001', 'user', '游戏里说的', { name: '小明', qq: '10001', scene: 'mc:Steve' });
    const ctx = memoryContext('u:10001');
    expect(ctx).toContain('[群111]');
    expect(ctx).toContain('[私聊]');
    expect(ctx).toContain('[游戏]');
    expect(ctx).toContain('在群里说的');
    expect(ctx).toContain('私聊说的');
    expect(ctx).toContain('游戏里说的');
  });

  it('不同人之间相互隔离', () => {
    initMemory(dir, {});
    recordMessage('u:10001', 'user', '甲说的话');
    recordMessage('u:10002', 'user', '乙说的话');
    expect(memoryContext('u:10001')).toContain('甲说的话');
    expect(memoryContext('u:10001')).not.toContain('乙说的话');
  });

  it('无任何记录时返回空串', () => {
    initMemory(dir, {});
    expect(memoryContext('u:404')).toBe('');
  });

  it('每人超过上限时丢掉最老的，不再压缩进摘要', () => {
    initMemory(dir, { maxUserMessages: 5 });
    for (let i = 1; i <= 8; i++) recordMessage('u:1', 'user', `第${i}条`);
    const ctx = memoryContext('u:1');
    expect(ctx).not.toContain('第2条');
    expect(ctx).not.toContain('第3条');
    expect(ctx).toContain('第4条');
    expect(ctx).toContain('第8条');
    // 之前那套「溢出压进摘要」的逻辑已随按人记忆一起移除
    expect(ctx).not.toContain('【对话摘要】');
  });

  it('上限会被夹在 5~20（配 2 按 5、配 99 按 20）', () => {
    initMemory(dir, { maxUserMessages: 2 });
    for (let i = 1; i <= 7; i++) recordMessage('u:1', 'user', `少${i}`);
    const ctx = memoryContext('u:1');
    expect(ctx).toContain('少3');
    expect(ctx).not.toContain('少2');

    closeMemory();
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-memory-'));
    initMemory(dir, { maxUserMessages: 99 });
    for (let i = 1; i <= 25; i++) recordMessage('u:2', 'user', `多${i}`);
    expect(memoryContext('u:2', 50)).toContain('多6');
    expect(memoryContext('u:2', 50)).not.toContain('多5');
  });

  it('memoryContext 可显式指定本次注入条数', () => {
    initMemory(dir, {});
    for (let i = 1; i <= 10; i++) recordMessage('u:1', 'user', `消息${i}`);
    const ctx = memoryContext('u:1', 3);
    expect(ctx).toContain('消息10');
    expect(ctx).toContain('消息8');
    expect(ctx).not.toContain('消息7');
  });

  it('配置改小后 setMemoryOptions 立即裁剪已有记录', () => {
    initMemory(dir, { maxUserMessages: 20 });
    for (let i = 1; i <= 12; i++) recordMessage('u:1', 'user', `右${i}`);
    setMemoryOptions({ maxUserMessages: 5 });
    const ctx = memoryContext('u:1');
    expect(ctx).not.toContain('右7');
    expect(ctx).toContain('右8');
  });

  it('超长消息截断到 500 字', () => {
    initMemory(dir, {});
    recordMessage('u:1', 'user', 'x'.repeat(800));
    const ctx = memoryContext('u:1');
    expect(ctx).toContain('x'.repeat(500));
    expect(ctx).not.toContain('x'.repeat(501));
  });
});

describe('长期记忆（#记住 / #记忆 / #忘记 / #清除记忆）', () => {
  it('add / list 保持写入顺序，返回条数', () => {
    initMemory(dir, {});
    expect(addMemory('u:1', '  喜欢猫  ')).toBe(1);
    expect(addMemory('u:1', '在写机器人')).toBe(2);
    const list = listMemory('u:1');
    expect(list.map((m) => m.text)).toEqual(['喜欢猫', '在写机器人']);
    expect(list[0].id).toMatch(/^M/);
  });

  it('超过上限丢弃最老的', () => {
    initMemory(dir, { maxLongterm: 2 });
    addMemory('u:1', 'A');
    addMemory('u:1', 'B');
    expect(addMemory('u:1', 'C')).toBe(2);
    expect(listMemory('u:1').map((m) => m.text)).toEqual(['B', 'C']);
  });

  it('removeMemory 按 1 起序号删除，越界返回 false', () => {
    initMemory(dir, {});
    addMemory('u:1', 'A');
    addMemory('u:1', 'B');
    expect(removeMemory('u:1', 1)).toBe(true);
    expect(listMemory('u:1').map((m) => m.text)).toEqual(['B']);
    expect(removeMemory('u:1', 5)).toBe(false);
    expect(removeMemory('u:1', 0)).toBe(false);
  });

  it('clearMemory 清空这个人的全部记忆', () => {
    initMemory(dir, {});
    addMemory('u:1', 'A');
    recordMessage('u:1', 'user', '聊天');
    recordMessage('u:2', 'user', '别人的聊天');
    expect(clearMemory('u:1')).toBe(true);
    expect(listMemory('u:1')).toEqual([]);
    expect(memoryContext('u:1')).toBe('');
    expect(memoryContext('u:2')).toContain('别人的聊天');
    expect(clearMemory('u:1')).toBe(false); // 已空
  });
});

describe('searchMemory', () => {
  it('命中长期记忆并带分组标题', () => {
    initMemory(dir, {});
    addMemory('u:1', '主人喜欢喝美式咖啡');
    recordMessage('u:1', 'user', '随便聊聊');
    const r = searchMemory('u:1', '咖啡');
    expect(r).toContain('【长期记忆】');
    expect(r).toContain('主人喜欢喝美式咖啡');
  });

  it('命中最近对话，署名与来源正确', () => {
    initMemory(dir, {});
    recordMessage('u:1', 'user', '今天去打羽毛球了', { name: '小红', qq: '10002', scene: 'g:456' });
    const r = searchMemory('u:1', '羽毛球');
    expect(r).toContain('【最近对话】');
    expect(r).toContain('小红(10002)[群456]: 今天去打羽毛球了');
  });

  it('两字中文查询走 LIKE 回退也能命中（trigram 限制）', () => {
    initMemory(dir, {});
    recordMessage('u:1', 'user', '天气不错适合出门');
    expect(searchMemory('u:1', '天气')).toContain('天气不错适合出门');
  });

  it('无命中返回空串', () => {
    initMemory(dir, {});
    recordMessage('u:1', 'user', '你好');
    expect(searchMemory('u:1', '完全不相干的词')).toBe('');
  });

  it('空关键词返回空串', () => {
    initMemory(dir, {});
    addMemory('u:1', 'A');
    expect(searchMemory('u:1', '   ')).toBe('');
    expect(searchMemory('u:1', '')).toBe('');
  });

  it('LIKE 通配符按普通字符处理（不会因为 % 匹配全部）', () => {
    initMemory(dir, {});
    recordMessage('u:1', 'user', '百分之百');
    expect(searchMemory('u:1', '%')).toBe('');
  });

  it('删除记忆后不再被搜到（FTS 索引同步）', () => {
    initMemory(dir, {});
    addMemory('u:1', '临时记住的事情');
    expect(searchMemory('u:1', '临时记住')).toContain('临时记住的事情');
    removeMemory('u:1', 1);
    expect(searchMemory('u:1', '临时记住')).toBe('');
  });
});

describe('旧数据迁移（会话键 → 人）', () => {
  it('带 QQ 号的旧消息迁到 u:QQ号，原会话键记入来源', () => {
    const now = Date.now();
    const legacy = {
      'g:1': {
        recent: [
          { role: 'user', text: '迁移前的一条消息', t: now, name: '老用户', qq: '10001' },
          { role: 'ai', text: '迁移前的回复', t: now },
        ],
        summary: [{ text: '更早的摘要内容', t: now }],
        longterm: [{ id: 'Mabc', text: '迁移前的长期记忆', t: now }],
      },
      // v1 旧格式：会话就是一个长期记忆数组
      'p:2': [{ id: 'Mdef', text: 'v1 格式的记忆', t: now }],
    };
    const jsonFile = path.join(dir, 'memory.json');
    fs.writeFileSync(jsonFile, JSON.stringify(legacy));

    initMemory(dir, {});

    const userCtx = memoryContext('u:10001');
    expect(userCtx).toContain('迁移前的一条消息');
    expect(userCtx).toContain('[群1]');
    // AI 行没有发言人，留在旧会话键下
    expect(memoryContext('g:1')).toContain('迁移前的回复');
    expect(memoryContext('g:1')).not.toContain('迁移前的一条消息');
    expect(listMemory('g:1').map((m) => m.text)).toEqual(['迁移前的长期记忆']);
    expect(searchMemory('g:1', '更早的摘要')).toContain('更早的摘要内容');
    expect(listMemory('p:2').map((m) => m.text)).toEqual(['v1 格式的记忆']);
    expect(fs.existsSync(jsonFile)).toBe(true); // 保留作回滚点
  });

  it('私聊的长期记忆迁到 u:QQ号', () => {
    const now = Date.now();
    fs.writeFileSync(
      path.join(dir, 'memory.json'),
      JSON.stringify({ 'p:12345': [{ id: 'M1', text: '私聊存的记忆', t: now }] }),
    );
    initMemory(dir, {});
    expect(listMemory('u:12345').map((m) => m.text)).toEqual(['私聊存的记忆']);
    expect(listMemory('p:12345')).toEqual([]);
  });

  it('第二次启动不会重复导入（库非空即跳过）', () => {
    const legacy = {
      'g:1': { recent: [], summary: [], longterm: [{ id: 'M1', text: '只有一条', t: Date.now() }] },
    };
    fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(legacy));
    initMemory(dir, {});
    expect(listMemory('g:1')).toHaveLength(1);

    initMemory(dir, {}); // 重开：库已有数据，不应再导入
    expect(listMemory('g:1')).toHaveLength(1);
  });
});

describe('超时清理', () => {
  it('超过 maxAgeDays 的消息被清掉，长期记忆保留', () => {
    const old = Date.now() - 40 * 86400000;
    fs.writeFileSync(
      path.join(dir, 'memory.json'),
      JSON.stringify({
        'p:12345': {
          recent: [
            { role: 'user', text: '很久以前的消息', t: old, name: '老用户', qq: '12345' },
          ],
          summary: [{ text: '很久以前的摘要', t: old }],
          longterm: [{ id: 'M1', text: '古老的长期记忆', t: old }],
        },
      }),
    );
    initMemory(dir, { maxAgeDays: 30 });
    expect(memoryContext('u:12345')).not.toContain('很久以前的消息');
    expect(memoryContext('p:12345')).not.toContain('很久以前的摘要');
    expect(listMemory('u:12345').map((m) => m.text)).toEqual(['古老的长期记忆']);
  });
});
