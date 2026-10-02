// ============================================================
// index.js - 小钠 QQ机器人（真实QQ账号 · NapCat OneBot11）
// AI 决策(联网搜索 + 语音) + 截图指令
// ============================================================
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { textToSpeech, cleanVoiceCache } from './tts.js';
import { getSearchContext } from './search.js';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import * as perm from './permission.js';
import { queryServer, formatServer } from './mc.js';
import { startWebUI, setOwnerNotifier } from './webui.js';
import { bot, setBotConnected, setBotError, pushLog, takeover, pushTakeoverMsg, takeoverOn, setSendMsg, setTakeoverMode } from './state.js';
import { handleScheduler, initScheduler } from './scheduler.js';
import { initMemory, addMemory, listMemory, removeMemory, clearMemory, memoryContext, recordMessage, searchMemory } from './memory.js';
import { captureScreen, captureUrl, cropSquare } from './screenshot.js';
import { buildHelp } from './help.js';
import crypto from 'crypto';
import { startMcBridge, sendToMc, getBridgeStatus, getPlayers, isMcConnected, getPlanPlayer, getPlayerHistory, initPresence } from './mcbridge.js';
import { nextShakeLine } from './shake.js';
import { initBindings, startBind, answerCaptcha, unbind as unbindGame, listOf as listBindings, getReceivers, maxPerQQ, forceUnbind } from './binding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 显式指定 .env 路径，避免受启动目录影响
dotenv.config({ path: path.join(__dirname, '.env') });

// 挂钩 console：终端输出同步进共享日志，供 WebUI 实时展示（与终端一致）
const _log = console.log;
const _err = console.error;

/**
 * 终端字体（Consolas/宋体这类等宽字体）基本没有 emoji 和部分符号的字形，
 * 直接输出会被画成空白或豆腐块 —— 看起来就是"没显示出来"。
 * 这里把连续的一串换成 [表情]，保证终端里一定看得到东西；
 * WebUI 日志仍保留原文（浏览器自己有 emoji 字体回退，能正常渲染）。
 * 注意别把箭头/几何图形/带圈数字也吞掉：那些在中文字体里是能正常显示的。
 */
const TERM_UNSAFE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{200D}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]+/gu;
function termSafe(v) {
    return typeof v === 'string' ? v.replace(TERM_UNSAFE, '[表情]') : v;
}

console.log = (...a) => { _log(...a.map(termSafe)); try { pushLog(a.map(String).join(' ')); } catch {} };
console.error = (...a) => { _err(...a.map(termSafe)); try { pushLog('❌ ' + a.map(String).join(' ')); } catch {} };

/**
 * 写入带过期的缓存，并在写之前封顶：先清已过期的，仍满就丢最早写入的（Map 保持插入顺序）。
 * 长期运行的进程里，缓存一定要有上限，否则会随使用人数一路涨。
 */
function cacheSet(map, key, max, val) {
    if (map.size >= max) {
        const now = Date.now();
        for (const [k, v] of map) if (v && v.exp && now > v.exp) map.delete(k);
        while (map.size >= max) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
        }
    }
    map.set(key, val);
}

const WS_URL = process.env.NAPCAT_WS || 'ws://127.0.0.1:3001';
const WS_TOKEN = process.env.NAPCAT_TOKEN || '';
const SAVE_DIR = process.env.SAVE_DIR || path.join(__dirname, 'data');
// MC 桥（服务器侧 mod）：桥接群号，以及是否把群消息转发进游戏
const MC_BRIDGE_GROUP = String(process.env.MC_BRIDGE_GROUP || '');
// 图片/表情转发进游戏：只发文字占位（游戏里要显示真图得靠客户端模组，已决定不做）
const MC_BRIDGE_QQ_TO_MC = (process.env.MC_BRIDGE_QQ_TO_MC || 'true') !== 'false';
// 进群 / 退群提示（在群里发欢迎/送别消息）
const QQ_GROUP_NOTICE = (process.env.QQ_GROUP_NOTICE || 'true') !== 'false';
// 机器人发来的消息要不要接话（默认不接：两个机器人互刷没意义，也容易被判刷屏）
const BOT_REPLY = (process.env.BOT_REPLY || 'false') === 'true';
// 进群申请 / 好友申请：转给主人，由主人引用通知回复"同意 / 拒绝"
const QQ_REQUEST_APPROVE = (process.env.QQ_REQUEST_APPROVE || 'true') !== 'false';

// ---------- 配置自检：没配的功能直接停用（不报错、也不半死不活） ----------
const AI_ENABLED = !!String(process.env.AI_API_KEY || '').trim();
const SEARCH_ENABLED = !!String(process.env.BAIDU_SEARCH_KEY || '').trim();
const WEBUI_ENABLED = !!String(process.env.WEBUI_PASSWORD || '').trim();
const MC_ENABLED = !!String(process.env.MC_BRIDGE_URL || '').trim()
    && !!String(process.env.MC_BRIDGE_SECRET || '').trim();
const OWNER_ENABLED = !!String(process.env.BOT_OWNER || '').trim();

function logFeatureStates() {
    // 不用 emoji：终端会把它们替换成 [表情]，反而看不出开关状态
    const on = (b) => (b ? '[已启用]' : '[已停用]');
    console.log('=== 功能状态（.env 里缺配置的会自动停用）===');
    console.log(`   AI 对话        ${on(AI_ENABLED)}${AI_ENABLED ? '' : '  缺 AI_API_KEY'}`);
    console.log(`   联网搜索       ${on(SEARCH_ENABLED)}${SEARCH_ENABLED ? '' : '  缺 BAIDU_SEARCH_KEY'}`);
    console.log(`   语音合成       [已启用]  kktts 免密钥`);
    console.log(`   网页控制面板   ${on(WEBUI_ENABLED)}${WEBUI_ENABLED ? '' : '  缺 WEBUI_PASSWORD'}`);
    console.log(`   MC 服务器桥    ${on(MC_ENABLED)}${MC_ENABLED ? '' : '  缺 MC_BRIDGE_URL / MC_BRIDGE_SECRET'}`);
    console.log(`   主人专属功能   ${on(OWNER_ENABLED)}${OWNER_ENABLED ? '' : '  缺 BOT_OWNER，授权/审批等不可用'}`);
}

// ---------- 「唤起会话」：被叫到之后，接着几条没 @ 没关键词也继续判断 ----------
// 被 @/关键词/引用 叫到，就像现实里被叫住一样，接下来对方继续说，也该继续听着；
// 但也不能被无限占着，所以给额度：首先唤起的人多给几条，别人插嘴只给一条。
const ENGAGE_TTL = 10 * 60 * 1000;          // 会话有效期（每次互动都续期）
const ENGAGE_INITIATOR_LEFT = 3;            // 首先唤起的人：最多再检查 3 条
const ENGAGE_OTHER_LEFT = 1;                // 其他人插嘴：只检查 1 条
const ENGAGE_DEBUG = String(process.env.ENGAGE_DEBUG || '') === 'true';
const engageSessions = new Map();           // convKey -> { initiator, initLeft, otherLeft, exp }

/** 定期清掉过期的唤起会话（不依赖有没有新消息） */
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of engageSessions) if (now > e.exp) engageSessions.delete(k);
}, 60 * 1000);

if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

// 记忆模块初始化（配置化：条数/超时来自 .env）
initMemory(SAVE_DIR, {
  maxRecent: Number(process.env.MEMORY_MAX_RECENT || 30),
  maxLongterm: Number(process.env.MEMORY_MAX_LONGTERM || 50),
  maxAgeDays: Number(process.env.MEMORY_MAX_AGE_DAYS || 30),
  // 每次对话注入给 AI 的「最近对话」条数：20~30 为宜（太多费 token，太少记不住上文）
  contextRecent: Number(process.env.MEMORY_CONTEXT_RECENT || 20),
});

// 绑定模块初始化（QQ ↔ 游戏ID，#绑定；每人上限与验证码有效期来自 .env）
initBindings(SAVE_DIR, {
  maxPerQq: Number(process.env.BIND_MAX_PER_QQ || 3),
  ttlSec: Number(process.env.BIND_CAPTCHA_TTL || 300),
});

// 上下线记录（主人私聊 #查询 用）落盘，重启不丢
initPresence(SAVE_DIR);

// 余额统计（#余额 的累计充值/已使用）落盘，重启不丢
// 状态变量先在这里声明（初始化要用）；读写与累计函数在下方「AI 账户余额」一节
const BALANCE_FILE = path.join(SAVE_DIR, 'balance.json');
let balanceStat = { currencies: {} };
initBalance();

// AI 并发锁：每个会话（群/私聊）同时只允许一个 AI 请求，防止过多请求堆积
const aiBusy = new Map();
const convKey = (event) =>
    (event.message_type === 'private' ? 'p:' + event.user_id : 'g:' + event.group_id);

// 忽略的机器人 QQ（不响应）：内置常见官方机器人 + .env BOT_IGNORE_QQ 追加（逗号分隔）
const IGNORED_BOTS = new Set([
    '2854196310', // Q群管家
    ...(process.env.BOT_IGNORE_QQ || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
function isBotUser(event) {
    const uid = String(event.user_id || (event.sender && event.sender.user_id) || '');
    return IGNORED_BOTS.has(uid);
}

// 被禁言的群：发送失败后标记，后续消息静默跳过，避免反复报错
const mutedGroups = new Set();

// ---------- 提示词（动态加载） ----------
// 按文件修改时间缓存：改了 prompt.txt，下一次对话就用新的，**不用重启机器人**。
// 读不到（被删/被占/写一半）时继续用上一次的内容，绝不因为读文件失败把 AI 弄挂。
const PROMPT_PATH = path.join(__dirname, 'prompt.txt');
let promptCache = { mtimeMs: 0, text: '' };

function getSystemPrompt() {
    try {
        const st = fs.statSync(PROMPT_PATH);
        if (st.mtimeMs !== promptCache.mtimeMs) {
            const text = fs.readFileSync(PROMPT_PATH, 'utf-8');
            if (text.trim()) {
                console.log(promptCache.text
                    ? `🔄 提示词已热更新（${text.length} 字符），下一条消息就生效`
                    : `📝 已加载提示词（${text.length} 字符）`);
                promptCache = { mtimeMs: st.mtimeMs, text };
            }
        }
    } catch (e) {
        if (!promptCache.text) console.error('❌ 读取提示词失败（prompt.txt 在不在？）:', e.message);
    }
    return promptCache.text;
}

// ---------- OneBot 状态 ----------
let ws = null;
let botId = 0;
let msgSeq = 0;
const pending = new Map();

function nextSeq() { msgSeq += 1; return msgSeq; }

function callApi(action, params) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('WS_NOT_OPEN'));
        const echo = nextSeq();
        // 超时兜底：防止个别 API 无响应时把会话卡死（如群成员信息查询失败）
        const timer = setTimeout(() => {
            pending.delete(echo);
            reject(new Error(`API_TIMEOUT:${action}`));
        }, 20000);
        pending.set(echo, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ action, params, echo }));
    });
}

// ---------- 消息段 ----------
const segText = (t) => ({ type: 'text', data: { text: t } });
const segAt = (qq) => ({ type: 'at', data: { qq: String(qq) } });
// 本地文件用纯路径（NapCat 直接按本地文件解析，避免 file:// 方案解析歧义）
const segFile = (f) => String(f).replace(/\\/g, '/');
const segImage = (f) => ({ type: 'image', data: { file: segFile(f) } });
const segRecord = (f) => ({ type: 'record', data: { file: segFile(f) } });
// 内存里的图片（验证码等）：走 OneBot 的 base64:// 形式，不用落地文件
const segImageB64 = (buf) => ({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });

// ---------- AI 决策（含搜索/语音/跳过/多条回复标记解析） ----------
/**
 * @param allowSearch 是否让 AI 判断要不要联网搜索（第二轮已搜完就不需要了）
 * @param allowSkip   是否让 AI 判断"这条其实不是在叫小钠"从而不回复。
 *                    只在"群里只命中了关键词"这种模糊触发时开启；
 *                    @了机器人、引用了机器人、私聊，都是明确在跟它说话，不允许跳过。
 */
