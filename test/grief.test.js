// grief.js 的单测：查询结果翻译、格式化展示、AI 总结（依赖用 mock 顶掉）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../mcbridge.js', () => ({ getGriefRecords: vi.fn() }));
vi.mock('../aiService.js', () => ({ chatCompletion: vi.fn() }));

import { getGriefRecords } from '../mcbridge.js';
import { chatCompletion } from '../aiService.js';
import { queryGrief, formatGrief, summarizeGrief } from '../grief.js';

const row = (over = {}) => ({
  time: Date.UTC(2026, 0, 2, 3, 4),
  player: 'Steve',
  level: 'minecraft:overworld',
  x: 1, y: 64, z: 3,
  kind: 'block',
  actionId: 0,
  material: 'minecraft:stone',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('queryGrief', () => {
  it('成功时原样返回 total/rows', async () => {
    getGriefRecords.mockResolvedValue({ ok: true, total: 5, rows: [row()], hours: 24, player: 'Steve', db: '/x/db' });
    const r = await queryGrief({ player: 'Steve', hours: 24, limit: 50 });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(5);
    expect(r.rows).toHaveLength(1);
    expect(getGriefRecords).toHaveBeenCalledWith({ player: 'Steve', hours: 24, limit: 50 });
  });

  it('mod 返回 ok:false 时把 error 透传出来', async () => {
    getGriefRecords.mockResolvedValue({ ok: false, error: '未找到 GriefLogger 数据库：/x' });
    const r = await queryGrief({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未找到');
  });

  it('旧版 mod 404 → 提示升级而不是抛原始错误', async () => {
    getGriefRecords.mockRejectedValue(new Error('HTTP 404 unknown endpoint'));
    const r = await queryGrief({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('升级 mod');
  });
});

describe('formatGrief', () => {
  it('把记录渲染成可读文本（维度/动作/物品都中文化）', () => {
    const out = formatGrief({
      ok: true, total: 2, hours: 24, player: '',
      rows: [
        row({ kind: 'block', actionId: 0, material: 'minecraft:stone' }),
        row({ time: Date.UTC(2026, 0, 2, 3, 5), player: 'Alex', level: 'minecraft:the_nether',
          kind: 'container', actionId: 1, material: 'diamond', amount: 3 }),
      ],
    });
    expect(out).toContain('共 2 条');
    expect(out).toContain('全服');
    expect(out).toContain('破坏方块');
    expect(out).toContain('主世界');
    expect(out).toContain('下界');
    expect(out).toContain('存入');
    expect(out).toContain('diamond x3');
  });

  it('超过展示上限时只列最近若干条', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ time: Date.UTC(2026, 0, 2, 0, i) }));
    const out = formatGrief({ ok: true, total: 10, hours: 24, player: 'Steve', rows }, 3);
    expect(out).toContain('最近 3 条');
    expect(out.split('\n')).toHaveLength(4); // 头 + 3 行
  });

  it('无记录 / 查询失败都有明确文案', () => {
    expect(formatGrief({ ok: true, total: 0, rows: [], hours: 24, player: '' })).toContain('没有查到');
    expect(formatGrief({ ok: false, error: 'boom' })).toContain('boom');
  });
});

describe('summarizeGrief', () => {
  it('调用 chatCompletion 并要求 100 字以内，返回带前缀的总结', async () => {
    chatCompletion.mockResolvedValue('Steve 最近挖了石头。');
    const out = await summarizeGrief([row()], 1, '最近谁在挖矿', '10001');
    expect(out).toBe('📜 Steve 最近挖了石头。');
    const arg = chatCompletion.mock.calls[0][0];
    expect(arg.messages[1].content).toContain('100 字以内');
    expect(arg.messages[1].content).toContain('Steve');
    expect(arg.userId).toBe('10001');
  });

  it('AI 返回空内容时给出兜底话术', async () => {
    chatCompletion.mockResolvedValue('');
    const out = await summarizeGrief([row()], 1, 'x', '1');
    expect(out).toContain('零散');
  });
});