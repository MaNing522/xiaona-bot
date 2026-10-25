// ============================================================
// chatSettings.js - 会话级设置（群聊 / 单聊各自可覆盖全局）
//
// 背景：网页「会话管理」要能针对某个群/某个私聊单独调设置，没设置的项回退到全局。
//   · 全局设置 = config.json（由 config.js 读取，热加载生效）
//   · 会话覆盖 = 本模块，落盘到 data/chat-settings.json，只存"被显式改过"的项
//
// key 约定：g:<群号>（群聊）/ p:<QQ号>（单聊）。
// 对外主要给 getEffective(key)：返回「全局 ∪ 会话覆盖」的合并结果，调用方无需关心三层。
// ============================================================
import path from 'path';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import { config } from './config.js';
import { logger } from './logger.js';

let SETTINGS_FILE = '';
let store = {}; // { 'g:123': { reply?, keyword?, voice?, extraPrompt?, rateLimit:{…}, cooldown:{…}, engage:{…} } }

const KEY_RE = /^(?:p|g):\d{5,14}$/;

// 允许被单个会话覆盖的数值项（其余数值忽略，避免会话把全局策略改坏）
const NUM_KEYS = {
  rateLimit: ['userCooldownMs', 'userPerMinute', 'userPerHour', 'userPerDay', 'groupPerMinute', 'groupPerHour'],
  cooldown: ['pokeMs', 'shakeMs', 'forwardMs', 'forwardDelayMs'],
  engage: ['ttlMs', 'initiatorLeft', 'otherLeft'],
};

/** 初始化：指定落盘目录并加载（由 index.js 在拿到 SAVE_DIR 后调用） */
export function initChatSettings(dir) {
  SETTINGS_FILE = path.join(dir, 'chat-settings.json');
  const d = readJsonSafe(SETTINGS_FILE, {}, 'chat-settings.json');
  store = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  return store;
}

/** key 是否合法（g:群号 / p:QQ号） */
export function isConvKey(key) {
  return KEY_RE.test(String(key || ''));
}

function persist() {
  if (!SETTINGS_FILE) return;
  writeJsonAtomic(SETTINGS_FILE, store);
}

/** 该会话的原始覆盖（未与全局合并），供网页显示"哪些是覆盖项" */
export function overridesOf(key) {
  if (!isConvKey(key)) return {};
  return store[String(key)] || {};
}

/** 全部会话覆盖（副本），供网页列出 */
export function allOverrides() {
  return JSON.parse(JSON.stringify(store));
}

/** 有覆盖记录的会话 key 列表 */
export function listKeys() {
  return Object.keys(store);
}

/**
 * 设置某会话是否置顶（独立于其它覆盖项；置顶只是网页列表排序用）。
 * @returns {{ok:boolean, error?:string}}
 */
export function setPin(key, pinned) {
  const k = String(key || '');
  if (!isConvKey(k)) return { ok: false, error: 'key 格式错误（g:群号 或 p:QQ号）' };
  // 显式记录 true / false：false 表示"主人会话也手动取消置顶"，不再走默认置顶
  const cur = { ...(store[k] || {}), pin: !!pinned };
  store[k] = cur;
  persist();
  return { ok: true };
}

/** 全部置顶的会话 key 列表 */
export function pinnedKeys() {
  return Object.keys(store).filter((k) => store[k] && store[k].pin === true);
}

