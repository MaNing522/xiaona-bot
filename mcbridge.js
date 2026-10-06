// ============================================================
// mcbridge.js - 与 Minecraft 服务器侧的"小钠桥 mod"通信
//
// 服务器侧 mod 在**与 Minecraft 相同的端口**上提供接口：
//   GET  /bridge/stream   SSE 事件流（游戏公聊 / 游戏内 /xn 私聊 / 进出服）
//   POST /bridge/send     把文本注入游戏（广播或私发给某玩家）
//   GET  /bridge/players  在线玩家 + 是否 OP
//   GET  /bridge/status   版本 / 玩家数 / 开关
//
// 认证：签名请求（密钥不上网），与 mod 的 BridgeAuth 对应：
//   X-Xiaona-Ts / X-Xiaona-Nonce / X-Xiaona-Sig = HMAC-SHA256(secret, ts + "\n" + nonce + "\n" + body)
//   注意：GET 的 body 必须是空串，不能传 null（否则签名会算成 "null"）
// ============================================================
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import { logger } from './logger.js';

// 配置在 startMcBridge() 时从 process.env 读取。
// 不能写在模块顶层：ESM 的 import 会先于 index.js 里的 dotenv.config() 执行，那时 env 还是空的。
let cfg = null;
let deps = null;
let stopped = false;
let lastEventId = 0;
let connected = false;
/** 服务端序号被重置（服务器重启过）→ 丢掉旧光标，断开重连 */
let needResync = false;
let playersCache = { at: 0, list: [] };
let warnedOldMod = false;
let warnedNoBindCheck = false;
let warnedNoWhitelist = false;
/** 玩家 → { start, count, warned }：游戏公聊 → QQ 的限速窗口 */
const chatRate = new Map();
/** 限速状态表上限，防止长期运行时随人数一路涨 */
const CHAT_RATE_MAP_MAX = 500;
/** "玩家+内容" → { count, lastAt, warned }：同一句话反复刷的计数 */
const dupSeen = new Map();
const DUP_MAP_MAX = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读整型环境变量：留空/非法 → 用默认值；显式写 0 保留（表示关闭该项） */
function intEnv(name, dflt) {
    const raw = (process.env[name] || '').trim();
    if (!raw) return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** 状态表封顶：先清已过期的，仍满就丢最早写入的（Map 保持插入顺序） */
function capMap(map, max, isExpired) {
    if (map.size < max) return;
    for (const [k, v] of map) if (isExpired(v)) map.delete(k);
    while (map.size >= max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

function readConfig() {
    const base = (process.env.MC_BRIDGE_URL || '').trim().replace(/\/+$/, '');
    return {
        base,
        secret: (process.env.MC_BRIDGE_SECRET || '').trim(),
        groupId: Number(process.env.MC_BRIDGE_GROUP || 0),
        mcToQq: (process.env.MC_BRIDGE_MC_TO_QQ || 'true') !== 'false',
        qqToMc: (process.env.MC_BRIDGE_QQ_TO_MC || 'true') !== 'false',
        opRelay: (process.env.MC_BRIDGE_OP_RELAY || 'true') !== 'false',
        gameImage: (process.env.MC_BRIDGE_GAME_IMAGE || 'true') !== 'false', // 游戏内贴的图片代码 → QQ 真图
        from: (process.env.MC_BRIDGE_FROM || '').trim(), // 经端口复用时用于 IP 白名单
        prefixMc: process.env.MC_BRIDGE_PREFIX_MC || '[MC]',
        prefixQq: process.env.MC_BRIDGE_PREFIX_QQ || '[QQ]',
        keyword: process.env.MC_BRIDGE_KEYWORD || '小钠',
        // 游戏公聊 → QQ 的限速：同一玩家每窗口最多转发几条（0 = 不限）
        chatRateMax: intEnv('MC_BRIDGE_CHAT_RATE_MAX', 8),
        chatRateWindowMs: intEnv('MC_BRIDGE_CHAT_RATE_WINDOW_SEC', 10) * 1000,
        // 同一句话反复刷：同一玩家同一内容最多转发几条（0 = 不限）
        dupMax: intEnv('MC_BRIDGE_DUP_MAX', 3),
        dupTtlMs: intEnv('MC_BRIDGE_DUP_TTL_SEC', 300) * 1000,
    };
}

// ---------- 签名 ----------
// 导出仅为单测签名串格式（生产路径由 api()/事件流调用）
export function signedHeaders(bodyStr) {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.createHmac('sha256', cfg.secret)
        .update(`${ts}\n${nonce}\n${bodyStr == null ? '' : bodyStr}`)
        .digest('hex');
    const h = { 'X-Xiaona-Ts': ts, 'X-Xiaona-Nonce': nonce, 'X-Xiaona-Sig': sig };
    if (cfg.from) h['X-Xiaona-From'] = cfg.from; // 端口复用下服务端只看到 127.0.0.1，用它做 IP 白名单
    return h;
}

/** 带签名的请求；失败抛出带原因的错误 */
export async function api(path, { method = 'GET', body = null, timeoutMs = 15000 } = {}) {
    if (!cfg) throw new Error('MC 桥未启动');
    const bodyStr = method === 'GET' || body == null
        ? ''
        : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = signedHeaders(bodyStr);
    if (bodyStr) headers['Content-Type'] = 'application/json';
    const res = await fetch(cfg.base + path, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(json && json.error) || text.slice(0, 120)}`);
    return json;
}

// ---------- 对外能力 ----------
/**
 * 把文本注入游戏。
 * target 省略 = 全服广播；
 * target.player = 单个玩家；target.players = 一批玩家（一次请求投递，用于群消息转发）
 */
export async function sendToMc(text, target) {
    if (!cfg || !cfg.base) return { ok: false, error: 'MC 桥未配置' };
    if (!text || !String(text).trim()) return { ok: false, error: '文本为空' };
    const body = { text: String(text) };
    if (target && Array.isArray(target.players) && target.players.length) {
        body.target = 'players';
        body.players = target.players.map(String);
        if (target.prefix) body.prefix = target.prefix;
    } else if (target && target.player) {
        body.target = 'player';
        body.player = String(target.player);
        if (target.prefix) body.prefix = target.prefix;
    } else {
        body.target = 'all';
        if (target && target.prefix) body.prefix = target.prefix;
    }
    try {
        const r = await api('/bridge/send', { method: 'POST', body });
        // 旧版 mod（<2.2.0）不认识 players，会退化成全服广播 —— 必须提醒，否则等于把消息发给所有人
        if (body.target === 'players' && r && r.delivered === undefined && !warnedOldMod) {
            warnedOldMod = true;
            logger.error('[MC桥] 服务器 mod 未返回 delivered（疑似旧版本 <2.2.0）：群消息可能被当广播发给全服，请升级 mod。');
        }
        return r;
    } catch (e) {
        logger.error('[MC桥] 注入失败:', e.message);
        return { ok: false, error: e.message };
    }
}

export async function getBridgeStatus() {
    return api('/bridge/status');
}

/**
 * 取某个玩家的 Plan 数据（玩家分析插件）。
 * Plan 面板端口（默认 8804）通常不对外开放，所以由服务器侧的 mod 在本机代取，
 * 这里只需要拿到它整理好的 JSON；取不到会抛错，错误原因由 mod 给出（面板没跑/要登录/没这个玩家）。
 */
export async function getPlanPlayer(name) {
    const r = await api('/bridge/player', { method: 'POST', body: { name: String(name) } });
    if (!r || r.ok !== true) {
        const err = String((r && r.error) || '服务器没有返回玩家数据');
        // Plan 查不到人时回 400 + "was not found in the database"。
        // 这是最常见的"名字打错了 / 没进过服"，别把一坨原始 JSON 甩给用户看。
        if (/not found in the database|HTTP 400/i.test(err)) {
            throw new Error(`没有找到玩家「${name}」（可能名字输错，或他没进过服、数据还没生成）`);
        }
        throw new Error(err);
    }
    // 老玩家（会话多）的原始数据能到几百 KB，服务端会先把用不上的分布数组裁掉再带回来
    if (r.trimmed) {
        logger.info(`[MC桥] ${name} 的 Plan 数据已裁剪：${r.rawSize} → ${JSON.stringify(r.player || {}).length} 字符`);
    }
    return r.player;
}

/**
 * 把"这名玩家是否已绑定"回给服务端 mod，让它据此显示/撤掉计分板。
 *
 * 两个调用点：
 *   1. 玩家**上线**时（mod 的 join 事件带玩家名）；
 *   2. **绑定关系变化**时（QQ 侧 #绑定 / #解绑）——人可能正在游戏里，
 *      绑定成功要立刻把板子撤掉，解绑了要重新挂上。
 *
 * 判定每次都按当前绑定表现算，所以解绑后"这个ID 是否还有别人绑着"也是准的。
 */
export async function bindCheck(name) {
    if (!cfg || !cfg.base || !name) return;
    const ids = (deps && typeof deps.getBoundIds === 'function') ? (deps.getBoundIds() || []) : [];
    const who = String(name).toLowerCase();
    const bound = ids.some((id) => String(id).toLowerCase() === who);
    const body = { player: String(name), bound, group: cfg.groupId ? String(cfg.groupId) : '' };
    try {
        await api('/bridge/bindcheck', { method: 'POST', body, timeoutMs: 8000 });
    } catch (e) {
        if (!warnedNoBindCheck && /HTTP 404/.test(e.message)) {
            warnedNoBindCheck = true;
            logger.error('[MC桥] 服务端 mod 不认识 /bridge/bindcheck（版本过旧）：未绑定玩家的计分板不会随绑定状态刷新，请升级 mod。');
        }
    }
}

/**
 * 把"谁绑定了游戏ID"推给服务端，供白名单模式判定（见 mod 的 /bridge/whitelist）。
 *
 * 服务端是"桥的宿主"、本机是客户端 —— 服务端没法反向问本机，所以由本机主动推：
 * 单人变更（绑定/解绑时）用 {@link pushWhitelist}，连上桥时用 {@link pushWhitelistAll} 推整张名单。
 * 旧版 mod 不认识该接口会回 404，只在第一次提醒升级。
 */
export async function pushWhitelist(name, bound) {
    if (!cfg || !cfg.base || !name) return;
    try {
        await api('/bridge/whitelist', {
            method: 'POST',
            body: { player: String(name), bound: !!bound },
            timeoutMs: 8000,
        });
    } catch (e) {
        warnNoWhitelist(e);
    }
}

/** 推整张绑定名单（连接上桥时调用；服务端据此全量替换缓存） */
export async function pushWhitelistAll() {
    if (!cfg || !cfg.base) return;
    const ids = (deps && typeof deps.getBoundIds === 'function') ? (deps.getBoundIds() || []) : [];
    try {
        await api('/bridge/whitelist', { method: 'POST', body: { players: ids.map(String) }, timeoutMs: 8000 });
    } catch (e) {
        warnNoWhitelist(e);
    }
}

function warnNoWhitelist(e) {
    if (warnedNoWhitelist) return;
    logger.error(
        `[MC桥] 推送绑定名单失败：${e.message}。`
        + `白名单模式需要 mod ≥ 2.5.6 的 /bridge/whitelist 接口，若为 404 请升级 mod。`,
    );
    warnedNoWhitelist = true;
}

/** 在线玩家（带 10 秒缓存） */
export async function getPlayers(force = false) {
    if (!force && Date.now() - playersCache.at < 10000) return playersCache.list;
    const r = await api('/bridge/players');
    playersCache = { at: Date.now(), list: (r && r.players) || [] };
    return playersCache.list;
}

export async function getOnlineOps() {
    try {
        return (await getPlayers()).filter((p) => p.op).map((p) => p.name);
    } catch {
        return [];
    }
}

export function isMcConnected() { return connected; }

// ---------- 事件流 ----------
function handleSseBlock(block) {
    let event = 'message';
    let data = null;
    for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue; // 心跳等注释行
        const i = line.indexOf(':');
        if (i < 0) continue;
        const field = line.slice(0, i);
        let v = line.slice(i + 1);
        if (v.startsWith(' ')) v = v.slice(1);
        if (field === 'event') event = v;
        else if (field === 'data') data = v;
        else if (field === 'id') {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) lastEventId = n;
        }
    }

    if (event === 'hello') {
        logger.info('[MC桥] 握手完成:', data || '');
        // 服务端的序号是"本次运行"的，服务器一重启就从 1 重来；而我们的光标还停在上一轮。
        // 若继续带着它，服务端会以为"你已经看到最新了"，于是连着却一条事件都不推。
        let hs = null;
        try { hs = JSON.parse(data); } catch { /* 老版本 mod 没有 lastSeq */ }
        if (hs && Number.isFinite(hs.lastSeq) && lastEventId > hs.lastSeq) {
            logger.warn(`[MC桥] 服务端序号已重置（本地光标 ${lastEventId} > 服务端 ${hs.lastSeq}），丢弃旧光标重新对齐。`);
            lastEventId = 0;
            needResync = true;   // 由 streamLoop 断开本条连接后重连（不带光标）
        }
        // 连上后推整张绑定名单：白名单模式靠它把门（计分板仍由玩家上线时逐人回 bindCheck 驱动）
        pushWhitelistAll().catch(() => {});
        return;
    }
    if (event === 'gap') {
        logger.warn('[MC桥] 中间有事件被丢弃（断线太久），已按最新事件继续');
        return;
    }
    if (!data) return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev.seq) lastEventId = ev.seq;
    onEvent(ev).catch((e) => logger.error('[MC桥] 事件处理失败:', e.message));
}

/**
 * 公聊放行总闸：先查"同一句话反复刷"，再查"单玩家刷屏频次"，两道都过才转发到 QQ。
 * 任一道拦下都算**整条丢弃** —— 不转发、不解析图片、也不喂给 AI。
 * 只作用于公聊 chat：进出服不参与统计（也不算重复），/xn 私聊、死亡/成就不走这里。
 */
function allowChatToQq(name, text) {
    // 丢弃要留痕：不然群里少一句话，没人知道是限速丢了还是桥断了
    if (dupBlocked(name, text)) {
        logger.info(`[MC桥] 丢弃（重复刷屏）：${name} 的「${clip(text)}」`);
        return false;
    }
    if (rateBlocked(name)) {
        logger.info(`[MC桥] 丢弃（发言过快）：${name} 的「${clip(text)}」`);
        return false;
    }
    return true;
}

/** 日志里预览用：压成一行短文本 */
function clip(text, max = 24) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * 同一玩家把同一句话反复刷？
 *
 * 计数按"玩家 + 内容"记，**退服/进服不清零**（不然退了再进来就又能刷一轮），
 * 只在超过 dupTtlMs 没再出现时重新算，避免"哈哈"这种口头禅被永久拉黑。
 * 超出 dupMax 次起整条丢弃，并在该次刷屏里只提示一次。
 */
function dupBlocked(name, text) {
    if (!cfg.dupMax || !cfg.dupTtlMs) return false;
    const now = Date.now();
    const key = name + '\n' + String(text || '').replace(/\s+/g, ' ').trim();
    let e = dupSeen.get(key);
    if (e && now - e.lastAt >= cfg.dupTtlMs) { dupSeen.delete(key); e = null; }

    if (!e) {
        capMap(dupSeen, DUP_MAP_MAX, (v) => now - v.lastAt >= cfg.dupTtlMs);
        e = { count: 0, lastAt: now, warned: false };
        dupSeen.set(key, e);
    }
    e.lastAt = now;
    e.count += 1;
    if (e.count <= cfg.dupMax) return false;

    if (!e.warned) {
        e.warned = true;
        logger.warn(`[MC桥] ${name} 反复刷同一句话（第 ${e.count} 次），已屏蔽重复内容。`);
        toBridgeGroup(`${cfg.prefixMc} ⚠️ ${name} 重复刷同一句话，已暂时屏蔽`).catch(() => {});
    }
    return true;
}

/**
 * 单玩家公聊频次限速：滑动窗口内超过 chatRateMax 条就整条丢弃。
 *
 * 游戏里刷屏会原样灌进 QQ 群，还可能把 QQ 的发送频率限制顶到（伤账号）。
 * 丢弃时在本窗口内只提示一次，不做静默丢弃（群里看不到消息却不知道为什么，最容易被当成桥坏了）。
 */
function rateBlocked(name) {
    if (!cfg.chatRateMax || !cfg.chatRateWindowMs) return false;   // 任一项为 0 = 不限速
    const now = Date.now();
    let e = chatRate.get(name);
    if (!e || now - e.start >= cfg.chatRateWindowMs) {
        capMap(chatRate, CHAT_RATE_MAP_MAX, (v) => now - v.start >= cfg.chatRateWindowMs);
        e = { start: now, count: 0, warned: false };
        chatRate.set(name, e);
    }
    e.count += 1;
    if (e.count <= cfg.chatRateMax) return false;

    if (!e.warned) {
        e.warned = true;
        const sec = Math.round(cfg.chatRateWindowMs / 1000);
        logger.warn(`[MC桥] ${name} 公聊触发限速（每 ${sec} 秒最多 ${cfg.chatRateMax} 条），本窗口内不再转发到 QQ。`);
        toBridgeGroup(`${cfg.prefixMc} ⚠️ ${name} 发言过快，其游戏消息已暂时屏蔽`).catch(() => {});
    }
    return true;
}

/** 玩家 → { name, ip, events:[{type,at,ip}] }：最近 5 次上下线（含登录 IP），供主人私聊 #查询 用 */
const joinHistory = new Map();
const JOIN_HISTORY_MAX = 5;
const JOIN_HISTORY_PLAYERS = 500;
/** 落盘位置：data/presence.json（由 initPresence 传入；为空则只在内存里记） */
let presenceFile = '';

/**
 * 加载上次运行留下的上下线记录（机器人重启不丢）。
 * 结构：{ players: { "<小写名>": { name, ip, events:[{type,at,ip}] } } }
 */
export function initPresence(saveDir) {
    presenceFile = path.join(saveDir, 'presence.json');
    const j = readJsonSafe(presenceFile, null, 'presence.json');
    const players = j && j.players && typeof j.players === 'object' ? j.players : {};
    joinHistory.clear();
    for (const key of Object.keys(players).slice(-JOIN_HISTORY_PLAYERS)) {
        const e = players[key];
        if (!e || !Array.isArray(e.events)) continue;
        joinHistory.set(key, {
            name: String(e.name || key),
            ip: String(e.ip || ''),
            events: e.events.slice(-JOIN_HISTORY_MAX),
        });
    }
    logger.info(`[MC桥] 已加载 ${joinHistory.size} 名玩家的上下线记录`);
}

/** 整表落盘（原子写，避免半截文件） */
function savePresence() {
    if (!presenceFile) return;
    const players = {};
    for (const [k, v] of joinHistory) players[k] = v;
    writeJsonAtomic(presenceFile, { players });
}

function recordPresence(type, name, ip) {
    const key = String(name || '').toLowerCase();
    if (!key) return;
    let e = joinHistory.get(key);
    if (!e) {
        if (joinHistory.size >= JOIN_HISTORY_PLAYERS) {
            const oldest = joinHistory.keys().next().value;
            if (oldest !== undefined) joinHistory.delete(oldest);
        }
        e = { name: String(name), ip: '', events: [] };
        joinHistory.set(key, e);
    }
    if (ip) e.ip = ip;   // 只有 join 带 IP，取最近一次
    e.events.push({ type, at: Date.now(), ip: ip || '' });
    if (e.events.length > JOIN_HISTORY_MAX) e.events.splice(0, e.events.length - JOIN_HISTORY_MAX);
    savePresence();
}

/** 取某玩家的上下线记录（最近 5 次）与最近一次登录 IP；没有记录返回 null */
export function getPlayerHistory(name) {
    return joinHistory.get(String(name || '').toLowerCase()) || null;
}

async function onEvent(ev) {
    const who = ev.player || '?';
    if (ev.type === 'join' || ev.type === 'leave') {
        if (ev.player) recordPresence(ev.type, ev.player, ev.ip);
        // 端口复用下 MC 只看到 127.0.0.1，mod 已用端口映射还原出真实客户端 IP，这里只记到控制台
        if (ev.type === 'join' && ev.ip) logger.info(`[MC桥] ${who} 真实客户端 IP: ${ev.ip}`);
        // 上线才查一次绑定，把答案单独回给 mod（mod 只为这名玩家渲染计分板）
        if (ev.type === 'join' && ev.player) await bindCheck(ev.player);
        await toBridgeGroup(`${cfg.prefixMc} ${who} ${ev.type === 'join' ? '加入了服务器' : '离开了服务器'}`);
        return;
    }

    // 死亡消息 / 成就播报：文本已是完整句子（含玩家名），直接整条转发
    if (ev.type === 'death' || ev.type === 'advancement') {
        const tag = ev.type === 'death' ? '💀' : '🏆';
        await toBridgeGroup(`${cfg.prefixMc} ${tag} ${ev.text}`);
        return;
    }

    if (ev.type === 'private') {
        // 游戏内 /xn：交给本机 AI，仅回给提问者
        // 「记录」只记私聊（问题 + 小钠的回答）—— 其余事件一律不投递给 OP；
        // 提问者自己若也是 OP，则不再把记录回发给他（他刚看过回复，纯属重复）
        await relayToOps(`游戏私聊 ${who}: ${ev.text}`, who);
        // #开头 = 指令：先跑指令系统，命中了就不走 AI
        const cmd = await runGameCommand({ player: who, text: ev.text, isPrivate: true });
        const reply = cmd !== null
            ? (cmd || '（这条指令没有输出）')
            : ((await askAi({ player: who, text: ev.text, isPrivate: true }))
                || '小钠暂时答不上来，稍后再试。');
        await relayToOps(`小钠 → ${who}: ${reply}`, who);
        const r = await sendToMc(reply, { player: who, prefix: '[小钠] ' });
        if (!r.ok) logger.error(`[MC桥] 回复给 ${who} 失败:`, r.error);
        return;
    }

    // 公聊
    // 先过一道总闸：反复刷同一句话、以及单玩家刷屏频次，都会在这里被丢掉
    if (!allowChatToQq(who, ev.text)) return;

    // 玩家可能贴了图片代码（客户端 ChatImage 类模组产生）：抠出图片，发成 QQ 真图
    const pics = cfg.gameImage ? imageUrlsIn(ev.text) : [];
    const said = pics.length ? stripImageCodes(ev.text) : ev.text;
    if (said) await toBridgeGroup(`${cfg.prefixMc} ${who}: ${said}`);
    for (const u of pics) {
        const src = imageSourceOf(u);
        if (src) await toBridgeGroupImage(src);
    }

    // #开头 = 指令：执行后**只回给提问者**（公聊里挂一屏菜单会把服务器刷爆）。
    // 放在转发之后：指令本身也留在群里，方便留痕。
    // 只处理真正的玩家发言——小钠注入游戏的消息走 broadcast，不会回到这里，
    // 所以不存在"自己发的话被当成命令再执行一遍"。
    const cmd = await runGameCommand({ player: who, text: ev.text, isPrivate: false });
    if (cmd !== null) {
        const out = cmd || '（这条指令没有输出）';
        const cr = await sendToMc(out, { player: who, prefix: '[小钠] ' });
        if (!cr.ok) logger.error(`[MC桥] 指令回复给 ${who} 失败:`, cr.error);
        return;
    }

    if (!cfg.keyword || !String(ev.text || '').includes(cfg.keyword)) return;
    const reply = await askAi({ player: who, text: ev.text, isPrivate: false });
    if (!reply) return;
    await sendToMc(reply, { prefix: '[小钠] ' });
    await toBridgeGroup(`[小钠] @${who}: ${reply}`);
}

// ---------- 游戏内贴的图片 → QQ 真图 ----------
/**
 * 玩家在游戏聊天里贴图片，靠的是客户端 ChatImage 类模组把图片变成"图片代码"，
 * 对服务端来说那依旧是一段普通文本。这里把代码里的图片地址抠出来，
 * 再以图片形式发到 QQ 群；文本里的代码会被去掉，免得刷屏。
 *
 * 支持两种写法：
 *   kitUIN ChatImage : [[CICode,url=<地址>,name=<名字>]]
 *   ChatImages(Forge): CI{"information":"...","url":"<地址>","w":1,"h":1}
 */
const MAX_GAME_IMAGES = 5;
const IMAGE_CODE_RE = /\[\[CICode,[^\]]{1,600}\]\]|CI\{[^}]{1,600}\}/gi;
// 玩家直接把图片地址粘进聊天栏（不需要任何客户端模组）。
// 只认 URL 合法字符，避免把后面的 ]] 或中文标点（地址后直接跟中文时没有空格）一起吞进来
const BARE_IMAGE_RE = /https?:\/\/[A-Za-z0-9._~:/?#@!$&*+;=%-]+?\.(?:png|jpe?g|gif|webp|bmp|jfif)(?:\?[A-Za-z0-9._~:/?#@!$&*+;=%-]*)?/gi;

function imageUrlsIn(text) {
    const urls = [];
    const add = (u) => {
        const v = String(u || '').trim();
        if (v && !urls.includes(v)) urls.push(v);
    };
    for (const m of String(text || '').matchAll(IMAGE_CODE_RE)) {
        const code = m[0];
        const ci = code.match(/(?:^|,)\s*url\s*=\s*([^,\]]+)/i);       // CICode 的 url=xxx
        if (ci) { add(ci[1]); continue; }
        const json = code.match(/"url"\s*:\s*"([^"]+)"/i);              // CI{...} 的 "url":"xxx"
        if (json) add(json[1]);
    }
    for (const m of String(text || '').matchAll(BARE_IMAGE_RE)) add(m[0]);
    return urls.slice(0, MAX_GAME_IMAGES);
}

/** 去掉图片代码，只留人话（一个图都没取到时调用方不会用它） */
function stripImageCodes(text) {
    return String(text || '').replace(IMAGE_CODE_RE, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 把游戏里的图片地址变成 QQ 能发的形式。
 * - http(s)：直接把地址交给 NapCat 去取（唯一对所有人通用的形式）
 * - data:image/...;base64,xxx：转成 NapCat 的 base64://
 * - file:/// 或裸路径：只有当本机机器人恰好也在那台机器上（自己在本地玩）才读得到，
 *   读不到就返回空，由调用方跳过（不会把转发搞挂）
 */
function imageSourceOf(url) {
    const u = String(url || '').trim();
    if (/^https?:\/\//i.test(u)) return u;
    const data = u.match(/^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i);
    if (data) return 'base64://' + data[1].replace(/\s+/g, '');
    const p = u.replace(/^file:\/\/\/?/i, '');
    if (!p) return '';
    try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            const buf = fs.readFileSync(p);
            if (buf.length > 8 * 1024 * 1024) {
                logger.error('[MC桥] 图片过大，已跳过:', p);
                return '';
            }
            return 'base64://' + buf.toString('base64');
        }
    } catch (e) {
        logger.error('[MC桥] 读取本地图片失败:', e.message);
    }
    logger.error('[MC桥] 图片地址取不到（非本机文件？）已跳过:', u);
    return '';
}

async function toBridgeGroupImage(src) {
    if (!cfg.mcToQq || !cfg.groupId || !src) return;
    try {
        await deps.callApi('send_group_msg', { group_id: cfg.groupId, message: [{ type: 'image', data: { file: src } }] });
    } catch (e) {
        logger.error('[MC桥] 图片发送到桥接群失败:', e.message);
    }
}

async function toBridgeGroup(text) {
    if (!cfg.mcToQq || !cfg.groupId) return;
    try {
        await deps.callApi('send_group_msg', { group_id: cfg.groupId, message: [deps.segText(text)] });
    } catch (e) {
        logger.error('[MC桥] 发送到桥接群失败:', e.message);
    }
}

/**
 * 把游戏内 /xn 私聊记录私发给在线 OP（其余事件不记录）。
 * @param {string} [exclude] 提问者名字：他自己也是 OP 时不再回发给他
 */
async function relayToOps(line, exclude) {
    if (!cfg.opRelay) return;
    try {
        const skip = exclude ? String(exclude).toLowerCase() : '';
        const ops = await getOnlineOps();
        for (const name of ops) {
            if (skip && String(name).toLowerCase() === skip) continue;
            await sendToMc(line, { player: name, prefix: '[记录] ' });
        }
    } catch (e) {
        logger.error('[MC桥] OP 转发失败:', e.message);
    }
}

async function askAi(payload) {
    if (!deps || typeof deps.askAi !== 'function') return null;
    try {
        return await deps.askAi(payload);
    } catch (e) {
        logger.error('[MC桥] AI 调用失败:', e.message);
        return null;
    }
}

/**
 * 游戏内玩家发的 #命令，交给本机指令系统执行。
 * @returns {Promise<string|null>} null = 不是指令（调用方继续走 AI）
 */
async function runGameCommand(payload) {
    if (!deps || typeof deps.runGameCommand !== 'function') return null;
    try {
        return await deps.runGameCommand(payload);
    } catch (e) {
        logger.error('[MC桥] 游戏内指令执行失败:', e.message);
        return null;
    }
}

async function streamLoop() {
    while (!stopped) {
        const ctl = new AbortController();
        try {
            const headers = { ...signedHeaders(''), Accept: 'text/event-stream' };
            if (lastEventId > 0) headers['Last-Event-ID'] = String(lastEventId);
            const res = await fetch(cfg.base + '/bridge/stream', { headers, signal: ctl.signal });
            if (!res.ok) {
                const t = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status} ${t.slice(0, 140)}`);
            }
            connected = true;
            logger.info('[MC桥] 已连接服务器事件流:', cfg.base);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (!stopped) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    handleSseBlock(block);
                }
                if (needResync) {
                    // 主动掐断这条连接，别让它挂在服务端白占一个流名额
                    needResync = false;
                    ctl.abort();
                    throw new Error('服务端序号已重置，重新对齐');
                }
            }
            throw new Error('事件流已结束');
        } catch (e) {
            connected = false;
            if (stopped) return;
            logger.error('[MC桥] 连接中断:', e.message, '→ 3 秒后重连');
            await sleep(3000);
        }
    }
}

