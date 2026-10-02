// ============================================================
// search.js - 联网搜索（百度智能搜索 / 千帆 ai_search）
//
//   POST https://qianfan.baidubce.com/v2/ai_search/chat/completions
//   { messages:[{role:'user',content:查询}], search_source:'baidu_search_v2' }
//
// 注意：**不要传 model** —— 传了会走"智能总结"模式，多数 key 没有该权限
// 会直接返回 invalid_appId。不传 = 纯搜索模式，返回 references，
// 由本机自己的 AI 去总结，既省额度也更贴合人设。
// 密钥放 .env 的 BAIDU_SEARCH_KEY（不填则搜索功能静默关闭）。
// ============================================================

const TIMEOUT_MS = 20000;
const SNIPPET_MAX = 300;   // 每条摘要截断长度：太长会把 prompt 撑爆又费 token

function apiKey() {
  return String(process.env.BAIDU_SEARCH_KEY || '').trim();
}

export async function webSearch(query, limit = 5) {
  const key = apiKey();
  if (!key) {
    console.log('[搜索] 未配置 BAIDU_SEARCH_KEY，跳过联网搜索');
    return [];
  }
  try {
    const res = await fetch('https://qianfan.baidubce.com/v2/ai_search/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        search_source: 'baidu_search_v2',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.code && j.code !== 0) throw new Error(j.message || String(j.code));
    const refs = Array.isArray(j.references) ? j.references : [];
    return refs.slice(0, limit).map((r) => ({
      title: String(r.title || '').trim(),
      url: String(r.url || '').trim(),
      snippet: String(r.content || r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX),
    }));
  } catch (e) {
    console.log('[搜索] 百度智能搜索失败:', e.message);
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