async function callAIWithDecision(userInput, searchResults = null, memory = '', allowSearch = true, allowSkip = false) {
    const url = process.env.AI_API_URL;
    const apiKey = process.env.AI_API_KEY;
    const model = process.env.AI_MODEL || 'deepseek-chat';

    // 这些标记是"合法工具标签"，优先于提示词里的任何格式限制。
    // 提示词写着"不许输出括号""不要分析过程""最多三句话"，模型有时会顺手把标记也省掉，
    // 结果就是该搜的时候不搜、该发语音时不发 —— 这里必须显式豁免。
    const tagRule = '【SEARCH:…】【VOICE:…】【REPLY:…】和“单独一行的三个连字符”都是合法的“工具标记”，'
        + '优先于提示词里的任何格式限制（不算方括号、不算分析过程、不占三句话额度）。该输出时必须原样输出，别省略、别解释。';

    let decisionPrompt = `你是小钠，一个智能QQ机器人助手。

【重要】你需要同时完成以下判断，并在回复中通过特殊标记告知框架。
${tagRule}
`;

    let step = 1;
    if (allowSkip) {
        decisionPrompt += `
${step++}. **是否需要接话**：小钠刚被人叫过，现在判断这条消息要不要接。
   - 关键区别：**冲着小钠来的**（问它、接它的话、追问、让它做事）→ 是；**把它当话题在跟别人聊**（评论它、拿它打比方、别人之间转去聊别的）→ 否。
   - 是 → 输出【REPLY:是】；否 → 输出【REPLY:否】，并且不要再生成回复内容。
   - 拿不准就回【REPLY:是】（宁可接一句，也别让叫它的人冷场）。
`;
    }
    if (allowSearch) {
        decisionPrompt += `
${step++}. **联网搜索判断**（默认不搜，拿不准就别搜）：
   - 只有"答案必须依赖此刻的外部信息、你凭自己不可能知道"时才搜：天气、新闻、赛事比分、股价汇率、票价、软件最新版本/价格、某人的近况等。
   - 以下一律不搜：闲聊寒暄、情绪吐槽、玩笑调侃、常识、算数、翻译、写代码/写文案、能靠上下文答的、以及问小钠自己的事。
   - 需要搜索 → 输出【SEARCH:需要|关键词:搜索词】；不需要 → 输出【SEARCH:不需要】
   - 关键词要短、能直接喂给搜索引擎（如“武汉今天天气”），别带“请问”“帮我查”这类口语。
`;
    }
    decisionPrompt += `
${step++}. **语音发送判断**：
   - 如果回复内容适合语音朗读（简短、自然、口语化），且用户有语音意图，标记：【VOICE:YES】
   - **重要**：当【VOICE:YES】时，回复文本必须是纯语音内容，不要添加任何前缀说明（如“我现在发语音”），直接输出要朗读的话。
   - 否则标记：【VOICE:NO】

${step}. **生成回复**：
   - 用自然、友好的中文回复用户
   - 一条内容太长、或本来就想分几口气说时，可以拆成多条发：**单独占一行写三个连字符 ---** 当作分隔，最多 3 条；不需要拆就别写分隔线。

${memory ? `\n【已知记忆】\n${memory}\n请结合以上记忆自然回复用户，不要直接复述记忆内容。\n` : ''}
${searchResults ? `\n【搜索结果已获取】\n${searchResults}\n请根据以上搜索结果回答用户的问题。\n` : ''}

现在请回复用户：${userInput}`;

    const sys = getSystemPrompt();
    const payload = {
        model,
        messages: [
            ...(sys ? [{ role: 'system', content: sys }] : []),
            { role: 'user', content: decisionPrompt }
        ],
        temperature: 0.7,
        max_tokens: 2048,
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`AI 请求失败 (${res.status})`);
    const data = await res.json();
    if (!data.choices || data.choices.length === 0) throw new Error('AI 返回格式异常');

    let reply = data.choices[0].message.content || '';

    // 解析标记：容忍全角冒号、空格、缺失关键词等写法
    let skip = false;
    if (allowSkip) {
        const rm = reply.match(/【\s*REPLY\s*[:：]\s*(否|不|NO|no|false|0)\s*】/);
        skip = !!rm;
    }
    reply = reply.replace(/【\s*REPLY\s*[:：][^】]*】/g, '');

    let needSearch = false, searchKeyword = '';
    if (allowSearch) {
        const sm = reply.match(/【\s*SEARCH\s*[:：]\s*需要(?:\s*[|｜]\s*关键词\s*[:：]\s*([^】]+))?\s*】/);
        if (sm) {
            needSearch = true;
            searchKeyword = String(sm[1] || '').trim();
        }
    }
    // 无论是否解析出关键词，都把标记整体清掉 —— 否则畸形写法会漏到用户看到的消息里
    reply = reply.replace(/【\s*SEARCH\s*[:：][^】]*】/g, '');

    let wantVoice = false;
    const voiceMatch = reply.match(/【\s*VOICE\s*[:：]\s*(YES|NO|是|否)\s*】/i);
    if (voiceMatch) wantVoice = /^(YES|是)$/i.test(voiceMatch[1]);
    reply = reply.replace(/【\s*VOICE\s*[:：][^】]*】/gi, '');

    return { reply: reply.trim(), needSearch, searchKeyword, wantVoice, skip };
}

/**
 * 把 AI 的一条回复拆成多条（它用单独一行的 --- 分隔）。
 * 超过 max 条时把剩下的并进最后一条，避免丢内容。
 */
function splitReplies(text, max = 3) {
    const raw = String(text || '');
    const parts = raw.split(/\r?\n[ \t]*-{3,}[ \t]*\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) return raw.trim() ? [raw.trim()] : [];
    if (parts.length > max) parts.splice(max - 1, parts.length, parts.slice(max - 1).join(' '));
    return parts;
}

// ---------- 消息净化 / 攻击识别 ----------
function cleanMessage(content) {
    let clean = content.replace(/\[[^\]]+\]/g, '').trim();
    clean = clean.replace(/@小钠/g, '').trim();
    return clean;
}

function isSuspicious(text) {
    const patterns = [
        /忽略.*指令/, /覆盖.*规则/, /扮演.*角色/,
        /提示词/, /系统指令/, /一步步思考/, /展示推理/,
        /检索.*文档/, /原始消息/, /你收到了什么/,
        /每次输出一个字/, /调用工具/, /执行代码/
    ];
    return patterns.some((p) => p.test(text));
}

// ---------- 发送前体检：真实脏字 → 谐音 ----------
/**
 * QQ 对脏字的风控最狠（轻则拦消息，重则限制账号）。提示词已经要求 AI 不写真实脏字，
 * 但模型偶尔还是会漏 —— 这里做一道确定性兜底，发出前一律换成谐音。
 */
const PROFANITY_FIX = [
    [/他妈的/g, '特喵的'],
    [/你妈的?/g, '尼玛'],
    [/妈的/g, '玛德'],
    [/傻逼|傻B|煞笔|沙比/gi, '沙雕'],
    [/操你|草你|艹你/g, '草拟'],
    [/王八蛋/g, '忘八蛋'],
    [/婊子/g, '表子'],
];

function sanitizeOutgoing(text) {
    let out = String(text ?? '');
    let hit = false;
    for (const [re, to] of PROFANITY_FIX) {
        if (out.search(re) >= 0) {
            hit = true;
            out = out.replace(re, to);
        }
    }
    if (hit) console.log('🛡️ 发送前把真实脏字换成了谐音');
    return out;
}

// ---------- 发送 ----------
async function sendReply(event, message, wantVoice = false, withAt = false) {
    const MAX_LENGTH = 500;
    const target = event.message_type === 'private'
        ? { action: 'send_private_msg', id: event.user_id }
        : { action: 'send_group_msg', id: event.group_id };
    const gidKey = event.message_type === 'group' ? String(event.group_id) : '';

    // 已判定被禁言的群：直接静默跳过，不再尝试发送（避免连环报错）
    if (gidKey && mutedGroups.has(gidKey)) {
        console.log(`🔇 群 ${gidKey} 处于禁言中，已跳过发送。`);
        return;
    }

    async function doSend(segments) {
        // 发送途中若已被标记禁言，直接放弃本条
        if (gidKey && mutedGroups.has(gidKey)) return;
        try {
            await callApi(target.action, {
                [event.message_type === 'private' ? 'user_id' : 'group_id']: target.id,
                message: segments,
            });
            // 发送成功说明未被禁言，解除标记
            if (gidKey) mutedGroups.delete(gidKey);
        } catch (e) {
            // 被禁言/无权限等：标记该群，避免后续消息反复报错
            if (gidKey && /禁言|muted|ban|不可发送|没权限|群已冻结/i.test(e.message)) {
                mutedGroups.add(gidKey);
                console.log(`🔇 群 ${gidKey} 被禁言或不可发言，已停止发送:`, e.message.slice(0, 100));
                return;
            }
            throw e;
        }
    }

    // 语音
    if (wantVoice && typeof message === 'string' && message.length <= 300) {
        try {
            const voicePath = await textToSpeech(message);
            await doSend([segRecord(voicePath)]);
            cleanVoiceCache(50);
            console.log('🎵 语音已发送');
            return;
        } catch (err) {
            console.error('语音发送失败，降级为文本:', err.message);
            message = '⚠️ 语音生成失败，转为文字：\n' + message;
        }
    }

    // 发送前体检：真实脏字一律换成谐音（QQ 对脏字风控最狠，这是兜底）
    if (typeof message === 'string') message = sanitizeOutgoing(message);

    // 机器人主动 @：回复里写了 @某人，就换成真正的 at 段（认不出的人名原样留文字）
    if (typeof message === 'string' && gidKey && message.includes('@')) {
        const segs = await segmentsWithMentions(message, gidKey);
        if (segs) message = segs;
    }

    // 消息段数组（如 [image]/[record]）：直接按段发送，不做文本包装
    if (Array.isArray(message) && message.length && message.every((s) => s && typeof s === 'object' && s.type)) {
        // 回复里已经 @ 了别人，就别再额外 @ 提问者，免得一串 @
        const needAt = withAt && !message.some((s) => s.type === 'at');
        await doSend(needAt ? [segAt(event.user_id), ...message] : message);
        return;
    }

    // 文本
    const texts = typeof message === 'string' ? [message] : message;
    for (const t of texts) {
        if (t.length > MAX_LENGTH) {
            const sentences = t.match(/[^。！？\n]+[。！？\n]/g) || [t];
            for (const seg of sentences) {
                if (seg.trim()) {
                    await doSend(withAt ? [segAt(event.user_id), segText(seg.trim())] : [segText(seg.trim())]);
                    await new Promise((r) => setTimeout(r, 200));
                }
            }
        } else {
            await doSend(withAt ? [segAt(event.user_id), segText(t)] : [segText(t)]);
        }
    }
}

// ---------- 会话元数据（按参考项目格式注入 prompt） ----------
// [当前对话:私信|对话ID:xxx][名称:昵称| QQ:qq|身份:身份|好感度:xx%|群头衔:头衔|msgId:id|时间:...]消息内容:[ 正文]
const metaCache = new Map(); // key -> {name,title,groupRole,exp}
const META_TTL = 5 * 60 * 1000;
const META_CACHE_MAX = 300;

async function getMemberMeta(event) {
    const uid = String(event.user_id);
    const gid = event.group_id ? String(event.group_id) : '';
    const key = (event.message_type === 'private' ? 'p:' : 'g:') + uid + ':' + gid;
    const c = metaCache.get(key);
    if (c && Date.now() < c.exp) return c;

    let name = uid, title = '', groupRole = '', isRobot = false;
    try {
        if (event.message_type === 'group' && gid) {
            const m = await callApi('get_group_member_info', { group_id: event.group_id, user_id: event.user_id });
            name = m.card || m.nickname || uid;
            title = m.title || '';
            groupRole = m.role || '';
            isRobot = m.is_robot === true;          // NapCat 的群成员信息里带这个字段
        } else {
            const s = await callApi('get_stranger_info', { user_id: event.user_id });
            name = s.nickname || uid;
            isRobot = s.is_robot === true;
        }
    } catch { /* 获取失败则用 QQ 号兜底 */ }
    // 认出来的机器人记一笔：本会话后续把它标成「机器人」，不用每次重查
    if (isRobot) cacheSet(botQqCache, uid, BOT_CACHE_MAX, { exp: Date.now() + BOT_TTL });
    const val = { name, title, groupRole, isRobot, exp: Date.now() + META_TTL };
    cacheSet(metaCache, key, META_CACHE_MAX, val);
    return val;
}

// 认出来的机器人 QQ（共享给「机器人:是」和记忆署名用）
const botQqCache = new Map();
const BOT_CACHE_MAX = 200;
const BOT_TTL = 30 * 60 * 1000;
/** 这条 QQ 是不是已认出来的机器人 */
function isKnownBot(qq) {
    const e = botQqCache.get(String(qq));
    return !!(e && Date.now() < e.exp);
}

export function buildMetaLine(event, meta, atBot, userInput, where = '') {
    const uid = String(event.user_id);
    const dialog = event.message_type === 'private' ? '私信' : '群聊';
    const dialogId = event.message_type === 'private' ? uid : String(event.group_id || '');

    // 身份：主人 > 群主/管理员(群角色) > 管理员 > 授权用户 > 成员
    const role = perm.role(uid);
    let ident, favor;
    if (role === 'owner') { ident = '主人'; favor = 100; }
    else if (role === 'admin') { ident = '管理员'; favor = 90; }
    else if (role === 'authorized') { ident = '授权用户'; favor = 75; }
    else { ident = '成员'; favor = 50; }
    if (event.message_type === 'group' && role !== 'owner') {
        if (meta.groupRole === 'owner') { ident = '群主'; favor = 95; }
        else if (meta.groupRole === 'admin') { ident = '管理员'; favor = 80; }
    }
    // 机器人单独打标签：它不是人，别按真人的话去理解，也别跟它客气
    if (meta.isRobot || isKnownBot(uid)) { ident = '机器人'; favor = 30; }

    const atPrefix = atBot ? '[艾特你] ' : '';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return `[当前对话:${dialog}${where ? '|来源:' + where : ''}|对话ID:${dialogId}][名称:${meta.name}| QQ:${uid}|身份:${ident}|好感度:${favor}%|群头衔:${meta.title}|msgId:${event.message_id ?? ''}|时间:${timeStr}]消息内容:[ ${atPrefix}${userInput}]`;
}

// ---------- #帮助 动态菜单（独立模块 help.js） ----------

// ---------- 指令 ----------

// IP 归属地查询（主人私聊 #查询 用）：走 yuafeng 免费接口，结果缓存 30 分钟
const ipLocCache = new Map();
const IP_LOC_CACHE_MAX = 200;
const IP_LOC_TTL = 30 * 60 * 1000;

/** 内网 / 回环地址查归属地没意义（复用没接通时会拿到 127.0.0.1），直接跳过 */
function isPrivateIp(ip) {
    return /^(10\.|127\.|192\.168\.|169\.254\.|::1$|fc|fd|fe80)/i.test(String(ip || ''))
        || /^172\.(1[6-9]|2\d|3[01])\./.test(String(ip || ''));
}

