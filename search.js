// ============================================================
// search.js - 联网搜索
// 用**正规搜索 API**（在 .env 里配一个 key 即可，按配置自动选择）：
//   BOCHA_API_KEY  → 博查 Web Search（中文搜索，国内直连，推荐）
//   TAVILY_API_KEY → Tavily（为 AI 设计，返回干净摘要）
//   BRAVE_API_KEY  → Brave Search（官方，有免费额度）
// 都没配时退回 DuckDuckGo（免 key，但非官方且国内常不可用）。
// ============================================================

import DDG from 'duck-duck-scrape';

const TIMEOUT_MS = 15000;

// ---------- 博查（https://open.bochaai.com） ----------
async function searchBocha(query, limit) {
  const res = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.BOCHA_API_KEY}`,
    },
    body: JSON.stringify({ query, count: limit, summary: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('博查 HTTP ' + res.status);
  const data = await res.json();
  const pages = (data?.data?.webPages?.value) || [];
  return pages.map((r) => ({
    title: r.name || '',
    url: r.url || '',
    snippet: String(r.summary || r.snippet || '').replace(/<[^>]+>/g, ''),
  }));
}

// ---------- Tavily（https://tavily.com） ----------
async function searchTavily(query, limit) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: limit,
      search_depth: 'basic',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('Tavily HTTP ' + res.status);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: String(r.content || ''),
  }));
}

// ---------- Brave Search（https://brave.com/search/api） ----------
async function searchBrave(query, limit) {
  const url = 'https://api.search.brave.com/res/v1/web/search?q='
    + encodeURIComponent(query) + '&count=' + limit;
  const res = await fetch(url, {
    headers: {
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('Brave HTTP ' + res.status);
  const data = await res.json();
  const items = (data?.web?.results) || [];
  return items.map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: String(r.description || '').replace(/<[^>]+>/g, ''),
  }));
}

// ---------- DuckDuckGo（兜底；非官方，国内可能不可达） ----------
async function searchDDG(query, limit) {
  const result = await DDG.search(query, { safeSearch: DDG.SafeSearchType.MODERATE });
  if (!result.results || result.results.length === 0) return [];
  return result.results.slice(0, limit).map((r) => ({
    title: r.title || '无标题',
    url: r.url || '',
    snippet: r.description || r.snippet || '无摘要',
  }));
}

/** 按 .env 里配了哪个 key 选搜索源 */
function pickProvider() {
  if (process.env.BOCHA_API_KEY) return { name: '博查', run: searchBocha };
  if (process.env.TAVILY_API_KEY) return { name: 'Tavily', run: searchTavily };
  if (process.env.BRAVE_API_KEY) return { name: 'Brave', run: searchBrave };
  return { name: 'DuckDuckGo', run: searchDDG };
}

export async function webSearch(query, limit = 5) {
  const p = pickProvider();
  try {
    const r = await p.run(query, limit);
    if (r.length) return r;
    console.log(`[搜索] ${p.name} 无结果`);
  } catch (e) {
    console.log(`[搜索] ${p.name} 失败: ${e.message}`);
  }
  // 非 DuckDuckGo 时再做一次兜底；DuckDuckGo 已经失败就不重复了
  if (p.name !== 'DuckDuckGo') {
    try {
      const r = await searchDDG(query, limit);
      if (r.length) return r;
    } catch (e) {
      console.error('[搜索] DuckDuckGo 兜底也失败:', e.message);
    }
  }
  return [];
}

/** 搜索是否已配置可用的搜索源（用于给人提示） */
export function searchProviderName() {
  return pickProvider().name;
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
