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

/** 各服务商的默认接入点与默认模型（仅在 .env 未显式配置时兜底） */
const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
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
 * 发一次对话补全请求，返回助手回复文本。
 * @param {{messages:Array, temperature?:number, maxTokens?:number, timeoutMs?:number}} opts
 * @returns {Promise<string>}
 */
export async function chatCompletion({ messages, temperature = 0.7, maxTokens = 2048, timeoutMs = 60000 }) {
  const c = getProviderInfo();
  if (!c.hasKey) throw new Error('未配置 AI_API_KEY');
  if (!c.url) throw new Error('未配置 AI_API_URL（provider=custom 时必须显式指定）');

  const res = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({ model: c.model, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`AI 请求失败 (${res.status})`);

  const data = await res.json();
  if (!data.choices || data.choices.length === 0) throw new Error('AI 返回格式异常');
  return data.choices[0].message.content || '';
}

/** 启动时打印一行，便于确认当前接的是哪家 */
export function logProviderInfo() {
  const c = getProviderInfo();
  logger.info(c.hasKey ? `模型: ${c.model}（${c.name}）` : '模型: （未配置，AI 对话不可用）');
}
