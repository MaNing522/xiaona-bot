import { describe, it, expect } from 'vitest';
import { parseForwardInput, buildForwardNodes, rawArgAfter, MAX_FORWARD_NODES } from '../forward.js';

describe('rawArgAfter（命令参数保留换行）', () => {
  it('多行参数原样保留换行 —— handleCommand 的 split(/\\s+/) 会把它压平', () => {
    const text = '#聊天记录\n12345678 你好\n87654321 在吗';
    expect(rawArgAfter(text, '#聊天记录')).toBe('12345678 你好\n87654321 在吗');
    // 对照：命令系统原本取参数的方式确实把换行弄丢了
    const [, ...rest] = text.split(/\s+/);
    expect(rest.join(' ')).toBe('12345678 你好 87654321 在吗');
  });

  it('命令行后面紧跟的空格/制表符被去掉，行内空格保留', () => {
    expect(rawArgAfter('#聊天记录  1234 你好 呀', '#聊天记录')).toBe('1234 你好 呀');
    expect(rawArgAfter('#聊天记录\t1234 你好', '#聊天记录')).toBe('1234 你好');
  });

  it('只有命令、没参数 → 空串', () => {
    expect(rawArgAfter('#聊天记录', '#聊天记录')).toBe('');
    expect(rawArgAfter('#聊天记录   ', '#聊天记录')).toBe('');
    expect(rawArgAfter('#聊天记录\n\n', '#聊天记录')).toBe('');
  });

  it('/ 前缀同样适用', () => {
    expect(rawArgAfter('/聊天记录\n1234 hi', '/聊天记录')).toBe('1234 hi');
  });
});

describe('parseForwardInput', () => {
  it('QQ号 + 文案，多行各自成条', () => {
    const { entries, errors } = parseForwardInput('12345678 你好呀\n87654321 在吗', () => '');
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { uin: '12345678', text: '你好呀' },
      { uin: '87654321', text: '在吗' },
    ]);
  });

  it('@昵称 走 resolveAt 换成号码', () => {
    const map = { 张三: '11111111' };
    const { entries, errors } = parseForwardInput('@张三 在吗', (t) => map[t] || '');
    expect(errors).toEqual([]);
    expect(entries).toEqual([{ uin: '11111111', text: '在吗' }]);
  });

  it('@跟数字时直接当号码，不必查名单', () => {
    const { entries } = parseForwardInput('@12345678 你好', () => {
      throw new Error('不该被调用');
    });
    expect(entries).toEqual([{ uin: '12345678', text: '你好' }]);
  });

  it('全角冒号 / 逗号 也能当分隔符', () => {
    const { entries } = parseForwardInput('12345678：你好\n87654321，在吗', () => '');
    expect(entries).toEqual([
      { uin: '12345678', text: '你好' },
      { uin: '87654321', text: '在吗' },
    ]);
  });

  it('空行只是排版，跳过且不算错误', () => {
    const { entries, errors } = parseForwardInput('\n12345678 你好\n\n\n87654321 再见\n', () => '');
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
  });

  it('开头不是号码或@ → 报错并跳过该行，其余照常', () => {
    const { entries, errors } = parseForwardInput('你好呀\n12345678 我在', () => '');
    expect(entries).toEqual([{ uin: '12345678', text: '我在' }]);
    expect(errors[0]).toContain('第 1 行');
  });

  it('只有人没有内容 → 报错', () => {
    const { entries, errors } = parseForwardInput('12345678', () => '');
    expect(entries).toEqual([]);
    expect(errors[0]).toContain('没写内容');
    // 冒号后面空着，同样算"没写内容"
    const r2 = parseForwardInput('12345678 :', () => '');
    expect(r2.entries).toEqual([]);
    expect(r2.errors[0]).toContain('没写内容');
  });

  it('@认不出的人 → 报错并提示可直接写 QQ 号', () => {
    const { entries, errors } = parseForwardInput('@李四 在吗', () => '');
    expect(entries).toEqual([]);
    expect(errors[0]).toContain('认不出');
  });

  it('号码位数不合法（太短）不被当成号码', () => {
    const { entries, errors } = parseForwardInput('123 你好', () => '');
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('超过上限时截断并提示', () => {
    const lines = Array.from({ length: MAX_FORWARD_NODES + 5 }, (_, i) => `${10000000 + i} 第${i}条`).join(
      '\n',
    );
    const { entries, errors } = parseForwardInput(lines, () => '');
    expect(entries).toHaveLength(MAX_FORWARD_NODES);
    expect(errors[0]).toContain('最多');
  });

  it('超长文案被截断', () => {
    const { entries } = parseForwardInput(`12345678 ${'x'.repeat(800)}`, () => '');
    expect(entries[0].text).toHaveLength(500);
  });

  it('空输入 / undefined → 空结果且不抛', () => {
    expect(parseForwardInput('', () => '').entries).toEqual([]);
    expect(parseForwardInput(undefined, () => '').entries).toEqual([]);
    expect(parseForwardInput('#聊天记录', () => '').entries).toEqual([]);
  });
});

describe('buildForwardNodes', () => {
  it('产出 OneBot 11 的 node 结构', () => {
    const nodes = buildForwardNodes([{ uin: '12345678', name: '张三', text: '你好' }]);
    expect(nodes).toEqual([
      {
        type: 'node',
        data: {
          uin: '12345678',
          name: '张三',
          content: [{ type: 'text', data: { text: '你好' } }],
        },
      },
    ]);
  });

  it('没有昵称时用号码兜底，不留空名', () => {
    const nodes = buildForwardNodes([{ uin: '12345678', text: '你好' }]);
    expect(nodes[0].data.name).toBe('12345678');
  });

  it('uin 统一为字符串（OneBot 要求字符串）', () => {
    const nodes = buildForwardNodes([{ uin: 12345678, name: 'X', text: 'hi' }]);
    expect(nodes[0].data.uin).toBe('12345678');
  });

  it('空数组 / 非法输入 → 空数组', () => {
    expect(buildForwardNodes([])).toEqual([]);
    expect(buildForwardNodes(null)).toEqual([]);
  });
});
