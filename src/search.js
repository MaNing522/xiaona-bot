// ============================================================
// search.js - 联网搜索（后端可切换，网页「全局设置」里改 config.json 的 search 段）
//
//   provider = off     关闭搜索（web_search 工具整个不出现）
//            = baidu   百度智能搜索（千帆 ai_search，默认）
//                      POST https://qianfan.baidubce.com/v2/ai_search/chat/completions
//                      { messages:[{role:'user',content:查询}], search_source:'baidu_search_v2' }
//                      密钥 .env 的 BAIDU_SEARCH_KEY
//                      注意：**不要传 model** —— 传了会走"智能总结"模式，多数 key 没有该权限；
//                      不传 = 纯搜索模式，返回 references，由本机自己的 AI 去总结。
//            = deepseek DeepSeek 官方 Search API（自研搜索引擎，按次计费）
//                      POST https://api.deepseek.com/v1/tools/search
//                      { query, count } → { results:[{title,url,snippet,summary,content…}] }
//                      密钥复用 .env 的 AI_API_KEY（与 AI 对话同一个 DeepSeek 密钥）
//            = custom  自定义接口（.env 的 SEARCH_CUSTOM_KEY，留空则免鉴权）
//                      config.json search.customUrl 指向 DeepSeek 风格的原始 JSON 搜索接口：
//                      POST {query,count}，返回兼容 results（DeepSeek 风格）/ references（千帆风格）/
//                      choices[0].message.content（直接返回总结文本）三种之一
//
// 切换即时生效（config.json 热加载，无需重启）。
// ============================================================

import { logger } from './logger.js';
import { config } from './config.js';

const TIMEOUT_MS = 20000;
const SNIPPET_MAX = 300;   // 每条摘要截断长度：太长会把 prompt 撑爆又费 token

/** 全部可用的搜索后端 */
export const SEARCH_PROVIDERS = ['off', 'baidu', 'deepseek', 'custom'];

/** 当前生效的搜索配置（每次现读，config.json 热加载后立即生效） */
export function searchSettings() {
    const s = (config() && config().search) || {};
    let provider = String(s.provider || '').trim().toLowerCase();
    if (!SEARCH_PROVIDERS.includes(provider)) {
        logger.warn(`[搜索] 未知 provider「${provider}」，回退 baidu`);
        provider = 'baidu';
    }
    let limit = Number(s.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = 5;
    limit = Math.min(Math.floor(limit), 50);
    return {
        provider,
        limit,
        customUrl: String(s.customUrl || '').trim(),
        // 各后端的密钥：deepseek 复用 AI_API_KEY，其余从 .env 对应项取，都不落 config.json
        baiduKey: String(process.env.BAIDU_SEARCH_KEY || '').trim(),
        deepseekKey: String(process.env.AI_API_KEY || '').trim(),
        customKey: String(process.env.SEARCH_CUSTOM_KEY || '').trim(),
    };
}

/** 搜索功能整体是否可用（供 index.js 决定给不给模型 web_search 工具、网页状态展示） */
export function isSearchEnabled() {
    const s = searchSettings();
    if (s.provider === 'off') return false;
    if (s.provider === 'baidu') return !!s.baiduKey;
    if (s.provider === 'deepseek') return !!s.deepseekKey;
    return !!s.customUrl;
}

/** 把各家返回的条目归一成 { title, url, snippet }，丢掉没有内容的空条目（先过滤再截断，避免空条目占名额） */
function normalizeResults(list, limit) {
    return list
        .map((r) => ({
            title: String((r && r.title) || '').trim(),
            url: String((r && r.url) || '').trim(),
            snippet: String((r && (r.content || r.summary || r.snippet)) || '')
                .replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX),
        }))
        .filter((r) => r.url || r.snippet)
        .slice(0, limit);
}

// ---------- 后端：百度智能搜索（千帆 ai_search） ----------
async function searchBaidu(query, limit, key) {
    const res = await fetch('https://qianfan.baidubce.com/v2/ai_search/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messages: [{ role: 'user', content: query }],
            search_source: 'baidu_search_v2',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.error) throw new Error(String((j.error && (j.error.message || j.error)) || '百度返回错误'));
    return normalizeResults(Array.isArray(j.references) ? j.references : [], limit);
}

// ---------- 后端：DeepSeek 官方 Search API ----------
async function searchDeepseek(query, limit, key) {
    const res = await fetch('https://api.deepseek.com/v1/tools/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, count: limit }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
            const j = await res.json();
            if (j && j.error && j.error.message) msg = j.error.message;
        } catch { /* 读不出就按状态码报 */ }
        throw new Error(msg);
    }
    const j = await res.json();
    return normalizeResults(Array.isArray(j.results) ? j.results : [], limit);
}

// ---------- 后端：自定义接口 ----------
async function searchCustom(query, limit, url, key) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, count: limit }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
            const j = await res.json();
            if (j && j.error && j.error.message) msg = j.error.message;
        } catch { /* 读不出就按状态码报 */ }
        throw new Error(msg);
    }
    const j = await res.json();
    // 兼容三种常见返回：results（DeepSeek 风格）/ references（千帆风格）/ choices[0]（直接返回总结文本）
    if (Array.isArray(j.results)) return normalizeResults(j.results, limit);
    if (Array.isArray(j.references)) return normalizeResults(j.references, limit);
    const text = String((j.choices && j.choices[0] && j.choices[0].message
        && j.choices[0].message.content) || '').trim();
    if (text) {
        return [{ title: '', url: '', snippet: text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX * 2) }];
    }
    logger.warn('[搜索] 自定义接口返回了无法识别的结构：' + JSON.stringify(j).slice(0, 200));
    return [];
}

/**
 * 联网搜索入口。
 * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
 */
export async function webSearch(query, limit = 5) {
    const s = searchSettings();
    if (!isSearchEnabled()) {
        logger.info(`[搜索] provider=${s.provider} 未启用，跳过联网搜索`);
        return [];
    }
    const n = Math.max(1, Math.min(Number(limit) || s.limit, s.limit));
    const label = { baidu: '百度智能搜索', deepseek: 'DeepSeek 搜索', custom: '自定义搜索' }[s.provider] || s.provider;
    try {
        let out;
        if (s.provider === 'baidu') out = await searchBaidu(query, n, s.baiduKey);
        else if (s.provider === 'deepseek') out = await searchDeepseek(query, n, s.deepseekKey);
        else out = await searchCustom(query, n, s.customUrl, s.customKey);
        return out;
    } catch (e) {
        logger.warn(`[搜索] ${label}失败:`, e.message);
        return [];
    }
}

export async function getSearchContext(query, limit = 5) {
    const results = await webSearch(query, limit);
    if (results.length === 0) return '未找到相关结果。';
    let ctx = `以下是与“${query}”相关的搜索结果：\n\n`;
    results.forEach((r, i) => {
        ctx += `【${i + 1}】${r.title}\n链接：${r.url}\n摘要：${r.snippet}\n\n`;
    });
    ctx += '请根据搜索结果回答。若不足请如实告知。';
    return ctx;
}