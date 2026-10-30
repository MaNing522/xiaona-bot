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
// ============================================================
import { logger } from './logger.js';
import { config } from './config.js';

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
 * 服务商账户余额接口地址。
 * 只对已知支持的服务商返回地址；否则返回 ''（调用方给友好提示，而不是报错）。
 */
export function balanceEndpoint() {
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
 * 发一次对话补全请求，返回**完整的助手消息**（含 tool_calls），供 agent 工具循环使用。
 * tools 传入 OpenAI 兼容的工具定义数组时，模型可自主返回 tool_calls。
 * @returns {Promise<{content:string, tool_calls:Array|null}>}
 */
export async function chatCompletionRaw({ messages, temperature, maxTokens, timeoutMs = 60000, userId, tools, toolChoice }) {
  const c = getProviderInfo();
  if (!c.hasKey) throw new Error('未配置 AI_API_KEY');
  if (!c.url) throw new Error('未配置 AI_API_URL（provider=custom 时必须显式指定）');

  const ai = aiSettings();
  const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : ai.temperature;
  const body = {
    model: c.model,
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
   * 发一次请求。
   * 返回 content / tool_calls / finishReason；finishReason 用于识别"被思维链吃光"的情况。
   * 网络抖动（DNS 临时失败、连接被重置）自动重试，最多 3 次，避免一句"技术问题"打发用户。
   */
  async function send() {
    const ATTEMPTS = 3;
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(c.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        break;
      } catch (e) {
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
    return {
      content: m.content || '',
      tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : null,
      finishReason: choice.finish_reason || '',
    };
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
  logger.info(c.hasKey ? `模型: ${c.model}（${c.name}）` : '模型: （未配置，AI 对话不可用）');
}