// ---------- 启动 / 停止 ----------
/**
 * 启动桥客户端。
 * @param {object} d 依赖注入：
 *   callApi(action, params) -> Promise   OneBot 调用
 *   segText(text) -> segment             文本消息段
 *   askAi({player, text, isPrivate}) -> Promise<string|null>   小钠的回复
 */
export function startMcBridge(d) {
    deps = d || {};
    cfg = readConfig();

    if (!cfg.base || !cfg.secret) {
        logger.info('[MC桥] 未配置 MC_BRIDGE_URL / MC_BRIDGE_SECRET，跳过（游戏内小钠不可用）。');
        return false;
    }
    if (cfg.secret.length < 32) {
        logger.error('[MC桥] MC_BRIDGE_SECRET 短于 32 个字符，服务端会拒绝；请与 config.json 的 bridge.secret 保持一致。');
        return false;
    }

    stopped = false;
    logger.info(`[MC桥] 启动：${cfg.base}${cfg.groupId ? ` 桥接群 ${cfg.groupId}` : '（未配置桥接群，游戏消息不会发到 QQ）'}`);
    streamLoop();
    return true;
}

export function stopMcBridge() {
    stopped = true;
    connected = false;
}

/** 从游戏内事件转发到 QQ 群（供外部复用） */
export function forwardToBridgeGroup(text) {
    return toBridgeGroup(text);
}