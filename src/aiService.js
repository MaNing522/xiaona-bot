// ============================================================
// aiService.js - AI 服务商可插拔层
//
// 把「选服务商 → 定 URL / 模型 → 发请求」收敛到一处，index.js 只管调用。
// 任何 OpenAI 兼容的 /chat/completions 接口都能接（DeepSeek / OpenAI / 自建…）。
//
// 配置（.env）：
//   AI_PROVIDER   deepseek(默认) / openai / custom
//   AI_API_URL    显式指定则优先于 provider 默认值
//   AI_API_KEY    缺此项 = AI 对话整体停用
//   AI_MODEL      显式指定则优先于 provider 默认值
//   AI_BALANCE_URL       自定义「使用情况/余额」查询地址（填了就不按服务商推导）
//   AI_FALLBACK_URL/KEY/MODEL  备用接口：主接口掉线/429 时自动顶上（key 不填就不启用）
// 网页「全局设置 → AI 接口」可增删多个接口并切换当前用哪个（存 data/ai-providers.json，不进仓库）。
// 注：glm 系列在这类中转上经常 429，不建议当主力模型。
// ============================================================
import { logger } from './logger.js';
import { config } from './config.js';
import { activeProvider, getActiveId } from './aiProviders.js';

/** 各服务商的默认接入点与默认模型（仅在 .env 未显式配置时兜底） */
const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-flash',
    balancePath: '/user/balance', // 有余额接口
  },
  openai: {
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    balancePath: '', // 无余额接口
  },
  custom: {
    name: '自定义',
    url: '',
    model: '',
    balancePath: '',
  },
};

function providerKey() {
  const k = String(process.env.AI_PROVIDER || '')
    .trim()
    .toLowerCase();
  return PROVIDERS[k] ? k : 'deepseek';
}

/** 当前生效的配置（每次读取，.env 改了不用重启进程也能生效） */
export function getProviderInfo() {
  const key = providerKey();
  const p = PROVIDERS[key];
  const configuredUrl = String(process.env.AI_API_URL || '').trim();
  const configuredModel = String(process.env.AI_MODEL || '').trim();
  return {
    provider: key,
    name: p.name,
    url: configuredUrl || p.url,
    model: configuredModel || p.model,
    hasKey: !!String(process.env.AI_API_KEY || '').trim(),
  };
}

/** AI 是否可用（缺 key 或缺 URL 即不可用） */
export function isAiEnabled() {
  const c = getProviderInfo();
  return !!(c.hasKey && c.url);
}

/**
 * 备用接口（主接口掉线/429 时自动顶上）。
 * 没配 AI_FALLBACK_KEY 就返回 null，不启用兜底。
 */
export function getFallbackInfo() {
  const key = String(process.env.AI_FALLBACK_KEY || '').trim();
  if (!key) return null;
  return {
    name: '备用',
    url: String(process.env.AI_FALLBACK_URL || 'https://api.deepseek.com/chat/completions').trim(),
    key,
    model: String(process.env.AI_FALLBACK_MODEL || 'deepseek-flash').trim(),
  };
}

/**
 * 服务商账户余额接口地址。
 * 只对已知支持的服务商返回地址；否则返回 ''（调用方给友好提示，而不是报错）。
 */
export function balanceEndpoint() {
  const custom = String(process.env.AI_BALANCE_URL || '').trim();
  if (custom) return custom;
  const c = getProviderInfo();
  if (!c.url) return '';
  const p = PROVIDERS[c.provider];
  if (!p.balancePath) return '';
  // 由 chat/completions 反推 API 根地址
  const base = c.url.replace(/\/chat\/completions.*$/i, '').replace(/\/+$/, '');
  return base ? base + p.balancePath : '';
}

