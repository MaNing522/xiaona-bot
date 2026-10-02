import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initMemory,
  recordMessage,
  addMemory,
  listMemory,
  removeMemory,
  clearMemory,
  memoryContext,
  searchMemory,
  closeMemory,
} from '../memory.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-memory-'));
});

afterEach(() => {
  closeMemory();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recordMessage / memoryContext', () => {
  it('记录的最近对话按顺序出现在上下文里，并带发言人署名', () => {
    initMemory(dir, { contextRecent: 10 });
    recordMessage('g:1', 'user', '你好', { name: '小明', qq: '10001' });
    recordMessage('g:1', 'ai', '你好呀');
    const ctx = memoryContext('g:1');
    expect(ctx).toContain('【最近对话】');
    expect(ctx).toContain('小明(10001): 你好');
    expect(ctx).toContain('小钠: 你好呀');
  });

  it('会话之间相互隔离', () => {
    initMemory(dir, {});
    recordMessage('g:1', 'user', '群1的消息');
    recordMessage('p:2', 'user', '私聊的消息');
    expect(memoryContext('g:1')).toContain('群1的消息');
    expect(memoryContext('g:1')).not.toContain('私聊的消息');
  });

  it('无任何记录时返回空串', () => {
    initMemory(dir, {});
    expect(memoryContext('g:404')).toBe('');
  });

  it('上下文只取最近 contextRecent 条', () => {
    initMemory(dir, { contextRecent: 3 });
    for (let i = 1; i <= 6; i++) recordMessage('g:1', 'user', `第${i}条`);
    const ctx = memoryContext('g:1');
    expect(ctx).not.toContain('第3条');
    expect(ctx).toContain('第4条');
    expect(ctx).toContain('第6条');
  });

  it('超长消息截断到 500 字', () => {
    initMemory(dir, {});
    recordMessage('g:1', 'user', 'x'.repeat(800));
    const ctx = memoryContext('g:1');
    expect(ctx).toContain('x'.repeat(500));
    expect(ctx).not.toContain('x'.repeat(501));
  });

  it('窗口溢出时压缩进摘要', () => {
    initMemory(dir, { maxRecent: 4, summaryKeep: 2 });
    for (let i = 1; i <= 7; i++) recordMessage('g:1', 'user', `消息${i}`);
    const [sumPart, recPart] = memoryContext('g:1').split('【最近对话】');
    // 溢出的老消息进了摘要（上下文里只注入最近 3 条摘要，最新一条必然可见）
    expect(sumPart).toContain('【对话摘要】');
    expect(sumPart).toContain('消息4');
    // 最近窗口只剩最后 3 条
    expect(recPart).not.toContain('消息4');
    expect(recPart).toContain('消息5');
    expect(recPart).toContain('消息7');
    // 更早的摘要仍完整保存在库里（可被搜索到）
    expect(searchMemory('g:1', '消息1')).toContain('消息1');
  });
});

describe('长期记忆（#记住 / #记忆 / #忘记 / #清除记忆）', () => {
  it('add / list 保持写入顺序，返回条数', () => {
    initMemory(dir, {});
    expect(addMemory('g:1', '  喜欢猫  ')).toBe(1);
    expect(addMemory('g:1', '在写机器人')).toBe(2);
    const list = listMemory('g:1');
    expect(list.map((m) => m.text)).toEqual(['喜欢猫', '在写机器人']);
    expect(list[0].id).toMatch(/^M/);
  });

  it('超过上限丢弃最老的', () => {
    initMemory(dir, { maxLongterm: 2 });
    addMemory('g:1', 'A');
    addMemory('g:1', 'B');
    expect(addMemory('g:1', 'C')).toBe(2);
    expect(listMemory('g:1').map((m) => m.text)).toEqual(['B', 'C']);
  });

  it('removeMemory 按 1 起序号删除，越界返回 false', () => {
    initMemory(dir, {});
    addMemory('g:1', 'A');
    addMemory('g:1', 'B');
    expect(removeMemory('g:1', 1)).toBe(true);
    expect(listMemory('g:1').map((m) => m.text)).toEqual(['B']);
    expect(removeMemory('g:1', 5)).toBe(false);
    expect(removeMemory('g:1', 0)).toBe(false);
  });

  it('clearMemory 清空会话全部记忆', () => {
    initMemory(dir, {});
    addMemory('g:1', 'A');
    recordMessage('g:1', 'user', '聊天');
    expect(clearMemory('g:1')).toBe(true);
    expect(listMemory('g:1')).toEqual([]);
    expect(memoryContext('g:1')).toBe('');
    expect(clearMemory('g:1')).toBe(false); // 已空
  });
});

