// ============================================================
// qzone.js - QQ 空间自动说说（随机间隔 + 自评 + 回复评论）
//
// 依赖 SnowLuma 的 qzone 扩展动作：
//   send_qzone_msg / get_qzone_msg_list / comment_qzone
//
// 参数全部来自 config.json 的 qzone 段（网页「全局设置」可改，热加载生效）。
// 调度状态落盘到 data/qzone.json，重启不会重置下次发布时间。
// ============================================================
import path from 'path';
import { config, DEFAULTS } from './config.js';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import { logger } from './logger.js';
import { chatCompletionRaw, isAiEnabled } from './aiService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const RETRY_MS = 30 * MINUTE_MS;
const REPLY_COOLDOWN_MS = 60 * MINUTE_MS;
const MAX_POSTS = 30;
const AUTH_TTL_MS = 5 * MINUTE_MS;
const AUTH_ERROR_RETRY_MS = 6 * 60 * MINUTE_MS;
const QZONE_API = 'https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin';
const QZONE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const AUTH_ERROR_HINT = 'QQ 空间登录态失效（-3000）：请先用机器人 QQ 打开一次 QQ 空间，再重新发布';

let callApi = null;
let isReady = () => true;
let stateFile = '';
let state = emptyState();
let timer = null;
let busy = false;
let authCache = null;

function emptyState() {
  return {
    wasEnabled: false,
    nextAt: 0,
    lastPostAt: 0,
    sinceComment: 0,
    lastCheckAt: 0,
    lastError: '',
    posts: [],
  };
}

function clampNum(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v, def, min, max) {
  return Math.round(clampNum(v, def, min, max));
}

/** 把 config.json 的 qzone 段校正成可用参数（网页保存时也走这里） */
export function normalizeQzone(raw) {
  const def = DEFAULTS.qzone;
  const o = raw && typeof raw === 'object' ? raw : {};
  const pick = (k) => (k in o ? o[k] : def[k]);
  let minDays = clampNum(pick('minDays'), def.minDays, 1, 7);
  let maxDays = clampNum(pick('maxDays'), def.maxDays, 1, 7);
  if (minDays > maxDays) [minDays, maxDays] = [maxDays, minDays];
  const rights = [1, 4, 64];   // 16/128 需要额外指定部分好友，网页不做
  const right = Number(pick('ugcRight'));
  return {
    enabled: pick('enabled') !== false,
    minDays,
    maxDays,
    commentEvery: clampInt(pick('commentEvery'), def.commentEvery, 0, 10),
    replyComments: pick('replyComments') !== false,
    checkMinutes: clampInt(pick('checkMinutes'), def.checkMinutes, 5, 1440),
    ugcRight: rights.includes(right) ? right : def.ugcRight,
    maxLength: clampInt(pick('maxLength'), def.maxLength, 20, 500),
    stylePrompt: String(pick('stylePrompt') == null ? '' : pick('stylePrompt')).slice(0, 500),
  };
}

function qzConfig() {
  return normalizeQzone(config().qzone);
}

function parseCookieString(str) {
  const jar = {};
  for (const part of String(str || '').split(';')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    jar[s.slice(0, i)] = s.slice(i + 1);
  }
  return jar;
}

function bknFromSkey(skey) {
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) hash += (hash << 5) + skey.charCodeAt(i);
  return String(hash & 2147483647);
}

function isAuthError(message) {
  return /code=-3000|请先登录空间/.test(String(message || ''));
}

// 发布/评论必须用 user.qzone.qq.com 域的 cookie（里面带 qzone_check）。
// SnowLuma 的 send_qzone_msg / comment_qzone 用的是 qzone.qq.com 域，缺 qzone_check，会报 -3000。
async function qzoneAuth() {
  if (authCache && Date.now() - authCache.at < AUTH_TTL_MS) return authCache;
  if (!callApi) throw new Error('机器人未连接 SnowLuma');
  const cred = await callApi('get_credentials', { domain: 'user.qzone.qq.com' });
  const cookies = String((cred && cred.cookies) || '');
  const jar = parseCookieString(cookies);
  const skey = jar.p_skey || jar.skey || '';
  if (!cookies || !skey) throw new Error('拿不到 QQ 空间登录态（p_skey 为空）');
  const login = await callApi('get_login_info', {});
  const uin = String((login && login.user_id) || '');
  if (!uin) throw new Error('拿不到机器人 QQ 号');
  authCache = { cookies, gtk: bknFromSkey(skey), uin, at: Date.now() };
  return authCache;
}

