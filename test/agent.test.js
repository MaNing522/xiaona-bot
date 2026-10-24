// agent.js 的单测：工具按身份过滤（对应身份对应调用）+ 工具调用循环 + 越权拒绝。
import { describe, it, expect } from 'vitest';
import { AGENT_TOOLS, ROLE_RANK, toolsForRole, runAgentLoop, decideSkip } from '../agent.js';

const names = (role) => toolsForRole(role).map((t) => t.function.name);

describe('toolsForRole（对应身份对应调用）', () => {
  it('主人拿到全部工具', () => {
    expect(names('owner')).toHaveLength(AGENT_TOOLS.length);
  });

  it('普通用户拿不到账务类工具 ai_balance', () => {
    expect(names('guest')).not.toContain('ai_balance');
    expect(names('authorized')).not.toContain('ai_balance');
  });

  it('管理员/主人可用 ai_balance', () => {
    expect(names('admin')).toContain('ai_balance');
    expect(names('owner')).toContain('ai_balance');
  });

  it('公开类工具（搜索/MC/玩家/记忆）所有人的都可用', () => {
    for (const role of ['guest', 'authorized', 'admin', 'owner']) {
      expect(names(role)).toEqual(expect.arrayContaining(['web_search', 'mc_status', 'player_query', 'remember', 'recall_memory']));
    }
  });

  it('未知身份按最低档处理', () => {
    expect(names('whatever')).toEqual(names('guest'));
    expect(ROLE_RANK.guest).toBe(0);
  });

  it('唱歌是普通工具，所有身份都能用', () => {
    for (const role of ['guest', 'authorized', 'admin', 'owner']) {
      expect(names(role)).toContain('sing');
    }
  });

  it('sing 工具把歌词/歌名交给 ctx.sing', async () => {
    const tool = AGENT_TOOLS.find((t) => t.function.name === 'sing');
    const calls = [];
    const out = await tool.run(
      { lyrics: '原谅我这一生不羁放纵爱自由', song: '海阔天空' },
      { sing: async (...a) => { calls.push(a); return '唱好了'; } },
    );
    expect(calls[0]).toEqual(['原谅我这一生不羁放纵爱自由', '海阔天空']);
    expect(out).toBe('唱好了');
  });
});

describe('runAgentLoop（工具调用循环）', () => {
  it('模型先调工具、拿到结果后再给出最终回复', async () => {
    let call = 0;
    const calls = [];
    const chat = async ({ messages }) => {
      call += 1;
      if (call === 1) {
        return { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"武汉天气"}' } }] };
      }
      // 第二轮应能看到工具结果
      calls.push(messages[messages.length - 1]);
      return { content: '今天武汉晴，20度。', tool_calls: null };
    };
    const ctx = { search: async (q) => `结果(${q})` };
    const messages = [{ role: 'user', content: '武汉天气？' }];
    const out = await runAgentLoop({ messages, tools: toolsForRole('guest'), chat, ctx });
    expect(out).toBe('今天武汉晴，20度。');
    // 工具结果以 role:'tool' 追加进了消息
    expect(calls[0].role).toBe('tool');
    expect(calls[0].content).toBe('结果(武汉天气)');
  });

  it('没有工具调用时直接返回文本', async () => {
    const chat = async () => ({ content: '在呢～', tool_calls: null });
    const out = await runAgentLoop({ messages: [], tools: toolsForRole('guest'), chat, ctx: {} });
    expect(out).toBe('在呢～');
  });

  it('越权调用被拒绝（工具不在允许列表）', async () => {
    let call = 0;
    const seen = [];
    const chat = async ({ messages }) => {
      call += 1;
      if (call === 1) {
        return { content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'ai_balance', arguments: '{}' } }] };
      }
      seen.push(messages[messages.length - 1].content);
      return { content: '好', tool_calls: null };
    };
    let ran = false;
    const ctx = { balance: async () => { ran = true; return '余额'; } };
    await runAgentLoop({ messages: [], tools: toolsForRole('guest'), chat, ctx });
    expect(ran).toBe(false);                     // handler 没被执行
    expect(seen[0]).toContain('拒绝');           // 模型收到拒绝说明
  });

  it('工具抛错不会中断循环（错误信息回灌给模型）', async () => {
    let call = 0;
    const chat = async ({ messages }) => {
      call += 1;
      if (call === 1) {
        return { content: '', tool_calls: [{ id: 'e', type: 'function', function: { name: 'web_search', arguments: '{}' } }] };
      }
      return { content: messages[messages.length - 1].content, tool_calls: null };
    };
    const ctx = { search: async () => { throw new Error('网络断了'); } };
    const out = await runAgentLoop({ messages: [], tools: toolsForRole('guest'), chat, ctx });
    expect(out).toContain('执行失败');
  });

  it('超过 maxSteps 返回空串（交由上层兜底）', async () => {
    const chat = async () => ({ content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'mc_status', arguments: '{}' } }] });
    const ctx = { mcStatus: async () => 'ok' };
    const out = await runAgentLoop({ messages: [], tools: toolsForRole('guest'), chat, ctx, maxSteps: 3 });
    expect(out).toBe('');
  });
});

describe('decideSkip（是否跳过回复）', () => {
  it('不允许跳过时永不跳过', () => {
    expect(decideSkip('随便说点', false, false)).toBe(false);
  });

  it('允许跳过 + 没写【REPLY:是】→ 跳过', () => {
    expect(decideSkip('嗯嗯', true, false)).toBe(true);
    expect(decideSkip('【REPLY:否】', true, false)).toBe(true);
  });

  it('允许跳过 + 明确写了【REPLY:是】→ 不跳过', () => {
    expect(decideSkip('【REPLY:是】在呢～', true, false)).toBe(false);
  });

  it('标记写成英文方括号 [REPLY:是] 也认（元数据用[]，模型容易跟着写）', () => {
    expect(decideSkip('[REPLY:是] 在呢～', true, false)).toBe(false);
    expect(decideSkip('[REPLY:否]', true, false)).toBe(true);
  });

  it('关键：调过工具即使没写标记也不跳过（查服务器被吞的回归）', () => {
    expect(decideSkip('play.xxx 在线 3 人', true, true)).toBe(false);
  });
});