/**
 * 按输入挑一个合适的 max_tokens（**绝不允许不设**：不设就是放任模型写长，那是成本大头）。
 *   闲聊/默认 → AI_MAX_TOKENS（默认 512）
 *   明显要长文（总结、展开、写一篇…）→ AI_MAX_TOKENS_LONG（默认 1200）
 *   一句话的短问答 → AI_MAX_TOKENS_SHORT（默认 300）
 */
export function pickMaxTokens(userInput) {
  const base = intEnv('AI_MAX_TOKENS', 512);
  const short = intEnv('AI_MAX_TOKENS_SHORT', 300);
  const long = intEnv('AI_MAX_TOKENS_LONG', 1200);
  const s = String(userInput || '');
  if (/总结|概括|归纳|展开|详细说|写一篇|写个方案|长文|分析一下全部|翻译全文/.test(s)) return long;
  // 短问答：很短的一句问话，答完就完，不需要长篇
  if (s.length <= 15 && /[?？]$/.test(s.trim())) return short;
  return base;
}

function intEnv(name, dflt) {
  const n = Number(String(process.env[name] || '').trim());
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * 读取 config.json 的 ai 段（每次请求都读，改完热加载立即生效）。
 * 非法值一律回退到安全默认，免得配置写错把 AI 请求搞挂。
 */
export function aiSettings() {
  const a = (config() && config().ai) || {};
  const effort = String(a.reasoningEffort || 'auto').trim().toLowerCase();
  const temp = Number(a.temperature);
  const ctx = Number(a.contextMessages);
  return {
    thinking: a.thinking !== false,
    reasoningEffort: ['low', 'high', 'max'].includes(effort) ? effort : 'auto',
    contextMessages: Number.isFinite(ctx) ? Math.min(50, Math.max(5, Math.round(ctx))) : 20,
    temperature: Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : 0.7,
  };
}

/**
 * 把「是否思考 / 思考强度」翻译成请求参数（纯函数，方便单测）。
 * DeepSeek（2026）用 reasoning_effort 一个参数同时控制开关与强度：
 *   none = 关闭思考；low / high / max = 开启并指定强度。
 * auto = 不传，跟随模型默认（保持旧行为，也避免给不认这个参数的接口添乱）。
 */
export function reasoningParams(ai) {
  const a = ai || {};
  const thinking = a.thinking !== false;
  const effort = String(a.reasoningEffort || 'auto').trim().toLowerCase();
  if (!thinking) return { reasoning_effort: 'none' };
  if (['low', 'high', 'max'].includes(effort)) return { reasoning_effort: effort };
  return {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 主接口熔断时间点：失败（掉线/429/5xx）后 5 分钟内直接走备用接口，到期再试主接口
let primaryDownUntil = 0;

// 网络层可重试的错误码：DNS 临时失败（EAI_AGAIN，家宽路由器最常见）、
// 连接被重置/拒绝、网络不可达、undici 自己的连接错误
const RETRYABLE_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/** 从错误链（cause 可能套好几层）里找错误码 */
function errCodeOf(e) {
  let cur = e;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.code) return String(cur.code);
    cur = cur.cause;
  }
  return '';
}

/** 是不是「网络抖动」这类重试一次就能好的错误（超时除外，超时重试太耗时间） */
function isTransientNetErr(e) {
  if (!e || e.name === 'TimeoutError' || e.name === 'AbortError') return false;
  if (RETRYABLE_CODES.has(errCodeOf(e))) return true;
  return /fetch failed|socket hang up|other side closed|EAI_AGAIN|ECONNRESET/i.test(String(e.message || ''));
}

/**
 * 把模型写在正文里的工具调用还原成标准 tool_calls。
 *
 * 有些中转/模型不支持结构化 function calling，会把
 * `<tool_calls><tool_call>{"name":"mc_status","arguments":{}}</tool_call></tool_calls>`、
 * 单个 `<tool_call>…</tool_call>` 或 `<function=mc_status>{…}</function>` 当普通文本吐出来。
 * 不还原的话，这段 XML 会被当成聊天内容发出去，agent 看起来就"压根没调工具"。
 * 只认当前这次请求里真实存在的工具名，避免把正文里的同名文本误当调用。
 */
export function extractTextToolCalls(content, tools = []) {
  const allowed = new Set((tools || []).map((t) => t && t.function && t.function.name).filter(Boolean));
  const calls = [];
  let seq = 0;
  const toCall = (name, args) => {
    const n = String(name || '').trim();
    if (!n || (allowed.size && !allowed.has(n))) return null;
    let payload = '{}';
    if (typeof args === 'string') payload = args.trim() || '{}';
    else if (args && typeof args === 'object') payload = JSON.stringify(args);
    seq += 1;
    return { id: `txt_${Date.now()}_${seq}`, type: 'function', function: { name: n, arguments: payload } };
  };
  const parseRaw = (raw) => {
    const out = [];
    let s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const fm = s.match(/<function[=\s]\s*"?([A-Za-z0-9_]+)"?\s*>([\s\S]*?)<\/function>/i);
    if (fm) {
      const c = toCall(fm[1], fm[2]);
      if (c) out.push(c);
      return out;
    }
    try {
      const j = JSON.parse(s);
      for (const item of (Array.isArray(j) ? j : [j])) {
        const fn = item && item.function && typeof item.function === 'object' ? item.function : null;
        const c = toCall(
          item && (item.name || item.tool || (fn && fn.name)),
          item && (item.arguments ?? item.args ?? item.parameters ?? (fn && fn.arguments)),
        );
        if (c) out.push(c);
      }
    } catch { /* 不是 JSON 就忽略 */ }
    return out;
  };

  let text = String(content || '');
  // 1) 复数包裹：<tool_calls>…</tool_calls>（里面可能有多条 <tool_call>，也可能直接是 JSON）
  text = text.replace(/<tool_calls[^>]*>([\s\S]*?)<\/tool_calls>/gi, (whole, inner) => {
    const before = calls.length;
    const itemRe = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi;
    let m;
    let found = false;
    while ((m = itemRe.exec(inner))) {
      found = true;
      calls.push(...parseRaw(m[1]));
    }
    if (!found) calls.push(...parseRaw(inner));
    return calls.length > before ? '' : whole;
  });
  // 2) 单个 <tool_call>…</tool_call>
  text = text.replace(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi, (whole, inner) => {
    const got = parseRaw(inner);
    if (!got.length) return whole;
    calls.push(...got);
    return '';
  });
  // 3) 不带 tool_call 包裹的 <function=名字>参数</function>
  text = text.replace(/<function[=\s]\s*"?([A-Za-z0-9_]+)"?\s*>([\s\S]*?)<\/function>/gi, (whole, name, args) => {
    const c = toCall(name, args);
    if (!c) return whole;
    calls.push(c);
    return '';
  });
  // 4) DeepSeek 的 DSML 标签：<|DSML|invoke name="x"><|DSML|parameter name="k">v</|DSML|parameter></|DSML|invoke>
  //    （中转常把它原样当正文吐出来，之前会整段发到聊天里）
  const dsmlInvoke = /<\|{1,2}\s*DSML\s*\|{1,2}\s*invoke\b([^>]*)>([\s\S]*?)<\/\|{1,2}\s*DSML\s*\|{1,2}\s*invoke\s*>/gi;
  text = text.replace(dsmlInvoke, (whole, attrs, inner) => {
    const nm = String(attrs || '').match(/name\s*=\s*["']?([A-Za-z0-9_]+)/i);
    if (!nm) return whole;
    const args = {};
    const paramRe = /<\|{1,2}\s*DSML\s*\|{1,2}\s*parameter\b([^>]*)>([\s\S]*?)<\/\|{1,2}\s*DSML\s*\|{1,2}\s*parameter\s*>/gi;
    let pm;
    while ((pm = paramRe.exec(inner))) {
      const kn = String(pm[1] || '').match(/name\s*=\s*["']?([A-Za-z0-9_]+)/i);
      if (kn) args[kn[1]] = String(pm[2] || '').trim();
    }
    const c = toCall(nm[1], args);
    if (!c) return whole;
    calls.push(c);
    return '';
  });
  // 5) 还残留的 DSML 标签（外层包裹、残缺片段）一律清掉，绝不能发到聊天里
  text = text.replace(/<\/?\|{1,2}\s*DSML\s*\|{1,2}[^>]*>/gi, '');
  return { content: text.trim(), tool_calls: calls.length ? calls : null };
}

/**
 * 发一次对话补全请求，返回**完整的助手消息**（含 tool_calls），供 agent 工具循环使用。
 * tools 传入 OpenAI 兼容的工具定义数组时，模型可自主返回 tool_calls。
 * @returns {Promise<{content:string, tool_calls:Array|null}>}
 */
export async function chatCompletionRaw({ messages, temperature, maxTokens, timeoutMs = 60000, userId, tools, toolChoice, signal }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // 外部取消（整轮超时/用户打断）与单次超时取并集：任一触发都立刻中断请求
  const reqSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const c = getProviderInfo();
  const envFallback = getFallbackInfo();
  const picked = activeProvider();
  const activeId = getActiveId();

  // 主接口：网页选了自定义接口就用它；选「官方备用」则直接用 .env 的备用；否则按 .env 主接口
  let primary;
  let fallback = envFallback;
  if (activeId === 'fallback' && envFallback) {
    primary = envFallback;
    fallback = null;
  } else if (picked) {
    primary = { name: picked.name, url: picked.url, key: picked.key, model: picked.model };
  } else {
    if (!c.hasKey) throw new Error('未配置 AI_API_KEY');
    if (!c.url) throw new Error('未配置 AI_API_URL（provider=custom 时必须显式指定）');
    primary = { name: c.name, url: c.url, key: String(process.env.AI_API_KEY || '').trim(), model: c.model };
  }
  if (!primary || !primary.url) throw new Error('当前 AI 接口没有配置地址');
  if (!primary.key) throw new Error(`AI 接口「${primary.name || primary.model}」没有配置密钥`);

  const ai = aiSettings();
  const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : ai.temperature;
  const body = {
    messages,
    temperature: Math.min(2, Math.max(0, temp)),
    max_tokens: maxTokens || intEnv('AI_MAX_TOKENS', 512),
    // 思考开关 / 强度（config.json 的 ai 段）；auto 时不传
    ...reasoningParams(ai),
  };
  // 传 user：服务商据此做 KVCache 隔离，同一个人的连续对话更容易命中前缀缓存（命中价差极大）
  if (userId) body.user = String(userId);
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }

  /**
   * 向指定接口发一次请求。
   * 返回 content / tool_calls / finishReason；finishReason 用于识别"被思维链吃光"的情况。
   * 网络抖动（DNS 临时失败、连接被重置）自动重试，最多 3 次，避免一句"技术问题"打发用户。
   */
  async function sendTo(cfg) {
    const ATTEMPTS = 3;
    const payload = JSON.stringify({ ...body, model: cfg.model });
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
          body: payload,
          signal: reqSignal,
        });
        break;
      } catch (e) {
        // 被整轮取消：不当作"服务商超时"，交给上层静默收尾
        if (signal && signal.aborted) {
          throw new Error('本轮已取消', { cause: e });
        }
        // 超时/断网这类没拿到响应的情况，单独给个能看懂的原因
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new Error(`AI 超时（${Math.round(timeoutMs / 1000)} 秒内没响应）`, { cause: e });
        }
        if (attempt < ATTEMPTS && isTransientNetErr(e)) {
          const code = errCodeOf(e) || (e && e.message) || '未知错误';
          logger.warn(`[AI] 连接失败（${code}），${400 * attempt}ms 后重试（第 ${attempt + 1}/${ATTEMPTS} 次）`);
          await sleep(400 * attempt);
          continue;
        }
        throw new Error(`连不上 AI 服务：${e && e.message ? e.message : e}`, { cause: e });
      }
    }
    if (!res.ok) {
      // 带上服务商返回的原文（如"余额不足""model not found"），方便直接看出原因
      let detail = '';
      try {
        detail = String(await res.text() || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      } catch { /* 读不出就算了，状态码本身也算原因 */ }
      throw new Error(`AI 请求失败 (${res.status})${detail ? '：' + detail : ''}`);
    }

    const data = await res.json();
    if (!data.choices || data.choices.length === 0) throw new Error('AI 返回格式异常');
    const choice = data.choices[0];
    const m = choice.message || {};
    // 结构化 tool_calls 优先；没有就把正文里的 XML 工具调用解析出来（并清掉这段文本）
    const parsed = extractTextToolCalls(m.content || '', tools);
    const structured = Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : null;
    return {
      content: parsed.content,
      tool_calls: structured || parsed.tool_calls,
      finishReason: choice.finish_reason || '',
    };
  }

  /**
   * 主接口优先；失败（掉线/429/5xx）且配了备用接口时，切换过去并熔断 5 分钟，
   * 期间直接走备用，避免每条消息都先在坏接口上超时一次。
   */
  async function send() {
    if (!fallback || Date.now() >= primaryDownUntil) {
      try {
        const r = await sendTo(primary);
        primaryDownUntil = 0;
        return r;
      } catch (e) {
        if (!fallback) throw e;
        logger.warn(`[AI] 主接口（${primary.model}）失败：${String(e.message).slice(0, 120)}；临时切到备用 ${fallback.model}`);
        primaryDownUntil = Date.now() + 5 * 60 * 1000;
      }
    }
    try {
      return await sendTo(fallback);
    } catch (e) {
      throw new Error(`主接口不可用，备用接口（${fallback.model}）也失败：${e.message}`, { cause: e });
    }
  }

  const first = await send();
  // 推理模型（如 deepseek-flash）会先花 token 想，max_tokens 不够时思维链把额度吃光，
  // 正文 content 是空的、finish_reason=length —— 这时把额度翻倍重试一次，别把空回复当结果。
  const starved = !first.content && !first.tool_calls && first.finishReason === 'length';
  if (!starved) return { content: first.content, tool_calls: first.tool_calls };

  const retryTokens = Math.min(Number(body.max_tokens) * 2, 8000);
  logger.warn(`[AI] 思维链吃光额度（max_tokens=${body.max_tokens}），按 ${retryTokens} 重试一次`);
  body.max_tokens = retryTokens;
  const second = await send();
  const stillEmpty = !second.content && !second.tool_calls;
  if (stillEmpty && second.finishReason === 'length') {
    throw new Error(`模型只输出了思考过程、没给出正文（max_tokens=${retryTokens} 仍不够）`);
  }
  return { content: second.content, tool_calls: second.tool_calls };
}

/**
 * 发一次对话补全请求，返回助手回复文本。
 * @param {{messages:Array, temperature?:number, maxTokens?:number, timeoutMs?:number, userId?:string}} opts
 * @returns {Promise<string>}
 */
export async function chatCompletion(opts) {
  const { content } = await chatCompletionRaw(opts);
  return content;
}

/** 启动时打印一行，便于确认当前接的是哪家 */
export function logProviderInfo() {
  const c = getProviderInfo();
  const f = getFallbackInfo();
  const picked = activeProvider();
  const active = getActiveId();
  let line;
  if (active === 'fallback' && f) line = `模型: ${f.model}（官方备用）`;
  else if (picked) line = `模型: ${picked.model}（网页：${picked.name}）`;
  else line = c.hasKey ? `模型: ${c.model}（${c.name}）` : '模型: （未配置，AI 对话不可用）';
  logger.info(line + (f && active !== 'fallback' ? `，备用: ${f.model}` : ''));
}