async function qzoneCgi(cgi, params) {
  const auth = await qzoneAuth();
  const referer = `https://user.qzone.qq.com/${auth.uin}`;
  let res;
  try {
    res = await fetch(`${QZONE_API}/${cgi}?g_tk=${auth.gtk}`, {
      method: 'POST',
      headers: {
        Cookie: auth.cookies,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': QZONE_UA,
        Referer: referer,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw new Error(`QQ 空间请求失败：${e.message}`, { cause: e });
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (res.status === 403) throw new Error('QQ 空间触发风控（403 Forbidden），请过一会儿再试');
    throw new Error(`QQ 空间返回异常：${text.slice(0, 120)}`);
  }
  if (typeof data.code === 'number' && data.code !== 0) {
    if (data.code === -3000) authCache = null;
    throw new Error(`qzone ${cgi} failed: code=${data.code} ${data.message || data.msg || ''}`.trim());
  }
  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    throw new Error(`qzone ${cgi} failed: subcode=${data.subcode} ${data.message || data.msg || ''}`.trim());
  }
  return data;
}

async function publishViaQzone(content, ugcRight) {
  const auth = await qzoneAuth();
  const data = await qzoneCgi('emotion_cgi_publish_v6', {
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: '',
    richval: '',
    special_url: '',
    subrichtype: '',
    con: content,
    feedversion: '1',
    ver: '1',
    ugc_right: String(ugcRight),
    to_sign: '0',
    who: '1',
    hostuin: auth.uin,
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${auth.uin}`,
  });
  const tid = data.t1_tid || data.tid;
  if (!tid) throw new Error('发表说说失败：响应缺少 tid');
  return { tid: String(tid), time: Number(data.t1_time || data.now || 0) };
}

async function commentViaQzone(tid, content) {
  const auth = await qzoneAuth();
  const data = await qzoneCgi('emotion_cgi_re_feeds', {
    qzreferrer: `https://user.qzone.qq.com/${auth.uin}`,
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    hostUin: auth.uin,
    format: 'json',
    ref: 'feeds',
    topicId: `${auth.uin}_${tid}__1`,
    feedsType: '100',
    private: '0',
    paramstr: '1',
    richtype: '',
    richval: '',
    isSignIn: '',
    uin: auth.uin,
    content,
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
  });
  const id = data.commentid == null ? data.commentId : data.commentid;
  return { commentId: id == null ? '' : String(id) };
}

/** 在 [minDays, maxDays] 天之间随机取一个间隔（毫秒） */
export function randomDelayMs(minDays, maxDays, rand = Math.random) {
  const min = Math.min(minDays, maxDays) * DAY_MS;
  const max = Math.max(minDays, maxDays) * DAY_MS;
  return Math.round(min + Math.max(0, Math.min(1, rand())) * (max - min));
}

function save() {
  if (stateFile) writeJsonAtomic(stateFile, state);
}

function cleanAiText(text, maxLen) {
  let t = String(text == null ? '' : text).trim();
  t = t.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '').trim();
  t = t.replace(/^(说说|动态|评论)\s*[:：]\s*/, '').trim();
  if (maxLen && t.length > maxLen) t = t.slice(0, maxLen).trim();
  return t;
}

async function aiText(prompt, maxLen) {
  if (!isAiEnabled()) throw new Error('AI 未配置，无法生成内容');
  const r = await chatCompletionRaw({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    maxTokens: 400,
    userId: 'qzone-scheduler',
  });
  const text = cleanAiText(r && r.content, maxLen);
  if (!text) throw new Error('AI 返回了空内容');
  return text;
}

function recentTitles() {
  return state.posts.slice(0, 5).map((p) => p.content).filter(Boolean).join(' / ');
}

async function genPost(q) {
  const recent = recentTitles();
  const style = q.stylePrompt ? `风格要求：${q.stylePrompt}。` : '';
  const prompt = [
    '你是「小钠」，一个住在 QQ 里的可爱机器人女孩，正在发 QQ 空间说说。',
    `写 1~2 句日常说说，口语化、有生活感，不要提你是 AI 或机器人，不要解释，不要加引号，不超过 ${q.maxLength} 字。`,
    style,
    recent ? `最近发过：${recent}。不要重复这些内容或句式。` : '',
    '只输出说说正文。',
  ].filter(Boolean).join('\n');
  return aiText(prompt, q.maxLength);
}

async function genSelfComment(q, postContent) {
  const prompt = [
    '你刚在 QQ 空间发了这条说说：',
    `「${postContent}」`,
    '现在给自己补一条评论，像朋友接话一样补充一句，口语化，不要提你是机器人，不要加引号。只输出评论。',
  ].join('\n');
  return aiText(prompt, Math.min(q.maxLength, 80));
}

async function genReply(q, postContent, newCount) {
  const prompt = [
    '你在 QQ 空间发了这条说说：',
    `「${postContent}」`,
    `这条说说刚多了 ${newCount} 条评论。写一句友善的回应（感谢、接话或卖萌），1 句，口语化，不要提你是机器人，不要加引号。只输出评论。`,
  ].join('\n');
  return aiText(prompt, Math.min(q.maxLength, 80));
}

async function publishPost(q, now) {
  if (!callApi) throw new Error('机器人未连接 SnowLuma');
  const content = await genPost(q);
  const r = await publishViaQzone(content, q.ugcRight);
  const tid = String((r && r.tid) || '');
  if (!tid) throw new Error('发表说说成功但没拿到 tid');

  const post = { tid, content, time: now, knownComments: 0, lastReplyAt: 0 };
  state.posts.unshift(post);
  state.posts = state.posts.slice(0, MAX_POSTS);
  state.lastPostAt = now;
  state.nextAt = now + randomDelayMs(q.minDays, q.maxDays);
  state.lastError = '';
  state.sinceComment = Number(state.sinceComment || 0) + 1;

  // 每发 N 条，给自己最新这条留一条评论
  if (q.commentEvery > 0 && state.sinceComment >= q.commentEvery) {
    try {
      const c = await genSelfComment(q, content);
      await commentViaQzone(tid, c);
      post.knownComments += 1;
      state.sinceComment = 0;
    } catch (e) {
      logger.warn('[空间] 自评失败:', e.message);
    }
  }

  save();
  logger.info(`[空间] 已发说说：${content.slice(0, 60)}${content.length > 60 ? '…' : ''}（tid=${tid}）`);
  return { tid, content };
}

async function checkComments(q, now) {
  let r;
  try {
    r = await callApi('get_qzone_msg_list', { pos: 0, num: 30 });
  } catch (e) {
    state.lastCheckAt = now;
    state.lastError = e.message;
    save();
    logger.warn('[空间] 读取说说列表失败:', e.message);
    return;
  }
  const list = Array.isArray(r && r.msglist) ? r.msglist : [];
  const byTid = new Map(list.map((x) => [String(x && x.tid), x]));
  let replied = 0;
  for (const p of state.posts) {
    const item = byTid.get(String(p.tid));
    if (!item) continue;
    const n = Number(item.comment_num) || 0;
    if (n < p.knownComments) p.knownComments = n;
    const external = n - p.knownComments;
    if (external <= 0) continue;
    if (now - Number(p.lastReplyAt || 0) < REPLY_COOLDOWN_MS) continue;
    try {
      const text = await genReply(q, p.content, external);
      await commentViaQzone(p.tid, text);
      p.knownComments = n + 1;   // 自己这条回复也会 +1
      p.lastReplyAt = now;
      replied += 1;
    } catch (e) {
      logger.warn('[空间] 回复评论失败:', e.message);
    }
  }
  state.lastCheckAt = now;
  save();
  if (replied) logger.info(`[空间] 已在 ${replied} 条说说下回复评论`);
}

/** 初始化调度（由 index.js 传入 callApi / 存档目录 / 连接状态） */
export function initQzone(deps) {
  callApi = deps.callApi;
  if (typeof deps.isReady === 'function') isReady = deps.isReady;
  stateFile = path.join(deps.saveDir, 'qzone.json');
  const raw = readJsonSafe(stateFile, {}, 'qzone.json');
  state = {
    ...emptyState(),
    ...(raw && typeof raw === 'object' ? raw : {}),
    posts: Array.isArray(raw && raw.posts) ? raw.posts.slice(0, MAX_POSTS) : [],
  };
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick().catch((e) => logger.error('[空间] 调度出错:', e.message));
  }, MINUTE_MS);
  setTimeout(() => {
    tick().catch((e) => logger.error('[空间] 调度出错:', e.message));
  }, 15000);
}

