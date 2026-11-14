import { describe, it, expect } from 'vitest';
import { extractTextToolCalls } from '../src/aiService.js';

const tools = [
  { type: 'function', function: { name: 'mc_status' } },
  { type: 'function', function: { name: 'web_search' } },
];

describe('extractTextToolCalls（正文里的工具调用还原）', () => {
  it('还原 <tool_calls><tool_call>{json}</tool_call></tool_calls>', () => {
    const r = extractTextToolCalls(
      '稍等\n<tool_calls><tool_call>{"name":"mc_status","arguments":{}}</tool_call></tool_calls>\n好了',
      tools,
    );
    expect(r.tool_calls).toHaveLength(1);
    expect(r.tool_calls[0].function.name).toBe('mc_status');
    expect(r.tool_calls[0].function.arguments).toBe('{}');
    expect(r.content).not.toContain('tool_call');
    expect(r.content).toContain('稍等');
  });

  it('还原单个 <tool_call> 与 OpenAI 形状的 function', () => {
    const r = extractTextToolCalls(
      '<tool_call>{"function":{"name":"web_search","arguments":{"query":"天气"}}}</tool_call>',
      tools,
    );
    expect(r.tool_calls).toHaveLength(1);
    expect(r.tool_calls[0].function.name).toBe('web_search');
    expect(JSON.parse(r.tool_calls[0].function.arguments)).toEqual({ query: '天气' });
    expect(r.content).toBe('');
  });

  it('还原 <function=名字>参数</function>', () => {
    const r = extractTextToolCalls('<function=mc_status>{"address":"a.b"} </function>', tools);
    expect(r.tool_calls[0].function.name).toBe('mc_status');
    expect(JSON.parse(r.tool_calls[0].function.arguments)).toEqual({ address: 'a.b' });
  });

  it('不认识的工具名不误判，正文保持原样', () => {
    const text = '<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>';
    const r = extractTextToolCalls(text, tools);
    expect(r.tool_calls).toBe(null);
    expect(r.content).toBe(text);
  });
});