/** 查某个 IP 的归属地，返回一行文字；失败返回 ''（不影响 #查询 其余内容） */
async function ipLocationOf(ip) {
    const key = String(ip || '').trim();
    if (!key || isPrivateIp(key)) return '';
    const c = ipLocCache.get(key);
    if (c && Date.now() < c.exp) return c.text;
    try {
        const res = await fetch('https://api-v2.yuafeng.cn/API/ip_location.php?ip=' + encodeURIComponent(key), {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (j.code !== 0 || !j.data || !j.data.location) throw new Error(j.msg || '返回格式异常');
        const loc = j.data.location;
        // "中国 北京市 北京市" 这种情况去个重，看着清爽
        const parts = [...new Set([loc.country && loc.country.name, loc.region, loc.city].filter(Boolean))];
        let text = parts.join(' ') || '未知';
        if (loc.postcode) text += `（${loc.postcode}）`;
        cacheSet(ipLocCache, key, IP_LOC_CACHE_MAX, { text, exp: Date.now() + IP_LOC_TTL });
        return text;
    } catch (e) {
        console.log('[IP归属地] 查询失败:', key, e.message);
        return '';
    }
}

/**
 * 主人私聊专属：#查询 时额外附上登录 IP 与最近 5 次上下线。
 * 数据来自桥的 join/leave 事件（mod 2.4.0+ 的 join 事件才带真实客户端 IP），
 * 只保留机器人本次运行期间的记录，所以没记录时要说清是"没记到"而不是"没有"。
 */
async function ownerQueryExtra(name) {
    const h = getPlayerHistory(name);
    const pad = (n) => String(n).padStart(2, '0');
    const when = (ms) => {
        const d = new Date(ms);
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const lines = ['———— 主人可见 ————'];
    lines.push(`📍 最近登录 IP：${h && h.ip ? h.ip : '暂无记录（需 mod 2.4.0+，且该玩家本次启动后进过服）'}`);
    // 紧跟着补上这个 IP 的归属地
    if (h && h.ip) {
        const loc = await ipLocationOf(h.ip);
        if (loc) lines.push(`🗺️ 归属地：${loc}`);
    }
    if (h && h.events.length) {
        lines.push(`🕒 最近上下线（共 ${h.events.length} 条）：`);
        // 倒序：最新一条在最上面
        for (const e of h.events.slice().reverse()) {
            lines.push(`· ${when(e.at)} ${e.type === 'join' ? '上线' : '下线'}${e.ip ? `（${e.ip}）` : ''}`);
        }
    } else {
        lines.push('🕒 最近上下线：暂无记录（机器人本次启动后没收到该玩家的进出服事件）');
    }
    return lines.join('\n');
}

async function handleCommand(event, text) {
    const [rawCmd, ...rest] = text.split(/\s+/);
    // 命令前缀：支持 "#"（推荐）与 "/"（兼容），内部统一按 "/" 处理
    const cmd = rawCmd.startsWith('#') ? '/' + rawCmd.slice(1) : rawCmd;
    const arg = rest.join(' ').trim();
    const uid = String(event.user_id);
    const r = perm.role(uid);

    switch (cmd) {
        case '/help':
        case '/帮助':
            return sendReply(event, buildHelp(r, arg));

        case '/mc':
            if (!arg) return sendReply(event, '❌ 用法：#mc 服务器地址[:端口]，如 #mc play.example.com 或 #mc 1.2.3.4:25565');
            return doMc(event, arg);

        // ===== 群管理（仅群里可用，需主人/管理员） =====
        case '/禁言':
        case '/解禁':
        case '/临时禁言':
        case '/踢出':
        case '/拉黑':
        case '/全体禁言':
        case '/解除全体禁言':
        case '/群公告':
            return handleGroupAdmin(event, cmd, arg, r);

        case '/解绑': {
            const r = unbindGame(uid, arg);
            return sendReply(event, r.ok ? r.msg : `❌ ${r.error}`);
        }

        case '/我的绑定':
        case '/绑定列表':
            return sendReply(event, listBindings(uid));

        case '/强制解绑': {
            if (r !== 'owner' && r !== 'admin') return sendReply(event, '❌ 只有主人/管理员可以强制解绑');
            const [q, gid] = arg.split(/\s+/).filter(Boolean);
            if (!q) return sendReply(event, '❌ 用法：#强制解绑 <QQ号> [游戏ID]\n不带游戏ID则清空该QQ的全部绑定');
            const fr = forceUnbind(q, gid);
            return sendReply(event, fr.ok ? fr.msg : `❌ ${fr.error}`);
        }

        case '/绑定': {
            if (!arg) {
                return sendReply(event, `❌ 用法：#绑定 <游戏ID>\n绑定后，桥接群的 QQ 消息会转发进游戏给你；每个QQ最多 ${maxPerQQ()} 个。`);
            }
            const r = startBind(uid, arg);
            if (!r.ok) return sendReply(event, `❌ ${r.error}`);
            return sendReply(event, [
                segImageB64(r.image),
                segText(`🔐 请把图中 4 位数字发给我（${Math.round(r.ttlSec / 60)} 分钟内有效）\n`
                    + `绑定目标：${r.gameId}（第 ${r.count}/${maxPerQQ()} 个）`),
            ]);
        }

        case '/状态': {
            return sendReply(event, await doStatus(r));
        }

        case '/余额':
        case '/balance':
            return doBalance(event, r);

        case '/同意':
        case '/拒绝':
            return handleManualApproval(event, cmd, arg);

        case '/查询': {
            const target = arg.trim();
            if (!target) {
                return sendReply(event, '❌ 用法：#查询 <玩家名>\n数据来自服务器的 Plan 插件（名字为 3-16 位字母/数字/下划线）');
            }
            try {
                const out = formatPlanPlayer(target, await getPlanPlayer(target));
                // 公开聊天里保持原样；只有主人私聊才额外附上登录 IP、归属地与最近 5 次上下线
                if (r === 'owner' && event.message_type === 'private') {
                    return sendReply(event, `${out}\n\n${await ownerQueryExtra(target)}`);
                }
                return sendReply(event, out);
            } catch (e) {
                return sendReply(event, `❌ 查询失败：${e.message}`);
            }
        }

        case '/申请授权':
            return doApplyAuth(event, uid);

        // ===== 定时任务 =====
        case '/定时提醒':
        case '/定时禁言':
        case '/定时解禁':
        case '/定时列表':
        case '/取消定时':
            return handleScheduler(event, cmd, arg, r);

        case '/授权': {
            if (r !== 'owner') return sendReply(event, '❌ 仅主人可执行授权操作。');
            const t = resolveTarget(event, arg);
            if (!t) {
                const list = perm.listAuthorized();
                const pend = perm.listPending();
                return sendReply(event, `👑 主人: ${perm.getOwner()}\n🟢 已授权(${list.length}): ${list.length ? list.join('、') : '无'}\n⏳ 待审批(${pend.length}): ${pend.length ? pend.join('、') : '无'}`);
            }
            if (perm.role(t) === 'admin') return sendReply(event, `ℹ️ QQ ${t} 本就是管理员。`);
            const g = perm.grant(t);
            if (g.added) inviteSendOwner(t, '已授权');
            return sendReply(event, g.msg);
        }

        case '/拒绝授权': {
            if (r !== 'owner') return sendReply(event, '❌ 仅主人可执行授权操作。');
            const t = resolveTarget(event, arg);
            if (!t) return sendReply(event, '❌ 请 @对方 或提供 QQ 号。');
            return perm.rejectAuth(t)
                ? (inviteSendOwner(t, '已拒绝'), sendReply(event, `❌ 已拒绝 QQ ${t} 的授权申请。`))
                : sendReply(event, `❌ QQ ${t} 没有待审批的申请。`);
        }

        case '/取消授权': {
            if (r !== 'owner') return sendReply(event, '❌ 仅主人可执行授权操作。');
            const t = resolveTarget(event, arg);
            if (!t) return sendReply(event, '❌ 请 @对方 或提供 QQ 号。');
            return perm.revoke(t)
                ? sendReply(event, `🗑️ 已取消 QQ ${t} 的授权。`)
                : sendReply(event, `❌ QQ ${t} 不在授权列表中。`);
        }

        case '/记住':
        case '/记忆':
        case '/忘记':
        case '/清除记忆':
            return handleMemoryCmd(event, cmd, arg);

        case '/clear':
            clearMemory(convKey(event));
            return sendReply(event, '✅ 已清空本会话的记忆。');

        case '/screenshot':
        case '/截图':
        case '/截屏':
            if (!perm.hasPermission(uid)) return sendReply(event, `❌ 无权限（未授权）。发送 #申请授权 等待主人审批`);
            return doScreen(event);

        case '/shot':
            if (!perm.hasPermission(uid)) return sendReply(event, `❌ 无权限（未授权）。发送 #申请授权 等待主人审批`);
            if (!/^https?:\/\//i.test(arg)) return sendReply(event, '❌ 用法：#shot https://example.com');
            return doShot(event, arg);

        case '/换名':
        case '/换头像':
            return handleProfile(event, cmd, arg, r);

        case '/接管':
            if (r !== 'owner') return sendReply(event, '❌ 仅主人可执行该操作。');
            if (arg === 'auto' || arg === '人工' || arg === 'manual') {
                setTakeoverMode(convKey(event), 'auto', uid);
                return sendReply(event, '✅ 已恢复自动回复。');
            }
            if (arg === '混合' || arg === 'hybrid') {
                setTakeoverMode(convKey(event), 'hybrid', uid);
                return sendReply(event, '🔀 已切换为混合模式（AI 自动回复 + 人工可介入）。');
            }
            setTakeoverMode(convKey(event), 'manual', uid);
            return sendReply(event, '🤝 已人工接管本会话，自动回复已暂停。用 #恢复AI 恢复，或在面板上操作。');

        case '/恢复AI':
            if (r !== 'owner' && r !== 'admin') return sendReply(event, '❌ 仅主人/管理员可执行该操作。');
            setTakeoverMode(convKey(event), 'auto', uid);
            return sendReply(event, '✅ 已恢复自动回复。');

        default:
            return false;
    }
}

// ============ 群管理 ============
// 解析目标成员：优先取 @，其次取参数中的 QQ 号
function resolveTarget(event, arg) {
    const ats = (Array.isArray(event.message) ? event.message : [])
        .filter((s) => s.type === 'at' && String(s.data.qq) !== String(botId));
    if (ats.length) return String(ats[0].data.qq);
    const m = arg ? arg.match(/\d{5,14}/) : null;
    return m ? m[0] : null;
}

// 需要指定目标成员的指令
const ADMIN_TARGET_CMDS = new Set(['/禁言', '/解禁', '/临时禁言', '/踢出', '/拉黑']);

async function handleGroupAdmin(event, cmd, arg, roleName) {
    // 仅群里可用
    if (event.message_type !== 'group' || !event.group_id) {
        return sendReply(event, '❌ 该指令仅可在群聊中使用。');
    }
    // 仅主人/管理员
    if (roleName !== 'owner' && roleName !== 'admin') {
        return sendReply(event, '❌ 无权限（需主人或管理员）。');
    }
    const gid = event.group_id;

    // —— 需要目标的成员操作 ——
    if (ADMIN_TARGET_CMDS.has(cmd)) {
        const target = resolveTarget(event, arg);
        if (!target) return sendReply(event, '❌ 未指定目标 QQ，请 @对方 或附带 QQ 号。');
        if (String(target) === String(botId)) return sendReply(event, '❌ 不能对自己执行该操作。');
        const ops = {
            '/禁言': () => {
                const min = (arg.match(/\d+/)?.[0] ? Number(arg.match(/\d+/)[0]) : 10) || 10;
                return { action: 'set_group_ban', params: { group_id: gid, user_id: target, duration: min * 60 }, ok: `已禁言 ${target} ${min} 分钟。` };
            },
            '/临时禁言': () => {
                const sec = (arg.match(/\d+/)?.[0] ? Number(arg.match(/\d+/)[0]) : 60) || 60;
                return { action: 'set_group_ban', params: { group_id: gid, user_id: target, duration: sec }, ok: `已临时禁言 ${target} ${sec} 秒。` };
            },
            '/解禁': () => ({ action: 'set_group_ban', params: { group_id: gid, user_id: target, duration: 0 }, ok: `已解除 ${target} 的禁言。` }),
            '/踢出': () => ({ action: 'set_group_kick', params: { group_id: gid, user_id: target, reject_add_request: false }, ok: `已将 ${target} 移出本群。` }),
            '/拉黑': () => ({ action: 'set_group_kick', params: { group_id: gid, user_id: target, reject_add_request: true }, ok: `已将 ${target} 移出本群并拉黑（拒绝再次入群）。` }),
        };
        const op = ops[cmd]();
        try {
            await callApi(op.action, op.params);
            await sendReply(event, `✅ ${op.ok}`);
        } catch (e) {
            await sendReply(event, `❌ 操作失败：${e.message}`.slice(0, 200));
        }
        return;
    }

    // —— 无目标操作 ——
    try {
        if (cmd === '/全体禁言') {
            await callApi('set_group_whole_ban', { group_id: gid, enable: true });
            await sendReply(event, '🔇 已开启全体禁言。');
        } else if (cmd === '/解除全体禁言') {
            await callApi('set_group_whole_ban', { group_id: gid, enable: false });
            await sendReply(event, '🔊 已解除全体禁言。');
        } else if (cmd === '/群公告') {
            const content = arg.trim();
            if (!content) return sendReply(event, '❌ 用法：#群公告 要发布的内容');
            await callApi('send_group_notice', { group_id: gid, content });
            await sendReply(event, '📢 群公告已发布。');
        }
    } catch (e) {
        await sendReply(event, `❌ 操作失败：${e.message}`.slice(0, 200));
    }
}

// ============ 定时任务（独立模块 scheduler.js） ============
initScheduler({ callApi, sendReply, segText, getBotId: () => botId, saveDir: SAVE_DIR });

// 人工接管超时自动恢复（TAKEOVER_TIMEOUT 秒，0 或留空=不自动恢复）
setInterval(() => {
  const to = Number(process.env.TAKEOVER_TIMEOUT || 0) * 1000;
  if (!to) return;
  const now = Date.now();
  for (const k of Object.keys(takeover.modes)) {
    if (takeover.modes[k] !== 'manual') continue;
    const last = [...takeover.audit].reverse().find((a) => a.key === k && a.to === 'manual');
    if (last && now - last.t > to) {
      setTakeoverMode(k, 'auto', 'timeout');
      pushLog(`⏰ 会话 ${k} 接管超时，已自动恢复自动回复`);
      console.log(`⏰ 会话 ${k} 接管超时，已自动恢复自动回复`);
    }
  }
}, 10000);

// ============ 授权 ============
// 提交授权申请（本人）
async function doApplyAuth(event, uid) {
    const r = perm.requestAuth(uid);
    if (r.ok) notifyOwner(`🔔 收到授权申请：QQ ${uid}\n主人请回复：\n#授权 ${uid}   同意\n#拒绝授权 ${uid}   拒绝`).catch(() => {});
    return sendReply(event, r.ok ? `⏳ ${r.msg}` : `ℹ️ ${r.msg}`);
}

// 主人通知回调（私聊主人）
const notifyOwner = async (msg) => {
    const owner = perm.getOwner();
    if (!owner) return;
    await callApi('send_private_msg', { user_id: owner, message: [segText(msg)] }).catch((e) => console.error('通知主人失败:', e.message));
};

// 被审批后被授权者结果私聊（尽力而为）
const inviteSendOwner = (qq, verb) => {
    callApi('send_private_msg', { user_id: qq, message: [segText(`📢 你的授权申请已被主人${verb}。`)] }).catch(() => {});
};

async function doMc(event, server) {
    try {
        await sendReply(event, `🔍 正在查询 ${server} ...`);
        const info = await queryServer(server);
        await sendReply(event, formatServer(info));
    } catch (e) {
        await sendReply(event, '❌ MC 查询失败：' + e.message);
    }
}

// ---------- AI 账户余额（#余额） ----------
/**
 * 余额统计：服务商只给"当前余额"，没有账单/用量接口，所以"累计充值""已使用"只能本地采样累积。
 * 每次查询时和上次快照比 —— 充值/赠送只会让账上余额上升，把上升量累加即累计充值/赠送；
 * 已使用 = 累计充值 + 累计赠送 - 当前余额。
 * 只能统计**首次查询之后**的变化，更早的消费服务商不提供、无从追溯；
 * 想覆盖更早的历史，用 .env 的 AI_BALANCE_*_BASE 填基数。
 * 按币种分别累计，落盘到 data/balance.json。
 */
function initBalance() {
    const d = readJsonSafe(BALANCE_FILE, null, 'balance.json');
    balanceStat = (d && typeof d === 'object' && d.currencies) ? d : { currencies: {} };
}

function saveBalance() {
    writeJsonAtomic(BALANCE_FILE, balanceStat);
}

const balanceCents = (v) => Math.round(Number(v || 0) * 100);
const balanceStr = (c) => (c / 100).toFixed(2);

/** 把一次余额快照并进累计统计，返回该币种的统计对象 */
function trackBalance(info) {
    const cur = String(info.currency || 'CNY');
    const nowTop = balanceCents(info.topped_up_balance);
    const nowGrant = balanceCents(info.granted_balance);
    const nowTotal = balanceCents(info.total_balance);
    let st = balanceStat.currencies[cur];
    if (!st) {
        // 首次：账上现有的钱当作"累计充值/赠送"的起点。
        // .env 里若显式给了基数（补齐服务商不提供的更早历史），用配置值覆盖。
        const envRecharge = balanceCents(process.env.AI_BALANCE_RECHARGE_BASE);
        const envGrant = balanceCents(process.env.AI_BALANCE_GRANT_BASE);
        const envUsed = balanceCents(process.env.AI_BALANCE_USED_BASE);
        st = {
            rechargeCents: envRecharge > 0 ? envRecharge : nowTop,
            grantedCents: envGrant > 0 ? envGrant : nowGrant,
            usedBaseCents: envUsed,
            firstTotalCents: nowTotal,
            inflowCents: 0,     // 统计开始后累计"入账"增量（充值+赠送）
            last: null,
        };
    } else if (st.last) {
        const topUp = Math.max(0, nowTop - st.last.top);
        const grantUp = Math.max(0, nowGrant - st.last.grant);
        st.rechargeCents += topUp;          // 充值只会让余额升，上升量即新充的钱
        st.grantedCents += grantUp;
        st.inflowCents += topUp + grantUp;
    }
    st.last = { top: nowTop, grant: nowGrant, total: nowTotal, at: Date.now() };
    balanceStat.currencies[cur] = st;
    saveBalance();
    return st;
}

/**
 * 查 AI 服务商账户余额（DeepSeek：GET /user/balance）。
 * 接口地址由 AI_API_URL 推导（去掉 /chat/completions 那段）——
 * 换成其它服务商时若没有这个接口，会返回一句友好提示而不是报错崩掉。
 */
async function doBalance(event, role) {
    if (role !== 'owner' && role !== 'admin') {
        return sendReply(event, '❌ 只有主人/管理员可以查看余额');
    }
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) return sendReply(event, '❌ 没有配置 AI_API_KEY');
    const base = String(process.env.AI_API_URL || '')
        .replace(/\/chat\/completions.*$/i, '').replace(/\/+$/, '');
    if (!base) return sendReply(event, '❌ AI_API_URL 没配置，推不出余额接口地址');
    try {
        const res = await fetch(`${base}/user/balance`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            return sendReply(event, `❌ 余额查询失败（HTTP ${res.status}）：该服务商可能没有余额接口`);
        }
        const data = await res.json();
        const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
        if (!infos.length) return sendReply(event, '💰 查到了响应，但里面没有余额信息（当前服务商可能不支持）');

        const multi = infos.length > 1;
        const blocks = infos.map((b) => {
            const st = trackBalance(b);
            const sym = b.currency === 'CNY' ? '¥' : b.currency === 'USD' ? '$' : '';
            const tag = sym || ` ${b.currency || ''} `;           // 没有符号的币种直接用代码
            const total = balanceCents(b.total_balance);
            // 已使用 = 统计开始前已用 + （起始余额 + 之后的入账 - 当前余额）
            const used = Math.max(0, st.usedBaseCents + st.firstTotalCents + st.inflowCents - total);
            const head = multi ? `【${b.currency || '?'}】\n` : '';
            return head
                + `· 当前余额：${tag}${balanceStr(total)}（充值余 ${tag}${balanceStr(balanceCents(b.topped_up_balance))} + 赠金余 ${tag}${balanceStr(balanceCents(b.granted_balance))}）\n`
                + `· 累计充值：${tag}${balanceStr(st.rechargeCents)}　累计赠送：${tag}${balanceStr(st.grantedCents)}\n`
                + `· 已使用（累计）：${tag}${balanceStr(used)}`;
        });
        const head = data.is_available ? '💰 AI 账户余额：' : '⚠️ AI 账户余额（当前不可用）：';
        return sendReply(event, head + '\n' + blocks.join('\n'));
    } catch (e) {
        return sendReply(event, '❌ 余额查询出错：' + String(e.message).slice(0, 120));
    }
}

async function doScreen(event) {
    const cacheDir = path.join(SAVE_DIR, 'cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    let p = null, sent = false;
    try {
        await sendReply(event, '📸 正在截取屏幕…');
        p = await captureScreen(cacheDir);
        const st = fs.statSync(p);
        if (st.size < 1024) throw new Error('截图内容为空（可能屏幕被锁定）');
        console.log(`📸 截屏成功: ${p} (${st.size}B)`);
        await sendReply(event, [segImage(p)]);
        sent = true;
        // 延迟 60s 清理：NapCat 可能异步读取本地文件，立即删除会竞态
        setTimeout(() => fs.unlink(p, () => {}), 60000);
    } catch (e) {
        console.error('📸 截图流程出错:', e); // 完整错误写入终端/日志，便于定位
        await sendReply(event, `${sent ? '❌ 图片发送失败' : '❌ 屏幕截图失败'}：${String(e.message).slice(0, 150)}`);
        if (p) setTimeout(() => fs.unlink(p, () => {}), 3000);
    }
}

async function doShot(event, url) {
    const cacheDir = path.join(SAVE_DIR, 'cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    let p = null, sent = false;
    try {
        await sendReply(event, '🌐 正在对网址截图…');
        p = await captureUrl(url, cacheDir);
        const st = fs.statSync(p);
        if (st.size < 1024) throw new Error('网页截图内容为空');
        await sendReply(event, [segImage(p)]);
        sent = true;
        setTimeout(() => fs.unlink(p, () => {}), 60000);
    } catch (e) {
        console.error('🌐 网址截图流程出错:', e.message);
        await sendReply(event, `${sent ? '❌ 图片发送失败' : '❌ 网址截图失败'}：${String(e.message).slice(0, 150)}`);
        if (p) setTimeout(() => fs.unlink(p, () => {}), 3000);
    }
}

// ---------- 消息事件 ----------
function extractText(segments) {
    if (!Array.isArray(segments)) return String(segments || '').trim();
    return segments.map((s) => (s.type === 'text' ? s.data.text : '')).join('').trim();
}
function wasAtBot(segments) {
    return Array.isArray(segments)
        ? segments.some((s) => s.type === 'at' && String(s.data.qq) === String(botId))
        : false;
}

/**
 * 把消息段压成一行文字（控制台日志 / 记忆 / AI 输入都用它）。
 *
 * 只取文字段会把"这句话是说给谁听的"和"对方发了什么"整个丢掉 —— 所以：
 * - @ 段还原成 @昵称（只读缓存，**绝不等 NapCat**：这条路在每条消息最前面，慢一步转发就迟一步，
 *   没命中的昵称在后台补进缓存，下一次就是真名；拿不到就先显示消息里带的名字或 QQ 号）
 * - 图片/表情/语音/视频/文件 显示成 [图片] 这类占位（和转发进游戏的标签是同一份）
 */
function inlineTextOf(segments, groupId) {
    if (!Array.isArray(segments)) return String(segments || '').trim();
    let out = '';
    for (const seg of segments) {
        if (!seg || !seg.data) continue;
        if (seg.type === 'text') out += seg.data.text || '';
        else if (seg.type === 'at') {
            const qq = String(seg.data.qq || '');
            if (qq === 'all') { out += '@全体成员'; continue; }
            const cached = atNameCached(groupId, qq);
            if (!cached) warmAtName(groupId, qq);
            out += '@' + (cached || String(seg.data.name || '').trim() || qq);
        } else if (seg.type === 'reply') out += '[引用]';   // 原文要查 NapCat，这里不查
        else if (SEG_PLACEHOLDER[seg.type]) out += SEG_PLACEHOLDER[seg.type];
    }
    return out.trim();
}

/** 非文字消息段的统一占位（游戏里放不出这些，只能报类型）：转发与控制台共用一份 */
const SEG_PLACEHOLDER = {
    image: '[图片]',
    face: '[动画表情]',     // QQ 表情
    mface: '[动画表情]',    // 商城大表情
    record: '[语音]',
    video: '[视频]',
    file: '[文件]',
};

/** 同步读 @ 昵称缓存；没有返回 '' */
function atNameCached(groupId, qq) {
    const c = atNameCache.get(groupId + ':' + qq);
    return c && Date.now() < c.exp ? c.name : '';
}

/** 后台补 @ 昵称进缓存（不阻塞当前消息） */
function warmAtName(groupId, qq) {
    if (!groupId || !qq || qq === 'all' || atNameCached(groupId, qq)) return;
    atDisplayName(groupId, qq, '').catch(() => {});
}

/**
 * 给 AI 看的版本：**可以等**（马上也要等模型几百毫秒），所以 @ 后面一定是真昵称，
 * 不会是 QQ 号 —— 否则模型只会照着 QQ 号写 @2233445，群成员名单里按名字根本对不上。
 * 控制台/转发/记忆仍然走同步的 inlineTextOf，不能为了显示去等 NapCat。
 */
async function inlineTextOfForAi(segments, groupId) {
    if (!Array.isArray(segments)) return String(segments || '').trim();
    let out = '';
    for (const seg of segments) {
        if (!seg || !seg.data) continue;
        if (seg.type === 'text') out += seg.data.text || '';
        else if (seg.type === 'at') {
            const qq = String(seg.data.qq || '');
            out += qq === 'all' ? '@全体成员' : '@' + await atDisplayName(groupId, qq, seg.data.name);
        } else if (seg.type === 'reply') out += '[引用]';
        else if (SEG_PLACEHOLDER[seg.type]) out += SEG_PLACEHOLDER[seg.type];
    }
    return out.replace(/[ \t]{2,}/g, ' ').trim();
}

// ---------- 机器人主动 @ ----------
/** 群成员名单缓存：昵称/群名片 → QQ，用来把回复里的 @名字 换成真 at 段 */
const memberListCache = new Map();
const MEMBER_LIST_CACHE_MAX = 100;
const MEMBER_LIST_TTL = 10 * 60 * 1000;

async function memberMapOf(gid) {
    const key = String(gid);
    const hit = memberListCache.get(key);
    if (hit && Date.now() < hit.exp) return hit;
    const map = new Map();
    const qqs = new Set();
    try {
        const list = await callApi('get_group_member_list', { group_id: Number(gid) });
        for (const m of Array.isArray(list) ? list : []) {
            const qq = String((m && m.user_id) || '');
            if (!qq) continue;
            qqs.add(qq);
            for (const n of [m.card, m.nickname, m.nick]) {
                const v = String(n || '').trim();
                if (v && !map.has(v)) map.set(v, qq);   // 同名取先出现的
            }
        }
    } catch (e) {
        // 取失败**不写缓存**：否则一次失败会让这个群 10 分钟都不做转换
        console.warn('[主动@] 取群成员失败，本次不做转换:', e.message);
        return { map, qqs, exp: 0 };
    }
    const val = { map, qqs, exp: Date.now() + MEMBER_LIST_TTL };
    cacheSet(memberListCache, key, MEMBER_LIST_CACHE_MAX, val);
    return val;
}

/**
 * 把回复文本里的 @某人 换成真正的 at 段（机器人主动 @）。
 *
 * 模型写出来的形式不固定，两种都要认：
 * - `@张三`（它从历史里看到过真名）—— 允许 @ 与名字之间夹空格/标点
 * - `@2233445`（它只看到过 QQ 号）—— 只要这个 QQ 确实在群里就转
 * 认不出的照原样留文字 —— 宁可 @ 不生效，也不能吞字、更不能 @ 错人。
 * @returns 消息段数组；没有可认的人时返回 null（调用方继续按纯文本发）
 */
async function segmentsWithMentions(text, gid) {
    const s = String(text ?? '');
    if (!gid || !s.includes('@')) return null;
    const { map, qqs } = await memberMapOf(gid);
    if (!map.size && !qqs.size) return null;
    const names = [...map.keys()].sort((a, b) => b.length - a.length);   // 长名优先，避免"小明"吃掉"小明明"
    const segs = [];
    let rest = s;
    while (rest) {
        const i = rest.indexOf('@');
        if (i < 0) { segs.push(segText(rest)); break; }
        if (i > 0) segs.push(segText(rest.slice(0, i)));
        const tail = rest.slice(i + 1);
        if (tail.startsWith('全体成员')) {
            segs.push(segAt('all'));
            rest = tail.slice('全体成员'.length);
            continue;
        }
        // 允许 "@ 张三"、"@、张三" 这类写法：只在匹配时跳过前导空白/标点，匹配不上原样保留
        const trimmed = tail.replace(/^[\s、,，.。!！?？~*]+/, '');
        const qm = trimmed.match(/^(\d{5,12})/);
        if (qm && qqs.has(qm[1])) {
            segs.push(segAt(qm[1]));
            rest = trimmed.slice(qm[1].length);
            continue;
        }
        const hit = names.find((n) => trimmed.startsWith(n));
        if (hit) {
            segs.push(segAt(map.get(hit)));
            rest = trimmed.slice(hit.length);
        } else {
            segs.push(segText('@'));   // 认不出：@ 当普通字符留下，后面的内容一字不动
            rest = tail;
        }
    }
    return segs.length ? segs : null;
}

/**
 * 群里昵称。退群/被踢的人已经不在群里，get_group_member_info 查不到，
 * 就退回陌生人资料，再退回 QQ 号 —— 提示里绝不能出现空白名字。
 */
async function memberName(gid, qq, memberLeft) {
    if (memberLeft) {
        try {
            const s = await callApi('get_stranger_info', { user_id: qq });
            const n = (s && (s.nick || s.nickname)) || '';
            if (n) return String(n);
        } catch { /* 查不到就往下退 */ }
    }
    return atDisplayName(gid, qq, '');
}

// ---------- 戳一戳：有人戳小钠就回一句 ----------
/** 回应开关（.env 的 POKE_REPLY，默认开） */
const POKE_REPLY = (process.env.POKE_REPLY || 'true') !== 'false';
/** 每个会话的冷却：连点不刷屏 */
const POKE_COOLDOWN_MS = 3000;
const pokeCooldown = new Map();
const POKE_LINES = [
    '别戳啦，再戳我可要咬人了',
    '戳我干嘛，有事说事',
    '哟，手痒了？',
    '我在这儿呢，别戳了',
    '再戳一下，我就记小本本上了',
];

/**
 * 回应戳一戳（OneBot notice：notice_type=poke，或 notify+sub_type=poke）。
 * 只有"戳的对象是小钠自己"才回应；私聊、群聊都回，群里会 @ 对方。
 */
async function onPoke(event) {
    if (!POKE_REPLY) return;
    const self = String(botId || '');
    const uid = String(event.user_id || '');
    const target = String(event.target_id || '');
    if (!uid) return;
    if (self && uid === self) return;              // 自己戳自己（一般不会推）
    if (self && target && target !== self) return; // 戳的是别人，不插嘴
    if (IGNORED_BOTS.has(uid)) return;             // 机器人互戳没意义

    const gid = event.group_id ? String(event.group_id) : '';
    const key = gid ? 'g:' + gid : 'p:' + uid;
    const now = Date.now();
    if (now - (pokeCooldown.get(key) || 0) < POKE_COOLDOWN_MS) return;
    pokeCooldown.set(key, now);
    if (pokeCooldown.size > 500) {
        for (const [k, v] of pokeCooldown) if (now - v > 60_000) pokeCooldown.delete(k);
    }

    const line = POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)];
    try {
        if (gid) {
            await callApi('send_group_msg', { group_id: Number(gid), message: [segAt(uid), segText(' ' + line)] });
        } else {
            await callApi('send_private_msg', { user_id: Number(uid), message: [segText(line)] });
        }
        console.log(`👉 [${gid ? `群 ${gid}` : `私聊 ${uid}`}] 戳一戳回应：${line}`);
    } catch (e) {
        console.error('[戳一戳] 回应失败:', e.message);
    }
}

/**
 * 进群 / 退群提示（OneBot 的 notice 事件）。
 * - 机器人自己进/退群不提示（自己退群时群已经发不出消息了）
 * - 已知机器人（Q群管家等）进/出不提示
 * - QQ_GROUP_NOTICE=false 可整体关闭
 */
async function onNotice(event) {
    const type = event.notice_type;
    // 戳一戳和进群/退群无关，也不该被 QQ_GROUP_NOTICE 关掉
    if (type === 'poke' || (type === 'notify' && event.sub_type === 'poke')) {
        await onPoke(event);
        return;
    }
    if (!QQ_GROUP_NOTICE) return;
    if (type !== 'group_increase' && type !== 'group_decrease') return;

    const gid = event.group_id;
    const uid = String(event.user_id || '');
    if (!gid || !uid) return;
    if (uid === String(botId)) return;
    if (IGNORED_BOTS.has(uid)) return;
    if (event.sub_type === 'kick_me') return;

    try {
        const joined = type === 'group_increase';
        const kind = joined ? '加入了群聊'
            : (event.sub_type === 'kick' ? '被移出了群聊' : '退出了群聊');
        const name = await memberName(gid, uid, !joined);
        // 退群/被踢 → 自动解绑：人都不在桥接群了，不该继续收到群内容。
        // 绑定本来就是在桥接群里做的，所以只对桥接群生效。
        let note = '';
        if (!joined && MC_BRIDGE_GROUP && String(gid) === MC_BRIDGE_GROUP) {
            const ub = forceUnbind(uid);
            if (ub.ok) {
                note = `（已自动解绑游戏ID：${ub.ids.join('、')}）`;
                console.log(`🚪 [群 ${gid}] 退群自动解绑 QQ ${uid}：${ub.ids.join('、')}`);
            }
        }
        const msg = joined
            ? [segAt(uid), segText(' 欢迎加入群聊！🎉')]
            : [segText(`👋 ${name} ${kind}${note}`)];
        await callApi('send_group_msg', { group_id: gid, message: msg });
        console.log(`🚪 [群 ${gid}] ${joined ? '进群' : '退群'}: ${name}(${uid})`);

        // 桥接群的进出也同步进游戏；同样只投给「已绑定游戏ID」的账号。
        // 没人绑定时不提示（进群退群是自然发生的，不是有人要用功能）
        if (MC_BRIDGE_QQ_TO_MC && MC_BRIDGE_GROUP && String(gid) === MC_BRIDGE_GROUP) {
            sendToBoundPlayers(`${name} ${kind}`);
        }
    } catch (e) {
        console.error('[进群退群提示] 发送失败:', e.message);
    }
}

// ---------- 进群申请 / 好友申请：转给主人，主人引用通知来同意或拒绝 ----------
/** 机器人私聊通知的 message_id → 待处理的申请（主人引用那条通知回复即可） */
const pendingReqs = new Map();
const PENDING_REQ_MAX = 100;
/** 通知过期时间：过期后引用它就不再被当成审批（避免很久以后误触） */
const PENDING_REQ_TTL = 30 * 60 * 1000;

/** 陌生人的昵称（不是群成员也能查） */
async function strangerName(qq) {
    try {
        const r = await callApi('get_stranger_info', { user_id: Number(qq) });
        return String((r && (r.nickname || r.nick)) || '');
    } catch {
        return '';
    }
}

const groupNameCache = new Map();
const GROUP_NAME_CACHE_MAX = 200;
const GROUP_NAME_TTL = 10 * 60 * 1000;

/** 读缓存里的群名（同步；控制台日志不能为了显示去等 NapCat） */
function cachedGroupName(gid) {
    const hit = groupNameCache.get(String(gid));
    return hit && Date.now() < hit.exp ? hit.name : '';
}

async function groupName(gid) {
    const key = String(gid);
    const hit = groupNameCache.get(key);
    if (hit && Date.now() < hit.exp) return hit.name;
    let name = '';
    try {
        const r = await callApi('get_group_info', { group_id: Number(gid) });
        name = String((r && r.group_name) || '');
    } catch { /* 取不到就只显示群号 */ }
    cacheSet(groupNameCache, key, GROUP_NAME_CACHE_MAX, { name, exp: Date.now() + GROUP_NAME_TTL });
    return name;
}

/** 后台补群名进缓存（不阻塞当前消息） */
function warmGroupName(gid) {
    if (!gid || cachedGroupName(gid)) return;
    groupName(gid).catch(() => {});
}

/**
 * 控制台用的消息来源标签：群号现成，群名只读缓存、没命中就后台补。
 * **绝不能在这里 await** —— 转发在它后面，日志慢一步转发就迟一步。
 */
function chatSource(event) {
    if (event.message_type === 'group') {
        const gid = String(event.group_id || '');
        if (gid) warmGroupName(gid);
        const name = gid ? cachedGroupName(gid) : '';
        return `群 ${gid}${name ? '「' + name + '」' : ''}`;
    }
    return `私聊 ${event.user_id}`;
}

/** 给 AI 用的来源标签：这里可以等（本来就在等模型），要把群名拿到 */
async function chatSourceForAi(event) {
    if (event.message_type !== 'group') return chatSource(event);
    const gid = String(event.group_id || '');
    const name = gid ? await groupName(gid) : '';
    return `群 ${gid}${name ? '「' + name + '」' : ''}`;
}

/** 私聊主人，并返回那条消息的 message_id（主人要靠引用它来回复） */
async function notifyOwnerWithId(msg) {
    const owner = perm.getOwner();
    if (!owner) {
        console.warn('[申请] 没设置主人，没法转发申请。用 #授权 设置主人后再试。');
        return '';
    }
    try {
        const r = await callApi('send_private_msg', { user_id: owner, message: [segText(msg)] });
        return String((r && (r.message_id || r.msg_id)) || '');
    } catch (e) {
        console.error('[申请] 通知主人失败:', e.message);
        return '';
    }
}

/**
 * 处理进群申请 / 好友申请：把申请内容私聊给主人，等主人引用那条通知回复。
 * 只做转发，**不自动同意** —— 加群加好友是往自己家里放人，必须由主人点头。
 */
async function onRequest(event) {
    if (!QQ_REQUEST_APPROVE) return;
    // 没配 BOT_OWNER：申请通知没人可发，功能等于停用，直接跳过（启动时已提示）
    if (!OWNER_ENABLED) return;
    const kind = String(event.request_type || '');
    const sub = String(event.sub_type || '');
    const uid = String(event.user_id || '');

    if (kind === 'group' && sub !== 'add' && sub !== 'invite') return;
    if (kind === 'friend' && sub !== 'add') return;
    if (kind !== 'group' && kind !== 'friend') return;
    if (!uid || uid === String(botId)) return;
    if (IGNORED_BOTS.has(uid)) return;

    try {
        const nick = await strangerName(uid);
        const who = nick ? `${nick}（${uid}）` : uid;
        const comment = String(event.comment || '').trim();
        const gid = String(event.group_id || '');

        const lines = [];
        if (kind === 'friend') {
            lines.push('🔔 好友申请');
        } else if (sub === 'invite') {
            lines.push('🔔 群邀请（邀请机器人进群）');
        } else {
            lines.push('🔔 进群申请');
        }
        lines.push(`👤 申请人：${who}`);
        if (kind === 'group' && gid) {
            const gn = await groupName(gid);
            lines.push(`👥 群：${gn ? `${gn}（${gid}）` : gid}`);
        }
        // 验证信息/问答原样转给主人，由主人判断（多数群的加群问题答案就在这里面）
        if (comment) lines.push(`📝 验证信息：${comment}`);
        lines.push('');
        lines.push('引用本条回复：');
        lines.push('  同意            → 放行');
        lines.push('  拒绝 [理由]     → 驳回（理由会带给对方）');
        lines.push(`不方便引用就发：#同意 ${uid}　或　#拒绝 ${uid} 理由`);

        const msgId = await notifyOwnerWithId(lines.join('\n'));
        if (!msgId) return;   // 没发出去就别记，免得引用一个不存在的 id
        cacheSet(pendingReqs, msgId, PENDING_REQ_MAX, {
            kind, sub, flag: String(event.flag || ''), uid, gid,
            label: `${kind === 'friend' ? '好友' : '群'}申请 ${who}`,
            at: Date.now(),
        });
        console.log(`📨 已把${kind === 'friend' ? '好友' : '进群'}申请转给主人：${who}`);
    } catch (e) {
        console.error('[申请] 处理失败:', e.message);
    }
}

/** 主人的回复里认出"同意/拒绝"（必须出现在开头，避免正常聊天被误判） */
function parseVerdict(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    let m = t.match(/^(同意|通过|批准|接受|可以|ok|OK|yes|Yes)\s*([\s\S]*)$/);
    if (m) return { approve: true, extra: m[2].trim() };
    m = t.match(/^(拒绝|不同意|驳回|不通过|不接受|reject|no|NO)\s*([\s\S]*)$/);
    if (m) return { approve: false, extra: m[2].trim() };
    return null;
}

/** 真正执行一次审批，返回给主人看的回执 */
async function applyVerdict(req, approve, extra) {
    const reason = extra || (approve ? '' : '主人拒绝了你的申请');
    if (req.kind === 'group') {
        const params = { flag: req.flag, sub_type: req.sub, approve };
        if (!approve) params.reason = reason;      // 同意时没有可填的字段，多写的字就丢掉
        await callApi('set_group_add_request', params);
    } else {
        const params = { flag: req.flag, approve };
        if (approve && extra) params.remark = extra;   // 同意好友时多写的就是备注名
        await callApi('set_friend_add_request', params);
    }
    return approve ? `✅ 已同意：${req.label}` : `🚫 已拒绝：${req.label}\n理由：${reason}`;
}

/**
 * 主人引用「申请通知」回复 → 执行同意/拒绝。
 * 只认私聊里主人自己发的、且引用了某条待处理通知的消息；其它情况返回 false 交给后面的流程。
 */
async function handleOwnerApproval(event, segments, text) {
    if (!QQ_REQUEST_APPROVE) return false;
    if (event.message_type !== 'private') return false;              // 只在私聊里审批
    if (perm.role(String(event.user_id)) !== 'owner') return false;  // 只有主人能批
    const replySeg = (Array.isArray(segments) ? segments : []).find((s) => s && s.type === 'reply');
    const quotedId = replySeg ? String((replySeg.data && replySeg.data.id) || '').trim() : '';
    if (!quotedId) return false;
    const req = pendingReqs.get(quotedId);
    if (!req) return false;
    if (Date.now() - req.at > PENDING_REQ_TTL) {
        pendingReqs.delete(quotedId);
        await sendReply(event, '⌛ 这条申请通知已经过期了，让对方重新申请一次吧。');
        return true;
    }
    const verdict = parseVerdict(text);
    if (!verdict) return false;   // 引用了但没写同意/拒绝：当普通聊天处理

    try {
        const receipt = await applyVerdict(req, verdict.approve, verdict.extra);
        pendingReqs.delete(quotedId);
        console.log(receipt.replace(/\n/g, ' '));
        await sendReply(event, receipt);
    } catch (e) {
        console.error('[申请] 执行失败:', e.message);
        await sendReply(event, `❌ 操作失败：${e.message}\n（申请可能已过期或被处理过，让对方重新申请）`);
    }
    return true;
}

/**
 * 手动审批（不想引用通知时用）：#同意 <QQ号> [备注] / #拒绝 <QQ号> [理由]
 * 只认私聊里的主人：申请详情里有别人的验证信息，不能贴在群里。
 * 同一个人若同时有好友申请和进群申请，两条一起处理，并在回执里写清楚。
 */
async function handleManualApproval(event, cmd, arg) {
    if (!QQ_REQUEST_APPROVE) return false;
    if (event.message_type !== 'private') {
        // 群里别处理：申请详情（QQ号、验证信息）不该公开
        await sendReply(event, '🔒 申请只在私聊里处理，私聊我发：#' + cmd.slice(1) + ' <QQ号>');
        return true;
    }
    if (perm.role(String(event.user_id)) !== 'owner') {
        await sendReply(event, '❌ 只有主人可以审批申请。');
        return true;
    }
    const m = String(arg || '').match(/^(\d{5,14})\s*([\s\S]*)$/);
    if (!m) {
        await sendReply(event, `❌ 用法：#${cmd.slice(1)} <QQ号> [备注或理由]`);
        return true;
    }
    const qq = m[1];
    const extra = String(m[2] || '').trim();
    const approve = cmd === '/同意';
    const hits = [...pendingReqs.entries()]
        .filter(([, r]) => r.uid === qq && Date.now() - r.at <= PENDING_REQ_TTL);

    if (!hits.length) {
        await sendReply(event, `❌ 没有 ${qq} 的待处理申请。\n可能已经过期（30 分钟）或已被处理，让对方重新申请；刚收到的申请请稍等几秒再试。`);
        return true;
    }
    const receipts = [];
    for (const [id, req] of hits) {
        try {
            receipts.push(await applyVerdict(req, approve, extra));
            pendingReqs.delete(id);
            console.log(`[申请] 手动审批 ${qq}：${approve ? '同意' : '拒绝'}`);
        } catch (e) {
            console.error('[申请] 手动审批失败:', e.message);
            receipts.push(`❌ ${req.label} 操作失败：${e.message}`);
        }
    }
    await sendReply(event, receipts.join('\n'));
    return true;
}

async function onMessage(event) {
    if (event.post_type !== 'message') return;

    // 忽略机器人消息（Q群管家等），不响应、不触发 AI
    if (isBotUser(event)) {
        console.log(`🤖 忽略机器人消息: ${event.user_id}`);
        return;
    }

    const segments = event.message;
    // 媒体段显示成 [图片]/[文件] 这类占位、@ 还原成 @昵称（同步，只读缓存，绝不等 NapCat —— 转发就在后面）
    const raw = inlineTextOf(segments, event.group_id);
    const atBot = wasAtBot(segments);

    const fromName = (event.sender && (event.sender.card || event.sender.nickname)) || '';
    const uid = String(event.user_id || '');
    console.log(`📩 [${chatSource(event)}]${fromName ? ' ' + fromName + ':' : ''} ${raw}`);

    // 桥接群消息（机器人自己的消息不转发；只转发群聊，私聊不转发）
    // 自己发的判定用 self_id 兜底：botId 在收到第一条事件前还是 0，那时会把机器人自己的消息也转发进游戏
    const me = String(event.self_id || botId || '');
    const isBridgeGroup = MC_BRIDGE_QQ_TO_MC && event.message_type === 'group'
        && MC_BRIDGE_GROUP && String(event.group_id) === MC_BRIDGE_GROUP
        && !(me && String(event.user_id) === me);

    let userInput = cleanMessage(raw);
    // 纯 @ 的消息没有文字，但它仍然是要转发的内容，不能在这里被丢掉
    if (!userInput && !(isBridgeGroup && hasForwardable(segments))) return;

    // #绑定 的图形验证码答案：先于命令/转发/AI 处理，
    // 否则验证码会被当成普通聊天转发进游戏、或交给 AI 回复
    if (userInput && !/^[#/]/.test(userInput)) {
        const cap = answerCaptcha(event.user_id, userInput);
        if (cap.handled) {
            await sendReply(event, cap.msg);
            return;
        }
    }

    // 主人引用「进群/好友申请通知」回复同意或拒绝：优先于命令与 AI 处理
    if (await handleOwnerApproval(event, segments, userInput)) return;

    if (userInput) {
        // 记录最近消息流（供 GUI 人工接管挑选会话）
        pushTakeoverMsg({ key: convKey(event), dir: 'in', from: String(event.user_id), text: raw || userInput, t: Date.now() });
        // 写入记忆（滑动窗口，角色 user）：带上发言人，历史里才分得清谁在说话
        recordMessage(convKey(event), 'user', userInput, { name: fromName || uid, qq: uid, isBot: isKnownBot(uid) });

        // 先判断是否命令：消息开头是 # 或 /，或消息中包含 "#指令"（如"小钠 #禁言 张三"）
        const cmdHit = userInput.match(/(?:^|[\s，,、]+)(#[^\s，,、]+)/);
        const cmdStart = cmdHit ? cmdHit.index + cmdHit[0].indexOf('#') : -1;
        if (userInput.startsWith('#') || userInput.startsWith('/') || cmdStart >= 0) {
            const cmdText = cmdStart >= 0 ? userInput.slice(cmdStart) : userInput;
            const handled = await handleCommand(event, cmdText).catch((e) => sendReply(event, '❌ 指令错误：' + e.message));
            if (handled !== false) return; // 是有效命令，已处理
            // 不符合命令格式（未知命令）：继续往下判断是否需要唤起 AI
        }
    }

    // 桥接群消息 → 注入游戏（命令已在上面 return 掉）
    // 仅投递给「已绑定游戏ID」的账号，没绑定的人收不到
    if (isBridgeGroup) {
        const who = (event.sender && (event.sender.card || event.sender.nickname)) || event.user_id;
        forwardGroupToMc(event, who);
    }

    if (!userInput) return; // 纯 @ 等无文字消息：转发完就结束，不参与 AI

    // 该会话已被人工接管：跳过 AI 自动回复（命令仍可执行，如 #恢复AI）
    if (takeoverOn(convKey(event))) return;

    // 彩蛋「摇一摇」：群里有人接词，小钠就接下句（不参与 AI）
    if (maybeShakeLine(event, userInput)) return;

    // AI 触发：私聊直接回；群聊需 @机器人、消息包含关键词"小钠"、或引用了机器人自己发的消息
    // 关键词不剥离，完整消息（含"小钠"）交给 AI，如"所以小钠你是谁啊"；只发"小钠"也回复
    let allowSkip = false;
    if (event.message_type === 'group') {
        const kw = /小钠/.test(raw);
        // "引用回应"：引用了机器人自己的发言 = 在跟它说话（主人审批的引用在那之前就 return 了，不受影响）
        const quoted = (!atBot && !kw) ? await quotedBot(segments, me) : false;
        const triggered = atBot || kw || quoted;

        if (triggered) {
            // 被明确叫到：开启/续期「唤起会话」——接下来的几条，即使没 @ 也没关键词，
            // 也继续交给 AI 判断是不是在跟它说话（就像真人被叫住后会接着聊）
            const k = convKey(event);
            engageSessions.set(k, {
                initiator: String(event.user_id),
                initLeft: ENGAGE_INITIATOR_LEFT,   // 首先唤起的人：最多再检查 3 条
                otherLeft: ENGAGE_OTHER_LEFT,      // 别人插嘴：只检查 1 条
                exp: Date.now() + ENGAGE_TTL,
            });
            // 只有"仅凭关键词撞上"的首次触发才需要判断；@/引用是明确在叫它，直接回
            allowSkip = kw && !atBot && !quoted;
            if (ENGAGE_DEBUG) console.log(`[唤起] ${k} 由 ${event.user_id} 唤起（续期）`);
        } else {
            // 没被叫到：看是不是处在「唤起会话」里
            const e = engageSessions.get(convKey(event));
            if (!e || Date.now() > e.exp) {
                if (e) engageSessions.delete(convKey(event));
                return;                       // 不在会话里：闲聊不参与
            }
            const isInitiator = String(event.user_id) === e.initiator;
            const left = isInitiator ? e.initLeft : e.otherLeft;
            if (left <= 0) {
                if (ENGAGE_DEBUG) console.log(`[唤起] ${convKey(event)} 额度用尽，本条不再参与（${isInitiator ? '唤起人' : '其他人'}）`);
                return;
            }
            if (isInitiator) e.initLeft -= 1; else e.otherLeft -= 1;
            e.exp = Date.now() + ENGAGE_TTL;   // 有来有往就续期
            allowSkip = true;                  // 交给 AI 判断"是不是在跟小钠说话"
            if (ENGAGE_DEBUG) console.log(`[唤起] ${convKey(event)} 跟进检查（${isInitiator ? '唤起人剩 ' + e.initLeft : '其他人剩 ' + e.otherLeft}）`);
        }
    }

    if (isSuspicious(userInput)) {
        await sendReply(event, '哈哈，我的小秘密就不告诉你啦～');
        return;
    }

    // AI 并发锁：一个会话同时只允许一个 AI 请求
    const key = convKey(event);
    if (aiBusy.get(key)) {
        await sendReply(event, '⏳ 上一条消息还在处理，请稍候再发～');
        return;
    }
    aiBusy.set(key, true);
    try {
        await runAI(event, userInput, allowSkip);
    } finally {
        aiBusy.delete(key);
    }
}

// AI 回复主流程（含搜索/语音/多条回复）
// allowSkip：只在"群里仅命中关键词"这种模糊触发下为 true，交给 AI 判断是否真的在叫它
async function runAI(event, userInput, allowSkip = false) {
    // 没配 AI_API_KEY：AI 对话整体停用（启动时已提示，这里静默跳过，不在群里刷屏）
    if (!AI_ENABLED) return;
    try {
        // 注入会话元数据（对话类型/昵称/身份/好感度/群头衔/时间等），格式与参考项目一致
        const meta = await getMemberMeta(event);
        // 对方是机器人：默认不接话（两个机器人互相刷屏没意义，也容易被判刷屏）。BOT_REPLY=true 可放开
        if (meta.isRobot && !BOT_REPLY) {
            console.log(`🤖 对方是机器人（${meta.name}），跳过回复`);
            return;
        }
        console.log('🤖 AI 决策中...');
        // 给模型看的那份文本：@ 后面用真昵称（这里可以等，反正接着就要等模型）
        const aiInput = await inlineTextOfForAi(event.message, event.group_id) || userInput;
        const metaLine = buildMetaLine(event, meta, wasAtBot(event.message), aiInput, await chatSourceForAi(event));
        const mem = memoryContext(convKey(event)); // 本会话已保存的多条记忆
        const result = await callAIWithDecision(metaLine, null, mem, SEARCH_ENABLED, allowSkip);
        let { reply, needSearch, searchKeyword, wantVoice } = result;

        // 智能跳过：只在"群里仅命中关键词"这种模糊触发下由 AI 判定；判定不是在叫它就不吭声
        if (result.skip) {
            console.log('🤐 AI 判断这条不是在叫小钠，跳过回复');
            return;
        }

        if (needSearch) {
            // AI 判定了要搜；万一它没给出关键词，就退回用用户原话当搜索词（清掉 @ 等噪音）
            const q = (searchKeyword || userInput || '').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim();
            if (q) {
                console.log(`🔍 AI 决定搜索: "${q}"`);
                const searchResults = await getSearchContext(q, 5);
                // 第二轮不再让它判断要不要搜（已经搜完了），只让它据此作答
                const finalResult = await callAIWithDecision(metaLine, searchResults, mem, false);
                reply = finalResult.reply;
                wantVoice = finalResult.wantVoice;
            }
        }

        // 逐条清洗（去掉方括号等），保留 AI 拆出的多条
        let parts = splitReplies(reply)
            .map((t) => t.replace(/\[[^\]]+\]/g, '').trim())
            .filter(Boolean);
        if (!parts.length) { parts = ['嗯？我没听懂，能再说一遍吗？']; wantVoice = false; }
        if (parts.some((t) => t.includes('[') || t.includes(']'))) {
            parts = ['这个我发不了，重新说一遍？'];
            wantVoice = false;
        }

        // 多条回复：只有第一条带 @，后面几条不重复 @，免得刷屏
        const withAt = event.message_type === 'group';
        for (let i = 0; i < parts.length; i++) {
            await sendReply(event, parts[i], i === 0 ? wantVoice : false, withAt && i === 0);
            if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 700));
        }
        // 写入记忆（滑动窗口，角色 ai）
        const finalReply = parts.join('\n');
        recordMessage(convKey(event), 'ai', finalReply);
        console.log(`✅ 回复已发送 (${parts.length} 条，语音:${wantVoice})`);
    } catch (err) {
        console.error('❌ 处理异常:', err);
        await sendReply(event, '抱歉，我遇到技术问题，稍后再试。').catch(() => {});
    }
}

// ---------- MC 桥：游戏内提问 → 本机 AI → 回投游戏 ----------
function mcTimeStr(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
        + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 游戏内玩家提问（公聊关键词触发 / /xn 私聊）走本机 AI，返回回复文本 */
const mcAiBusy = new Set();
async function askAiFromMc({ player, text, isPrivate }) {
    const key = 'mc:' + player;
    // 游戏内 AI 并发锁：和 QQ 侧一样，同一玩家同时只允许一个请求
    if (mcAiBusy.has(key)) {
        console.log(`⏳ 游戏内 ${player} 上一条还在处理，本次跳过 AI`);
        return '';
    }
    mcAiBusy.add(key);
    try {
        return await askAiFromMcInner(key, player, text, isPrivate);
    } finally {
        mcAiBusy.delete(key);
    }
}

async function askAiFromMcInner(key, player, text, isPrivate) {
    // 没配 AI_API_KEY：游戏内也停用 AI，私聊回一句说明，公聊直接不吭声
    if (!AI_ENABLED) return isPrivate ? '小钠没开 AI，答不了话。' : '';

    // MC 玩家没有 QQ 号，直接按参考项目的元数据格式拼一行，不做 NapCat 成员查询
    const metaLine = `[当前对话:${isPrivate ? '游戏私聊' : '游戏公聊'}|对话ID:${key}]`
        + `[名称:${player}| QQ:-|身份:成员|好感度:50%|群头衔:-|msgId:0|时间:${mcTimeStr()}]`
        + `消息内容:[ ${player}: ${text} ]`;

    recordMessage(key, 'user', text, { name: player, qq: '' });
    const mem = memoryContext(key);

    let result = await callAIWithDecision(metaLine, null, mem, SEARCH_ENABLED);
    if (result.needSearch) {
        // 没给关键词就退回用玩家原话
        const q = (result.searchKeyword || text || '').replace(/\s+/g, ' ').trim();
        if (q) {
            console.log(`🔍 游戏内 AI 决定搜索: "${q}"`);
            const searchResults = await getSearchContext(q, 5);
            result = await callAIWithDecision(metaLine, searchResults, mem, false);
        }
    }

    let reply = String(result.reply || '').replace(/\[[^\]]+\]/g, '').trim();
    if (!reply) reply = '嗯？我没听懂，能再说一遍吗？';
    if (reply.includes('[') || reply.includes(']')) reply = '这个我发不了，重新说一遍？';
    recordMessage(key, 'ai', reply);
    return reply;
}

// ---------- 桥接群消息 → 游戏（只投给已绑定游戏ID的账号） ----------
let bindHintAt = 0;
/** @ 昵称缓存：groupId:qq -> {name, exp}（有过期时间，也要封顶） */
const atNameCache = new Map();
const AT_NAME_CACHE_MAX = 500;

/** 消息里是否有值得转发进游戏的内容（文字 / @ / 图片 / 表情） */
function hasForwardable(segments) {
    if (!Array.isArray(segments)) return !!String(segments || '').trim();
    return segments.some((s) => s && s.data && (
        (s.type === 'text' && String(s.data.text || '').trim())
        || s.type === 'at' || s.type === 'image' || s.type === 'face' || s.type === 'mface'
    ));
}

/** 群里昵称（备注名 > 昵称 > QQ号）；查不到也不能把 @ 弄丢 */
async function atDisplayName(groupId, qq, inline) {
    if (inline && String(inline).trim()) return String(inline).trim();   // NapCat 有时直接带 name
    const key = groupId + ':' + qq;
    const c = atNameCache.get(key);
    if (c && Date.now() < c.exp) return c.name;
    let name = '';
    try {
        const m = await callApi('get_group_member_info', { group_id: groupId, user_id: qq });
        name = (m && (m.card || m.nickname)) || '';
    } catch { /* 查询失败则退回 QQ 号 */ }
    name = String(name || qq);
    cacheSet(atNameCache, key, AT_NAME_CACHE_MAX, { name, exp: Date.now() + META_TTL });
    return name;
}

// 引用消息原文缓存：reply 段只有 message_id，得回头查一次原文
const replyCache = new Map();
const REPLY_CACHE_MAX = 200;

/** 被引用的 message_id → 发送者 QQ（5 分钟缓存）：用来判断"引用的这条是不是机器人自己发的" */
const quotedSender = new Map();
const QUOTED_SENDER_MAX = 200;

/**
 * 这条消息是不是"引用了机器人自己发的消息"。
 * 群里被引用 = 在跟机器人说话，即使没喊"小钠"也应该回应。
 * 注意：主人引用「进群/好友申请通知」的审批走 handleOwnerApproval，在那之前就已经 return 掉了，
 * 不会走到这里 —— 两套"引用"逻辑互不干扰。
 */
async function quotedBot(segments, me) {
    const self = String(me || '');
    if (!self) return false;
    const seg = (Array.isArray(segments) ? segments : []).find((s) => s && s.type === 'reply');
    const id = seg && seg.data ? String(seg.data.id || seg.data.message_id || '').trim() : '';
    if (!id) return false;
    const hit = quotedSender.get(id);
    if (hit && Date.now() < hit.exp) return hit.uid === self;
    let uid = '';
    try {
        const m = await callApi('get_msg', { message_id: /^\d+$/.test(id) ? Number(id) : id });
        uid = String((m && m.sender && m.sender.user_id) || '');
    } catch (e) {
        // 查不到（已删除/过期）就当成"不是机器人"，退化成原来的行为
    }
    cacheSet(quotedSender, id, QUOTED_SENDER_MAX, { uid, exp: Date.now() + 5 * 60 * 1000 });
    return uid === self;
}

/** 把长文本压成一行短预览 */
function clip(text, max = 60) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * QQ 引用段 → "[引用 谁: 原文] "
 * 引用段只带 message_id，原文要用 get_msg 反查；查不到就退化成 [引用]，
 * 绝不因为查不到而把整条消息弄丢。
 */
async function replyPreview(data, groupId, depth = 0) {
    const id = String((data && (data.id || data.message_id)) || '').trim();
    if (!id) return '[引用] ';
    const hit = replyCache.get(id);
    if (hit && Date.now() < hit.exp) return hit.text;

    let text = '[引用] ';
    try {
        const m = await callApi('get_msg', { message_id: /^\d+$/.test(id) ? Number(id) : id });
        const who = (m && m.sender && (m.sender.card || m.sender.nickname)) || '';
        // 引用的原文同样渲染（含 @ / 图片 / 表情），但只允许再嵌一层，避免套娃
        const body = depth < 1
            ? await buildForwardText(m && m.message, groupId, depth + 1)
            : extractText(m && m.message);
        text = `[引用 ${who ? who + ': ' : ''}${clip(body)}] `;
    } catch (e) {
        console.debug('[MC桥] 引用原文查询失败:', e.message);
    }
    cacheSet(replyCache, id, REPLY_CACHE_MAX, { text, exp: Date.now() + 5 * 60 * 1000 });
    return text;
}

/**
 * 把消息段渲染成转发进游戏的文本。
 * - @ 段不能丢：它承载着"这句话是说给谁听的"，只取文字段等于没转发
 * - 引用段：带出被引用的原文（[引用 谁: 原文]）
 * - 图片 / 表情 / 语音 / 视频 / 文件：只发文字占位（游戏里放不出这些东西）
 * - 文本段原样保留（不做 cleanMessage 的剥离，转发要忠实于原消息）
 */
async function buildForwardText(segments, groupId, depth = 0) {
    if (!Array.isArray(segments)) return String(segments || '').trim();
    let out = '';
    for (const seg of segments) {
        if (!seg || !seg.data) continue;
        if (seg.type === 'text') {
            out += seg.data.text || '';
        } else if (seg.type === 'at') {
            const qq = String(seg.data.qq || '');
            if (qq === 'all') out += '@全体成员';
            else out += '@' + await atDisplayName(groupId, qq, seg.data.name);
        } else if (seg.type === 'reply') {
            out += await replyPreview(seg.data, groupId, depth);
        } else if (SEG_PLACEHOLDER[seg.type]) {
            out += SEG_PLACEHOLDER[seg.type];
        }
    }
    // 段与段之间（尤其引用段前后）可能各带一个空格，合并掉避免出现双空格
    return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 只投递给「已绑定游戏ID」的账号：一次请求带上全部目标，避免发 N 次请求。
 * 返回是否有接收者（false 表示一个都没绑定）；投递结果异步处理，失败只记日志。
 */
function sendToBoundPlayers(text) {
    const receivers = getReceivers();
    if (!receivers.length) {
        console.log('[MC桥] 群里没人绑定游戏ID，这条没进游戏（群里已有 #绑定 提示）');
        return false;
    }
    sendToMc(text, { players: receivers, prefix: '[QQ] ' })
        .then((r) => {
            if (!r) return;
            if (!r.ok) {
                console.error('[MC桥] 投递失败:', r.error || '未知原因');
                return;
            }
            // 投递成功但一个都没送到：绑定的游戏ID 不在线，或名字对不上（大写/改名）
            if (r.delivered === 0) {
                console.log(`[MC桥] 投递 0 人（绑定：${receivers.join('、')}）—— 不在线或名字对不上`);
            }
        })
        .catch((e) => console.error('[MC桥] 投递异常:', e.message));
    return true;
}

/**
 * 转发桥接群消息进游戏。
 *
 * 渲染要查 @ 昵称/引用原文（可能走 NapCat），必须异步；但**必须排队**：
 * 每条消息各自并发跑的话，慢的那条会被后面的抢先，游戏里看到的就是乱序 + 延迟。
 * 所以这里串成一条 FIFO 链，保证先说的先进游戏（某条失败也不会把链掐断）。
 */
let mcForwardQueue = Promise.resolve();
function forwardGroupToMc(event, who) {
    mcForwardQueue = mcForwardQueue
        .then(() => buildForwardText(event.message, event.group_id))
        .then((text) => {
            if (!text) return;
            if (!sendToBoundPlayers(`${who}: ${text}`)) hintNobodyBound();
        })
        .catch((e) => console.error('[MC桥] 转发内容渲染失败:', e.message));
}

// ---------- 彩蛋：摇一摇对答 ----------
/** 同一会话的接话间隔，避免有人刷屏把机器人刷爆 */
const SHAKE_COOLDOWN = 2000;
/** 隔太久就当新起一段，不拿旧上下文接话 */
const SHAKE_CTX_TTL = 5 * 60 * 1000;
const shakeAt = new Map();    // 会话 → 上次接话时间
const shakeCtx = new Map();   // 会话 → { index, at }

/**
 * 群成员发「摇一摇」系列任一行 → 小钠接下一行。
 * 返回 true 表示已处理（不再往下走 AI）。
 */
function maybeShakeLine(event, text) {
    if (event.message_type !== 'group') return false;          // 只跟群成员对答
    // 机器人自己发的不接（self_id 与发送者相同即自己），否则会自己接自己、无限循环
    const me = String(event.self_id || botId || '');
    if (me && String(event.user_id) === me) return false;

    const key = convKey(event);
    const now = Date.now();
    const ctx = shakeCtx.get(key);
    const lastSent = ctx && now - ctx.at <= SHAKE_CTX_TTL ? ctx.index : -1;
    const hit = nextShakeLine(text, lastSent);
    if (!hit) return false;

    const prev = shakeAt.get(key);
    if (prev !== undefined && now - prev < SHAKE_COOLDOWN) return true;   // 冷却中：认出来了但先不接
    shakeAt.set(key, now);
    shakeCtx.set(key, { index: hit.index, at: now });
    console.log(`🎋 彩蛋接话 [群 ${event.group_id}] → ${hit.line}`);
    sendReply(event, hit.line).catch((e) => console.error('[彩蛋] 接话失败:', e.message));
    return true;
}

/** 一个都没绑定时提示一次（全局限频，避免群聊刷屏） */
function hintNobodyBound() {
    const now = Date.now();
    if (now - bindHintAt < 10 * 60 * 1000) return;
    bindHintAt = now;
    callApi('send_group_msg', {
        group_id: Number(MC_BRIDGE_GROUP),
        message: [segText('ℹ️ 还没有人绑定游戏ID，群消息暂时不会转发进游戏。\n发送 #绑定 <游戏ID> 绑定后即可收到。')],
    }).catch(() => {});
}

// ---------- #状态：服务器 + 机器人 ----------
/** 秒 → 3小时12分 / 12分34秒 */
function uptimeText(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分${s % 60}秒`;
    return `${s}秒`;
}

/**
 * 拼状态文本。数据全部由调用方取好传进来（不在这里发请求），方便单独验证。
 * @param {object} d 见 doStatus
 * @param {boolean} admin 主人/管理员可见端口与主人QQ
 */
function formatStatus(d, admin) {
    const out = ['📊 小钠状态', ''];

    out.push('🖥 服务器（MC）');
    out.push(`· 桥接：${d.mc.connected ? '已连接' : '未连接'}${d.mc.status ? '' : '（服务器未开或密钥不对）'}`);
    if (d.mc.status) {
        const st = d.mc.status;
        out.push(`· 桥版本：${st.version || '?'}`);
        out.push(`· 开关：整机 ${st.enabled ? '开' : '关'}｜游戏→本机 ${st.chatToBridge ? '开' : '关'}｜本机→游戏 ${st.bridgeToChat ? '开' : '关'}`);
        out.push(`· 私聊命令：/${st.privateCommand || 'xn'}`);
        if (admin && st.sharePort) out.push(`· 端口：对外 ${st.sharePort}（桥 ${st.localPort}）`);
    }
    if (d.mc.players.length) {
        const shown = d.mc.players.slice(0, 10)
            .map((p) => `${p.name}${p.op ? '[OP]' : ''}`).join('、');
        const more = d.mc.players.length > 10 ? ` 等 ${d.mc.players.length} 人` : '';
        out.push(`· 在线 ${d.mc.players.length} 人：${shown}${more}`);
    } else if (d.mc.connected) {
        out.push('· 在线 0 人');
    }

    out.push('', '🤖 机器人');
    out.push(`· NapCat：${d.bot.connected ? '已连接' : '未连接'}${d.bot.error ? '（' + String(d.bot.error).slice(0, 40) + '）' : ''}`);
    out.push(`· 模型：${d.bot.model}`);
    out.push(`· 已绑定游戏ID：${d.bot.boundGameIds} 个`);
    out.push(`· 运行：${uptimeText(d.bot.uptimeSec)}`);
    if (d.bot.ownerHome) out.push(`· 主人主页：${d.bot.ownerHome}`);
    if (admin) {
        out.push(`· NapCat 地址：${d.bot.wsUrl}`);
        out.push(`· 主人：${d.bot.owner || '未设置'}｜已授权 ${d.bot.authorized} 人`);
        out.push(`· 面板：http://${d.bot.webuiHost}:${d.bot.webuiPort}`);
    }
    return out.join('\n');
}

/** 采集真实数据后拼状态（任何一项取不到都不影响整体） */
async function doStatus(role) {
    const admin = role === 'owner' || role === 'admin';
    let status = null, players = [];
    try { status = await getBridgeStatus(); } catch { /* 服务器不可达：只显示未连接 */ }
    if (status) {
        try { players = await getPlayers(true); } catch { players = []; }
    }
    let boundGameIds = 0;
    try { boundGameIds = getReceivers().length; } catch { /* ignore */ }

    let authorized = 0;
    try { authorized = perm.listAuthorized().length; } catch { /* ignore */ }

    return formatStatus({
        mc: { connected: isMcConnected(), status, players },
        bot: {
            connected: !!bot.connected,
            error: bot.lastError,
            model: process.env.AI_MODEL || 'deepseek-chat',
            boundGameIds,
            uptimeSec: process.uptime(),
            wsUrl: process.env.NAPCAT_WS || 'ws://127.0.0.1:3001',
            owner: perm.getOwner(),
            ownerHome: (process.env.BOT_OWNER_HOME || '').trim(),
            authorized,
            webuiHost: process.env.WEBUI_HOST || '127.0.0.1',
            webuiPort: process.env.WEBUI_PORT || '8080',
        },
    }, admin);
}

// ---------- #查询：Plan 玩家数据 ----------
/**
 * 把 Plan 的玩家数据摊成群里能看的几行。
 *
 * Plan 把主要指标放在返回体的 `info` 里（playtime / last_seen / activity_index / *_ping 等，
 * 时间都是毫秒），顶层还有 kill_data、sessions。这里 info 优先、顶层兜底，
 * 认不出的字段不硬编：写日志留证据，群里只给一句提示，免得甩一大坨 JSON 刷屏。
 */
function formatPlanPlayer(name, p) {
    const root = p && typeof p === 'object' ? p : {};
    // info 里的字段覆盖顶层同名/同义字段（不同 Plan 版本放的位置不一样，两种都认）
    const data = root.info && typeof root.info === 'object' ? { ...root, ...root.info } : root;
    const pick = (...keys) => {
        for (const k of keys) {
            const v = data[k];
            if (v !== undefined && v !== null && v !== '') return v;
        }
        return null;
    };
    // 时间戳/时长：0 或负数一律当"没有"，否则 last_seen=0 会显示成 1970 年
    const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    // 计数（击杀/死亡/会话数）：0 是有效值，不能当成"没有"
    const intOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const dur = (ms) => {
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s} 秒`;
        if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
        const h = Math.floor(s / 3600);
        if (h < 24) return `${h} 小时 ${Math.floor((s % 3600) / 60)} 分`;
        return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
    };
    const when = (ms) => {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const playerName = pick('name', 'playerName', 'player_name') || name;
    const playtime = numOf(pick('playtime', 'active_playtime', 'playtimeMs'));
    const lastSeen = numOf(pick('last_seen', 'lastSeen', 'last_seen_raw_value'));
    const registered = numOf(pick('registered', 'registerDate', 'firstSeen'));
    const activity = numOf(pick('activity_index', 'activityIndex'));
    const sessionCount = intOf(pick('session_count'));
    const median = numOf(pick('session_median'));
    const longest = numOf(pick('longest_session_length'));
    const kills = intOf(pick('player_kill_count'));
    const mobKills = intOf(pick('mob_kill_count'));
    const deaths = intOf(pick('death_count'));
    const best = intOf(pick('best_ping'));
    const avg = numOf(pick('average_ping'));
    const worst = intOf(pick('worst_ping'));
    const uuid = pick('uuid');

    const rows = [];
    if (playtime != null) rows.push(`· 总时长：${dur(playtime)}`);
    if (activity != null) rows.push(`· 活跃指数：${activity.toFixed(1)} / 5`);
    if (registered != null) rows.push(`· 首次加入：${when(registered)}`);
    if (sessionCount != null) {
        rows.push(`· 会话：${sessionCount} 次`
            + (median != null ? ` ｜ 中位 ${dur(median)}` : '')
            + (longest != null ? ` ｜ 最长 ${dur(longest)}` : ''));
    }
    if (kills != null || mobKills != null || deaths != null) {
        rows.push(`· 击杀：玩家 ${kills ?? 0} ｜ 怪物 ${mobKills ?? 0} ｜ 死亡 ${deaths ?? 0}`);
    }
    if (best != null || avg != null || worst != null) {
        rows.push(`· 延迟：最好 ${best ?? '?'}ms ｜ 平均 ${avg ?? '?'}ms ｜ 最差 ${worst ?? '?'}ms`);
    }
    if (data.operator === true) rows.push('· 身份：管理员');
    if (uuid) rows.push(`· UUID：${uuid}`);

    if (!rows.length) {
        // 换了 Plan 版本/字段名对不上时，别在群里刷一大坨 JSON，写日志方便补字段
        console.warn('[Plan] 字段没认出来，原始返回（前 1000 字）：', JSON.stringify(root).slice(0, 1000));
        return `📊 ${playerName}：取到了 Plan 数据，但字段没认出来，已记到机器人日志。`;
    }
    const state = data.online === true ? '在线' : '离线';
    const ban = data.banned === true ? '⛔ 已被封禁 ｜ ' : '';
    return `📊 ${playerName} 的 Plan 数据\n`
        + `· 状态：${ban}${state}${lastSeen != null ? ` ｜ 最后在线 ${when(lastSeen)}` : ''}\n`
        + rows.join('\n');
}

// ---------- 记忆指令（每会话可保存多条） ----------
function handleMemoryCmd(event, cmd, arg) {
    const key = convKey(event);
    if (cmd === '/记住') {
        const text = arg.trim();
        if (!text) return sendReply(event, '❌ 用法：#记住 <要记住的内容>');
        const n = addMemory(key, text);
        recordMessage(key, 'system', `保存长期记忆：${text.slice(0, 50)}`);
        return sendReply(event, `🧠 已存入长期记忆（本会话共 ${n} 条）：${text.slice(0, 50)}`);
    }
    if (cmd === '/记忆') {
        const kw = arg.trim();
        if (kw) {
            const hit = searchMemory(key, kw);
            return sendReply(event, hit ? `🔍 搜索"${kw}"结果：\n${hit}` : `❌ 没有找到包含 "${kw}" 的记忆。`);
        }
        const list = listMemory(key);
        if (!list.length) return sendReply(event, '🧠 本会话暂无长期记忆。可用 #记住 <内容> 让我记住。');
        const lines = list.map((m, i) => `${i + 1}. ${m.text}`);
        return sendReply(event, '🧠 本会话长期记忆：\n' + lines.join('\n'));
    }
    if (cmd === '/忘记') {
        const idx = Number(arg.trim());
        if (!Number.isInteger(idx) || idx < 1) return sendReply(event, '❌ 用法：#忘记 <序号>（用 #记忆 查看序号）');
        return removeMemory(key, idx)
            ? (recordMessage(key, 'system', `删除第 ${idx} 条长期记忆`), sendReply(event, `🗑️ 已删除第 ${idx} 条记忆。`))
            : sendReply(event, `❌ 没有第 ${idx} 条记忆。`);
    }
    // /清除记忆
    clearMemory(key);
    recordMessage(key, 'system', '清空全部记忆');
    return sendReply(event, '🗑️ 已清空本会话的全部记忆。');
}

// ---------- 主人改昵称 / 换头像（NapCat 扩展接口 set_qq_profile / set_qq_avatar） ----------
async function handleProfile(event, cmd, arg, r) {
    if (r !== 'owner') return sendReply(event, '❌ 仅主人可执行该操作。');
    try {
        if (cmd === '/换名') {
            const nickname = arg.trim();
            if (!nickname) return sendReply(event, '❌ 用法：#换名 新昵称');
            await callApi('set_qq_profile', { nickname });
            return sendReply(event, `✅ 昵称已改为：${nickname}`);
        }
        // 换头像：优先取消息中的图片，其次参数（路径/URL）；统一为本地文件后裁剪为正方形
        const imgs = (Array.isArray(event.message) ? event.message : [])
            .filter((s) => s.type === 'image' && s.data && s.data.file)
            .map((s) => s.data.file);
        const file = (imgs[0] || arg.trim());
        if (!file) return sendReply(event, '❌ 用法：#换头像 图片消息，或 #换头像 <图片路径/URL>');
        await sendReply(event, '✂️ 正在裁剪图片并更换头像…');
        let src = file;
        if (/^file:\/\//i.test(file)) src = file.replace(/^file:\/\/+/i, '');
        else if (/^https?:\/\//i.test(file)) src = await downloadToFile(file);
        else if (/^base64:\/\//i.test(file)) src = base64ToFile(file);
        if (!fs.existsSync(src)) throw new Error('图片文件不存在或无法读取');
        const cacheDir = path.join(SAVE_DIR, 'cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        // 裁剪缓存：按源文件信息哈希复用，避免重复处理
        const stat = fs.statSync(src);
        const hash = crypto.createHash('sha1').update(src).update(String(stat.size)).update(String(stat.mtimeMs)).digest('hex').slice(0, 16);
        const cachePath = path.join(cacheDir, `av-${hash}.png`);
        const cropped = fs.existsSync(cachePath) ? cachePath : await cropSquare(src, cacheDir, cachePath);
        await callApi('set_qq_avatar', { file: cropped });
        return sendReply(event, '✅ 头像已裁剪为正方形并提交，稍后生效。');
    } catch (e) {
        const msg = String(e.message || '');
        if (/不支持|未实现|未知|not support|unknown/i.test(msg)) {
            return sendReply(event, '❌ 当前 NapCat/QQ 版本不支持该功能。');
        }
        return sendReply(event, `❌ 操作失败：${msg.slice(0, 200)}`);
    }
}

// 下载网络图片到本地缓存
async function downloadToFile(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('图片下载失败');
    const buf = Buffer.from(await res.arrayBuffer());
    const dir = path.join(SAVE_DIR, 'cache');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'avatar-' + Date.now() + '.img');
    fs.writeFileSync(f, buf);
    return f;
}

// base64:// 数据解码为本地文件
function base64ToFile(data) {
    const buf = Buffer.from(data.replace(/^base64:\/\//i, ''), 'base64');
    const dir = path.join(SAVE_DIR, 'cache');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'avatar-' + Date.now() + '.img');
    fs.writeFileSync(f, buf);
    return f;
}

// ---------- WebSocket 生命周期 ----------
function connect() {
    const headers = WS_TOKEN ? { Authorization: `Bearer ${WS_TOKEN}` } : {};
    ws = new WebSocket(WS_URL, { headers });

    ws.on('open', () => { setBotConnected(true); setBotError(''); console.log(`[连接] 已连接 NapCat: ${WS_URL}`); });

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (data.echo && pending.has(data.echo)) {
            const p = pending.get(data.echo);
            pending.delete(data.echo);
            if (data.status === 'ok') p.resolve(data.data); else p.reject(new Error(JSON.stringify(data)));
            return;
        }
        if (data.post_type) {
            if (!botId && data.self_id) botId = data.self_id;
            const handler = data.post_type === 'notice' ? onNotice
                : data.post_type === 'request' ? onRequest
                : onMessage;
            handler(data).catch((e) => console.error('[处理]', e));
        }
    });

    ws.on('error', (err) => { setBotError(err.message); console.error('[连接] 错误:', err.message); });
    ws.on('close', () => {
        setBotConnected(false);
        console.log('[连接] 已断开，3秒后重连…');
        setTimeout(connect, 3000);
    });
}

if (WS_TOKEN === 'your_napcat_token') {
    console.warn('⚠️  请确认 .env 中 NAPCAT_TOKEN 与 NapCat WS 设置一致（当前未启用 token）。');
}
console.log(AI_ENABLED ? `模型: ${process.env.AI_MODEL || 'deepseek-chat'}` : '模型: （未配置，AI 对话不可用）');
logFeatureStates();
connect();

// 启动网页控制面板（非阻塞）；授权由主人管理，面板通知走主人回调
setOwnerNotifier(notifyOwner);
// 供 WebUI 人工接管发送消息
setSendMsg((action, params) => callApi(action, params));
if (WEBUI_ENABLED) {
    startWebUI().catch((e) => console.error('❌ WebUI 启动失败:', e.message));
} else {
    console.log('未配置 WEBUI_PASSWORD，网页控制面板已停用（.env 里补上即自动启用）。');
}

// 启动与 Minecraft 服务器侧 mod 的桥：接收游戏聊天/进出服事件，并把回复注入游戏
// 计分板不在这里推：玩家上线时由桥逐人回一条"是否已绑定"（见 mcbridge 的 bindCheck）
if (MC_ENABLED) {
    startMcBridge({ callApi, segText, askAi: askAiFromMc, getBoundIds: getReceivers });
} else {
    console.log('未配置 MC_BRIDGE_URL / MC_BRIDGE_SECRET，MC 服务器桥已停用。');
}

process.on('SIGINT', () => { console.log('\n退出。'); process.exit(0); });