export function stopQzone() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 每分钟检查一次：到期发说说、到点查评论 */
export async function tick(now = Date.now()) {
  const q = qzConfig();
  if (!callApi) return;
  if (!q.enabled) {
    if (state.wasEnabled) {
      state.wasEnabled = false;
      save();
    }
    return;
  }
  if (!state.wasEnabled) {
    state.wasEnabled = true;
    state.nextAt = now + randomDelayMs(q.minDays, q.maxDays);
    save();
    logger.info(`[空间] 自动说说已启用，下次发布在 ${new Date(state.nextAt).toLocaleString()} 左右`);
    return;
  }
  if (!isReady() || busy) return;

  busy = true;
  try {
    if (q.replyComments && state.posts.length
        && now - Number(state.lastCheckAt || 0) >= q.checkMinutes * MINUTE_MS) {
      await checkComments(q, now);
    }
    if (!state.nextAt) state.nextAt = now + randomDelayMs(q.minDays, q.maxDays);
    if (now >= state.nextAt) {
      try {
        await publishPost(q, now);
      } catch (e) {
        const authErr = isAuthError(e.message);
        state.lastError = authErr ? AUTH_ERROR_HINT : e.message;
        state.nextAt = now + (authErr ? AUTH_ERROR_RETRY_MS : RETRY_MS);
        save();
        if (authErr) logger.error('[空间] 发说说失败：', AUTH_ERROR_HINT);
        else logger.error('[空间] 发说说失败，30 分钟后再试:', e.message);
      }
    }
  } finally {
    busy = false;
  }
}

