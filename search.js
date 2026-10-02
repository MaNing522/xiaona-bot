// ============================================================
// search.js - 联网搜索
// 按 .env 配置自动选择搜索源，逐个降级（前面的失败就试下一个）：
//   SEARXNG_URL    → 自建 SearXNG（零成本、私有、keyless，推荐）
//   BOCHA_API_KEY  → 博查 Web Search（中文搜索，国内直连）
//   TAVILY_API_KEY → Tavily（为 AI 设计，返回干净摘要）
//   BRAVE_API_KEY  → Brave Search（官方，有免费额度）
//   最后兜底        → DuckDuckGo（免 key，非官方，国内常不可达）
// ============================================================

import DDG from 'duck-duck-scrape';

const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------- 自建 SearXNG（JSON API） ----------
async function searchSearxng(query, limit) {
  const base = String(process.env.SEARXNG_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置 SEARXNG_URL');
  const url = `${base}/search?q=${encodeURIComponent(query)}`
    + `&format=json&language=zh-CN&safesearch=1`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('SearXNG HTTP ' + res.status);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 最常见的原因：settings.yml 的 search.formats 里没开 json，于是返回了 HTML
    throw new Error('SearXNG 返回的不是 JSON（请在 settings.yml 的 search.formats 里加上 json 并重启）');
  }
  const items = Array.isArray(data.results) ? data.results : [];
  return items.slice(0, limit).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: String(r.content || r.snippet || ''),
  }));
}

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

/** 按 .env 配置排出搜索源顺序，逐个降级；DuckDuckGo 永远垫底 */
function pickProviders() {
  const list = [];
  if (String(process.env.SEARXNG_URL || '').trim()) list.push({ name: 'SearXNG', run: searchSearxng });
  if (String(process.env.BOCHA_API_KEY || '').trim()) list.push({ name: '博查', run: searchBocha });
  if (String(process.env.TAVILY_API_KEY || '').trim()) list.push({ name: 'Tavily', run: searchTavily });
  if (String(process.env.BRAVE_API_KEY || '').trim()) list.push({ name: 'Brave', run: searchBrave });
  list.push({ name: 'DuckDuckGo', run: searchDDG });
  return list;
}

export async function webSearch(query, limit = 5) {
  const providers = pickProviders();
  for (const p of providers) {
    try {
      const r = await p.run(query, limit);
      if (r.length) return r;
      console.log(`[搜索] ${p.name} 无结果`);
    } catch (e) {
      console.log(`[搜索] ${p.name} 失败: ${e.message}`);
    }
  }
  return [];
}

/** 当前搜索源名称（第一个配置好的），用于给人提示 */
export function searchProviderName() {
  return pickProviders()[0].name;
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
