// search.js 的单测：后端切换解析、未配置即关闭、结果归一化（网络全部用 stub，不发真实请求）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reloadConfig } from '../src/config.js';
import { searchSettings, isSearchEnabled, webSearch } from '../src/search.js';

const tmpFiles = [];
function writeCfg(search) {
  const p = path.join(os.tmpdir(), `xiaona-search-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ search }), 'utf8');
  tmpFiles.push(p);
  reloadConfig(p);
  return p;
}

beforeEach(() => {
  vi.stubEnv('BAIDU_SEARCH_KEY', '');
  vi.stubEnv('AI_API_KEY', '');
  vi.stubEnv('SEARCH_CUSTOM_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const p of tmpFiles.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* 忽略 */ }
  }
});

describe('searchSettings', () => {
  it('未知 provider 回退 baidu', () => {
    writeCfg({ provider: 'whatever' });
    expect(searchSettings().provider).toBe('baidu');
  });

  it('limit 非法 / 过大时收敛到 1~50', () => {
    writeCfg({ provider: 'baidu', limit: 999 });
    expect(searchSettings().limit).toBe(50);
    writeCfg({ provider: 'baidu', limit: -3 });
    expect(searchSettings().limit).toBe(5);
  });
});

describe('isSearchEnabled（缺配置即关闭）', () => {
  it('provider=off 时关闭（即使有密钥）', () => {
    vi.stubEnv('BAIDU_SEARCH_KEY', 'k');
    writeCfg({ provider: 'off' });
    expect(isSearchEnabled()).toBe(false);
  });

  it('baidu 缺 BAIDU_SEARCH_KEY 时关闭', () => {
    writeCfg({ provider: 'baidu' });
    expect(isSearchEnabled()).toBe(false);
  });

  it('deepseek 复用 AI_API_KEY', () => {
    writeCfg({ provider: 'deepseek' });
    expect(isSearchEnabled()).toBe(false);
    vi.stubEnv('AI_API_KEY', 'sk-test');
    expect(isSearchEnabled()).toBe(true);
  });

  it('custom 没填地址时关闭', () => {
    vi.stubEnv('SEARCH_CUSTOM_KEY', 'k');
    writeCfg({ provider: 'custom', customUrl: '' });
    expect(isSearchEnabled()).toBe(false);
    writeCfg({ provider: 'custom', customUrl: 'https://x.test/search' });
    expect(isSearchEnabled()).toBe(true);
  });
});

describe('webSearch（后端调用与结果归一化）', () => {
  it('deepseek 后端：调用官方 Search API 并归一化结果', async () => {
    vi.stubEnv('AI_API_KEY', 'sk-test');
    writeCfg({ provider: 'deepseek', limit: 3 });
    const calls = [];
    vi.stubGlobal('fetch', async (url, opt) => {
      calls.push({ url, body: JSON.parse(opt.body), auth: opt.headers.Authorization });
      return {
        ok: true,
        json: async () => ({
          results: [
            { title: '标题A', url: 'https://a.test', summary: '摘要A', snippet: '片段A' },
            { title: '', url: '', summary: '', snippet: '' },   // 空条目应被丢掉
            { title: '标题B', url: 'https://b.test', snippet: '片段B' },
          ],
        }),
      };
    });
    const out = await webSearch('测试查询', 2);
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(calls[0].auth).toBe('Bearer sk-test');
    expect(calls[0].body).toEqual({ query: '测试查询', count: 2 });
    expect(out).toEqual([
      { title: '标题A', url: 'https://a.test', snippet: '摘要A' },
      { title: '标题B', url: 'https://b.test', snippet: '片段B' },
    ]);
  });

  it('baidu 后端：走千帆 ai_search，并且不传 model（避免智能总结模式）', async () => {
    vi.stubEnv('BAIDU_SEARCH_KEY', 'bce-key');
    writeCfg({ provider: 'baidu', limit: 5 });
    let captured = null;
    vi.stubGlobal('fetch', async (url, opt) => {
      captured = { url, body: JSON.parse(opt.body), auth: opt.headers.Authorization };
      return {
        ok: true,
        json: async () => ({ references: [{ title: 'R', url: 'https://r.test', content: '内容' }] }),
      };
    });
    const out = await webSearch('天气', 5);
    expect(captured.url).toBe('https://qianfan.baidubce.com/v2/ai_search/chat/completions');
    expect(captured.auth).toBe('Bearer bce-key');
    expect(captured.body.search_source).toBe('baidu_search_v2');
    expect(captured.body.model).toBeUndefined();
    expect(out).toEqual([{ title: 'R', url: 'https://r.test', snippet: '内容' }]);
  });

  it('custom 后端：兼容 choices[0] 直接返回总结文本', async () => {
    writeCfg({ provider: 'custom', customUrl: 'https://my.test/search', limit: 5 });
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '直接给出的总结' } }] }),
    }));
    const out = await webSearch('q');
    expect(out).toEqual([{ title: '', url: '', snippet: '直接给出的总结' }]);
  });

  it('后端关闭时不发请求，直接返回空', async () => {
    writeCfg({ provider: 'off' });
    let hit = 0;
    vi.stubGlobal('fetch', async () => { hit += 1; return { ok: true, json: async () => ({}) }; });
    expect(await webSearch('q')).toEqual([]);
    expect(hit).toBe(0);
  });

  it('HTTP 失败时不抛错，返回空并让调用方兜底', async () => {
    vi.stubEnv('AI_API_KEY', 'sk-test');
    writeCfg({ provider: 'deepseek' });
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 429,
      json: async () => ({ error: { message: 'rate limited' } }),
    }));
    expect(await webSearch('q')).toEqual([]);
  });
});