/** 网页「立即发一条」：跳过等待，立即生成并发布 */
export async function postQzoneNow() {
  if (busy) throw new Error('正在发布，请稍后再试');
  if (!callApi) throw new Error('机器人未连接 SnowLuma');
  if (!isReady()) throw new Error('机器人未连接 SnowLuma');
  const q = qzConfig();
  busy = true;
  try {
    const r = await publishPost(q, Date.now());
    return { ...r, nextAt: state.nextAt };
  } catch (e) {
    state.lastError = isAuthError(e.message) ? AUTH_ERROR_HINT : e.message;
    save();
    if (isAuthError(e.message)) throw new Error(AUTH_ERROR_HINT, { cause: e });
    throw e;
  } finally {
    busy = false;
  }
}

/** 网页展示用：当前参数 + 调度状态 */
export function qzoneStatus() {
  const q = qzConfig();
  return {
    enabled: q.enabled,
    minDays: q.minDays,
    maxDays: q.maxDays,
    commentEvery: q.commentEvery,
    replyComments: q.replyComments,
    checkMinutes: q.checkMinutes,
    ugcRight: q.ugcRight,
    maxLength: q.maxLength,
    nextAt: state.nextAt,
    lastPostAt: state.lastPostAt,
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    sinceComment: state.sinceComment,
    postCount: state.posts.length,
  };
}