describe('searchMemory', () => {
  it('命中长期记忆并带分组标题', () => {
    initMemory(dir, {});
    addMemory('g:1', '主人喜欢喝美式咖啡');
    recordMessage('g:1', 'user', '随便聊聊');
    const r = searchMemory('g:1', '咖啡');
    expect(r).toContain('【长期记忆】');
    expect(r).toContain('主人喜欢喝美式咖啡');
  });

  it('命中最近对话，署名正确', () => {
    initMemory(dir, {});
    recordMessage('g:1', 'user', '今天去打羽毛球了', { name: '小红', qq: '10002' });
    const r = searchMemory('g:1', '羽毛球');
    expect(r).toContain('【最近对话】');
    expect(r).toContain('小红(10002): 今天去打羽毛球了');
  });

  it('两字中文查询走 LIKE 回退也能命中（trigram 限制）', () => {
    initMemory(dir, {});
    recordMessage('g:1', 'user', '天气不错适合出门');
    expect(searchMemory('g:1', '天气')).toContain('天气不错适合出门');
  });

  it('无命中返回空串', () => {
    initMemory(dir, {});
    recordMessage('g:1', 'user', '你好');
    expect(searchMemory('g:1', '完全不相干的词')).toBe('');
  });

  it('空关键词返回空串', () => {
    initMemory(dir, {});
    addMemory('g:1', 'A');
    expect(searchMemory('g:1', '   ')).toBe('');
    expect(searchMemory('g:1', '')).toBe('');
  });

  it('LIKE 通配符按普通字符处理（不会因为 % 匹配全部）', () => {
    initMemory(dir, {});
    recordMessage('g:1', 'user', '百分之百');
    expect(searchMemory('g:1', '%')).toBe('');
  });

  it('删除记忆后不再被搜到（FTS 索引同步）', () => {
    initMemory(dir, {});
    addMemory('g:1', '临时记住的事情');
    expect(searchMemory('g:1', '临时记住')).toContain('临时记住的事情');
    removeMemory('g:1', 1);
    expect(searchMemory('g:1', '临时记住')).toBe('');
  });
});

describe('从旧 memory.json 一次性迁移', () => {
  it('导入旧数据（含 v1 数组格式），原 JSON 保留', () => {
    const legacy = {
      'g:1': {
        recent: [
          { role: 'user', text: '迁移前的一条消息', t: Date.now(), name: '老用户', qq: '10001' },
          { role: 'ai', text: '迁移前的回复', t: Date.now() },
        ],
        summary: [{ text: '更早的摘要内容', t: Date.now() }],
        longterm: [{ id: 'Mabc', text: '迁移前的长期记忆', t: Date.now() }],
      },
      // v1 旧格式：会话就是一个长期记忆数组
      'p:2': [{ id: 'Mdef', text: 'v1 格式的记忆', t: Date.now() }],
    };
    const jsonFile = path.join(dir, 'memory.json');
    fs.writeFileSync(jsonFile, JSON.stringify(legacy));

    initMemory(dir, {});

    expect(memoryContext('g:1')).toContain('迁移前的一条消息');
    expect(listMemory('g:1').map((m) => m.text)).toEqual(['迁移前的长期记忆']);
    expect(searchMemory('g:1', '更早的摘要')).toContain('更早的摘要内容');
    expect(listMemory('p:2').map((m) => m.text)).toEqual(['v1 格式的记忆']);
    expect(fs.existsSync(jsonFile)).toBe(true); // 保留作回滚点
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
  it('超过 maxAgeDays 的最近消息被清掉，长期记忆保留', () => {
    const old = Date.now() - 40 * 86400000;
    fs.writeFileSync(
      path.join(dir, 'memory.json'),
      JSON.stringify({
        'g:1': {
          recent: [{ role: 'user', text: '很久以前的消息', t: old }],
          summary: [{ text: '很久以前的摘要', t: old }],
          longterm: [{ id: 'M1', text: '古老的长期记忆', t: old }],
        },
      }),
    );
    initMemory(dir, { maxAgeDays: 30 });
    expect(memoryContext('g:1')).not.toContain('很久以前的消息');
    expect(memoryContext('g:1')).not.toContain('很久以前的摘要');
    expect(listMemory('g:1').map((m) => m.text)).toEqual(['古老的长期记忆']);
  });
});
