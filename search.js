// ============================================================
// search.js - 联网搜索（无 API Key）
// 优先 Bing（国内可访问），失败时回退 DuckDuckGo
// ============================================================

import DDG from 'duck-duck-scrape';

const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 简单 HTML 实体解码 + 去标签
function decode(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Bing 网页搜索（抓取 b_algo 结果块）
async function searchBing(query, limit) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=20';
  const res = await fetch(url, {
    headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('Bing HTTP ' + res.status);
  const html = await res.text();
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const b of blocks) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const title = decode(a[2]);
    const url2 = a[1];
    const snippet = decode(p ? p[1] : '');
    if (title && url2 && !/^javascript:/i.test(url2)) {
      out.push({ title: title.slice(0, 120), url: url2, snippet: snippet.slice(0, 220) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

// DuckDuckGo 搜索（兜底）
async function searchDDG(query, limit) {
  const result = await DDG.search(query, { safeSearch: DDG.SafeSearchType.MODERATE });
  if (!result.results || result.results.length === 0) return [];
  return result.results.slice(0, limit).map((r) => ({
    title: r.title || '无标题',
    url: r.url || '',
    snippet: r.description || r.snippet || '无摘要',
  }));
}

export async function webSearch(query, limit = 5) {
  // 优先 Bing
  try {
    const r = await searchBing(query, limit);
    if (r.length) return r;
    console.log('[搜索] Bing 无结果，回退 DDG');
  } catch (e) {
    console.log('[搜索] Bing 失败:', e.message, '，回退 DDG');
  }
  // 回退 DuckDuckGo
  try {
    return await searchDDG(query, limit);
  } catch (e) {
    console.error('[搜索] DDG 也失败:', e.message);
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
