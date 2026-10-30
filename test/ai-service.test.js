// aiService.js 的单测：推理模型「思维链吃光额度」时的重试兜底。
// deepseek-flash 会先输出 reasoning_content，max_tokens 不够时正文 content 为空、finish_reason=length，
// 这时必须翻倍额度重试一次，不能把空回复当结果返回。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chatCompletionRaw, reasoningParams, aiSettings } from '../src/aiService.js';
import { config } from '../src/config.js';

const ENV_KEYS = ['AI_API_KEY', 'AI_PROVIDER', 'AI_API_URL', 'AI_MODEL', 'AI_MAX_TOKENS'];
let saved;
let savedAi;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_PROVIDER = 'deepseek';
  delete process.env.AI_API_URL;
  delete process.env.AI_MODEL;
  delete process.env.AI_MAX_TOKENS;
  savedAi = { ...config().ai };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  Object.assign(config().ai, savedAi);
  vi.unstubAllGlobals();
});

/** 造一个假的 fetch 响应 */
function reply(content, finishReason = 'stop', toolCalls = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content, tool_calls: toolCalls, reasoning_content: '想想想' }, finish_reason: finishReason }],
    }),
  };
}

describe('chatCompletionRaw（推理模型额度兜底）', () => {
  it('正常返回时只请求一次', async () => {
    const fetchMock = vi.fn(async () => reply('好的'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    expect(r.content).toBe('好的');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('正文为空且 finish_reason=length → 翻倍额度重试并返回第二次结果', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply('', 'length'))
      .mockResolvedValueOnce(reply('这张图里是一只猫'));
    vi.stubGlobal('fetch', fetchMock);

    const r = await chatCompletionRaw({ messages: [{ role: 'user', content: '看图' }], maxTokens: 800 });
    expect(r.content).toBe('这张图里是一只猫');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.max_tokens).toBe(800);
    expect(secondBody.max_tokens).toBe(1600);
  });

  it('有 tool_calls 时正文为空属正常，不重试', async () => {
    const fetchMock = vi.fn(async () => reply('', 'tool_calls', [
      { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const r = await chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    expect(r.tool_calls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('重试后仍被思维链吃光 → 明确报错，不返回空串', async () => {
    const fetchMock = vi.fn(async () => reply('', 'length'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 }),
    ).rejects.toThrow(/只输出了思考过程/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('思考开关 / 强度（config.json 的 ai 段）', () => {
  it('reasoningParams 按配置生成请求参数', () => {
    expect(reasoningParams({ thinking: false, reasoningEffort: 'high' })).toEqual({ reasoning_effort: 'none' });
    expect(reasoningParams({ thinking: true, reasoningEffort: 'low' })).toEqual({ reasoning_effort: 'low' });
    expect(reasoningParams({ thinking: true, reasoningEffort: 'max' })).toEqual({ reasoning_effort: 'max' });
    // auto / 非法值：不传参数，跟随模型默认（保持旧行为）
    expect(reasoningParams({ thinking: true, reasoningEffort: 'auto' })).toEqual({});
    expect(reasoningParams({ thinking: true, reasoningEffort: '乱写' })).toEqual({});
    expect(reasoningParams({})).toEqual({});
  });

  it('aiSettings 把上下文条数夹到 5~50、温度夹到 0~2', () => {
    expect(aiSettings().contextMessages).toBeGreaterThanOrEqual(5);
    expect(aiSettings().contextMessages).toBeLessThanOrEqual(50);
    config().ai.contextMessages = 999;
    config().ai.temperature = 9;
    const s = aiSettings();
    expect(s.contextMessages).toBe(50);
    expect(s.temperature).toBe(2);
    config().ai.contextMessages = 1;
    config().ai.temperature = -1;
    const t = aiSettings();
    expect(t.contextMessages).toBe(5);
    expect(t.temperature).toBe(0);
  });

  it('关闭思考时请求 body 带 reasoning_effort=none', async () => {
    config().ai.thinking = false;
    const fetchMock = vi.fn(async () => reply('好的'));
    vi.stubGlobal('fetch', fetchMock);
    await chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe('none');
  });

  it('思考强度 high 时请求 body 带 reasoning_effort=high；auto 不带', async () => {
    config().ai.thinking = true;
    config().ai.reasoningEffort = 'high';
    const fetchMock = vi.fn(async () => reply('好的'));
    vi.stubGlobal('fetch', fetchMock);
    await chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning_effort).toBe('high');

    config().ai.reasoningEffort = 'auto';
    await chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).reasoning_effort).toBeUndefined();
  });

  it('temperature 默认取 config.json 的 ai.temperature', async () => {
    config().ai.temperature = 0.3;
    const fetchMock = vi.fn(async () => reply('好的'));
    vi.stubGlobal('fetch', fetchMock);
    await chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).temperature).toBe(0.3);
  });
});

describe('chatCompletionRaw（网络抖动重试）', () => {
  /** 造一个 undici 风格的网络错误：TypeError: fetch failed，真正原因在 cause 里 */
  function netErr(code) {
    const e = new TypeError('fetch failed');
    e.cause = { code, message: 'getaddrinfo ' + code };
    return e;
  }

  it('DNS 临时失败（EAI_AGAIN）会自动重试并成功', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(netErr('EAI_AGAIN'))
      .mockRejectedValueOnce(netErr('EAI_AGAIN'))
      .mockResolvedValueOnce(reply('搜到了'));
    vi.stubGlobal('fetch', fetchMock);

    const r = await chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    expect(r.content).toBe('搜到了');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('重试 3 次仍失败才报「连不上 AI 服务」', async () => {
    const fetchMock = vi.fn(async () => { throw netErr('ECONNRESET'); });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 }),
    ).rejects.toThrow(/连不上 AI 服务/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('非网络类异常不重试', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('boom'); });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 }),
    ).rejects.toThrow(/连不上 AI 服务/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('超时不重试（避免用户等成倍时间）', async () => {
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    const fetchMock = vi.fn(async () => { throw timeoutErr; });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chatCompletionRaw({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 }),
    ).rejects.toThrow(/AI 超时/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