/** 把数值项里合法的键拷出来（≥0 的有限数），非法忽略 */
function cleanNums(src, allowed) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of allowed) {
    const n = Number(src[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/**
 * 写入某会话的覆盖项（增量合并）。传入的项为「显式改过」；置空（''/null/undefined）表示"清除该项，回退全局"。
 * @param {string} key  g:群号 / p:QQ号
 * @param {object} patch 可含 reply/keyword/voice/extraPrompt/rateLimit/cooldown/engage
 * @returns {{ok:boolean, error?:string, overrides?:object}}
 */
export function set(key, patch = {}) {
  const k = String(key || '');
  if (!isConvKey(k)) return { ok: false, error: 'key 格式错误（g:群号 或 p:QQ号）' };
  const cur = JSON.parse(JSON.stringify(store[k] || {}));

  // ---- 布尔项：reply / voice ----
  for (const f of ['reply', 'voice']) {
    if (f in patch) {
      const v = patch[f];
      if (v === '' || v === null || v === undefined) delete cur[f];
      else if (typeof v === 'boolean') cur[f] = v;
      else if (v === 'true' || v === 'false') cur[f] = v === 'true';
      else if (v === 1 || v === 0) cur[f] = v === 1;
    }
  }
  // ---- 文本项：keyword / extraPrompt ----
  for (const f of ['keyword', 'extraPrompt']) {
    if (f in patch) {
      const v = patch[f];
      const s = v === null || v === undefined ? '' : String(v).trim();
      if (!s) delete cur[f];
      else cur[f] = s;
    }
  }
  // ---- 数值项 ----
  for (const grp of ['rateLimit', 'cooldown', 'engage']) {
    if (!(grp in patch)) continue;
    const merged = { ...(cur[grp] || {}), ...cleanNums(patch[grp], NUM_KEYS[grp]) };
    // 显式传空字符串/负数的键，当作清除
    if (patch[grp] && typeof patch[grp] === 'object') {
      for (const kk of NUM_KEYS[grp]) {
        if (kk in patch[grp]) {
          const v = patch[grp][kk];
          if (v === '' || v === null || v === undefined || !(Number.isFinite(Number(v)) && Number(v) >= 0)) delete merged[kk];
        }
      }
    }
    if (Object.keys(merged).length) cur[grp] = merged; else delete cur[grp];
  }
  // ---- 进出群提醒：notice = { enabled?, joinText?, leaveText? }（只有群聊用得上）----
  if ('notice' in patch) {
    const src = patch.notice && typeof patch.notice === 'object' ? patch.notice : {};
    const merged = { ...(cur.notice || {}) };
    if ('enabled' in src) {
      const v = src.enabled;
      if (v === '' || v === null || v === undefined) delete merged.enabled;
      else if (typeof v === 'boolean') merged.enabled = v;
      else if (v === 'true' || v === 'false') merged.enabled = v === 'true';
      else if (v === 1 || v === 0) merged.enabled = v === 1;
    }
    for (const f of ['joinText', 'leaveText']) {
      if (f in src) {
        const s = src[f] === null || src[f] === undefined ? '' : String(src[f]).trim();
        if (!s) delete merged[f]; else merged[f] = s;
      }
    }
    if (Object.keys(merged).length) cur.notice = merged; else delete cur.notice;
  }

  if (Object.keys(cur).length) store[k] = cur; else delete store[k];
  persist();
  logger.info(`[会话设置] 更新 ${k} ${JSON.stringify(cur)}`);
  return { ok: true, overrides: cur };
}

/** 合并全局配置与该会话覆盖，得到"最终生效"的设置 */
export function getEffective(key) {
  const g = config();
  const o = isConvKey(key) ? (store[String(key)] || {}) : {};
  const chat = g.chat || {};
  const gn = g.notice || {};
  const on = o.notice || {};
  return {
    reply: typeof o.reply === 'boolean' ? o.reply : chat.botReply !== false,
    keyword: typeof o.keyword === 'string' ? o.keyword : (chat.keyword || ''),
    voice: typeof o.voice === 'boolean' ? o.voice : chat.voice !== false,
    extraPrompt: typeof o.extraPrompt === 'string' ? o.extraPrompt : (chat.extraPrompt || ''),
    notice: {
      enabled: typeof on.enabled === 'boolean' ? on.enabled : gn.enabled !== false,
      joinText: typeof on.joinText === 'string' ? on.joinText : (gn.joinText || ''),
      leaveText: typeof on.leaveText === 'string' ? on.leaveText : (gn.leaveText || ''),
    },
    rateLimit: { ...g.rateLimit, ...(o.rateLimit || {}) },
    cooldown: { ...g.cooldown, ...(o.cooldown || {}) },
    engage: { ...g.engage, ...(o.engage || {}) },
    overrides: o,
  };
}
