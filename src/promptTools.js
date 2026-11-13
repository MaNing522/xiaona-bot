// ============================================================
// promptTools.js - 程序侧系统提示词（工具 / 权限 / 记忆 / MC 桥）
//
// prompt.txt 只留「人设与说话风格」；凡是跟程序行为有关的内容都放这里，
// 由代码按当前身份、场景、服务器能力动态拼接，避免提示词里写死实现细节
// （工具名、权限档位、主人的 QQ 号、桥接玩法），也不会出现"模型看得见但调不了"的工具。
//
// 拼接顺序（index.js 的 getSystemPrompt）：
//   prompt.txt（风格） + 【这台服务器的运行环境】 + 【你能用的工具】 + 【身份与权限】
//   + 【记忆与上下文】 + 【Minecraft 服务器】
// ============================================================
import { AGENT_TOOLS, ROLE_RANK } from './agent.js';

/** 工具的一句话用途（给模型看的摘要；详细参数在 tools schema 里，不在这里重复） */
const TOOL_HINTS = {
    web_search: '联网搜索外部实时信息（天气、新闻、比分、价格、软件版本等）。闲聊、常识、算数、翻译不要用',
    analyze_image: '读懂本条消息里的图片（画面内容、截图里的报错/文字 OCR）。只有本条消息带 [图片] 时才用',
    mc_status: '查 Minecraft 服务器状态/在线玩家。查自己的服不填参数，查别人的服填地址；**查 MC 服务器一律用它，不要用 web_search**',
    player_query: '查某个玩家的游玩时长、最后在线等统计数据（来自服务器 Plan 插件）',
    ai_balance: '查 AI 服务商账户余额（账务信息）',
    mc_command: '在 Minecraft 服务器上执行命令（tp / give / gamemode / time 等，受白名单限制），只对明确要求改游戏状态的人用',
    adjust_favor: '按对方的表现小幅调整好感度（±1~5，同一轮最多一次，别报数值给对方）',
    sing: '唱 4~8 句歌：歌词放 lyrics，先搜歌词再唱（`web_search 歌名 歌词`）；系统会合成语音直接发出',
    remember: '把值得长期记住的事存进记忆（对方明确要求记住、或确实值得长期保存时）',
    recall_memory: '按关键词检索以前记住的内容',
    write_note: '把资料写进本地笔记（data/notes/），适合清单、长文本等需要长期留存的内容',
    read_note: '读本地笔记；不填文件名则列出全部',
    sleep: '等一会儿再说（最多 30 秒）。只在对方说“等我一下”、确实该隔一会儿再回时用，别拿它拖正常回复',
    read_history: '拉取当前这个人以前和你聊过的记录（按人存，跨群/私聊/游戏）。不确定拉多少条就别填 count，系统按默认值给；不要每轮都拉',
};

/** 身份的中文名（提示词里用，不要直接用英文 key 喂给模型） */
const ROLE_LABEL = { guest: '普通用户', authorized: '授权用户', admin: '管理员', master: '主人', owner: '所有者' };

/** 当前身份能用哪些工具（与 toolsForRole 的过滤规则保持一致） */
function usableTools(role, caps = {}) {
    const rank = ROLE_RANK[role] ?? 0;
    return AGENT_TOOLS.filter((t) => {
        if ((ROLE_RANK[t.minRole] ?? 0) > rank) return false;
        if (t.requires === 'plan' && caps.plan === false) return false;
        return true;
    }).map((t) => t.function.name);
}

/** 运行环境：MC 服务器地址与会话场景（群 / 私聊 / 游戏） */
function runtimeSection({ serverInfo, scene }) {
    const lines = [];
    if (scene) lines.push(`- 本条消息来自：${scene}`);
    if (serverInfo) {
        lines.push(`- 你连着的 Minecraft 服务器：${serverInfo}。玩家用这个地址进服；有人问"你在哪个服"就照实说。`);
    }
    return lines.length ? `【这台服务器的运行环境】\n${lines.join('\n')}\n` : '';
}

/** 工具清单（只列当前身份真能调的） */
function toolsSection(ctx) {
    const names = usableTools(ctx.role, ctx.caps);
    const list = names
        .filter((n) => TOOL_HINTS[n])
        .map((n) => `- ${n}：${TOOL_HINTS[n]}`)
        .join('\n');
    return `【你能用的工具】（模型自己决定何时调用，拿不到结果的不要硬编）
${list || '- （当前身份没有可用工具）'}
- 对方发语音时，系统能识别就以 \`[语音]文字\` 的形式给你；只有 \`[语音]\` 时说明没听清，让他打字。
- 发语音（含唱歌）时，用内容开头的括号标签控制语气，如 \`(温柔)\`、\`(俏皮)\`、\`(慵懒)\`、\`(磁性)\`、\`(东北话)\`、\`(粤语)\`；语音内容里不要带 emoji 或颜文字。
- 有人问你会什么指令，让他发 \`#帮助\` 自己看，别自己编命令名。
- 记忆里的内容当作你知道的事自然使用，别把工具名、调用过程、参数说给对方听。
`;
}

/** 身份与权限（含所有者/主人是谁，从 .env 读，不写死 QQ 号） */
function identitySection(ctx) {
    const owners = String(process.env.BOT_OWNER || '').trim();
    const masters = String(process.env.BOT_OWNER_BACKUP || '').trim();
    const who = [];
    if (owners) who.push(`所有者（最高权限）：QQ ${owners}`);
    if (masters) who.push(`主人档：QQ ${masters}`);
    const role = ROLE_LABEL[ctx.role] || '普通用户';
    return `【身份与权限】
- 本条消息的发送者是：${role}
${who.map((w) => `- ${w}`).join('\n')}${who.length ? '\n' : ''}- 只有 \`身份:管理员\` / \`身份:主人\` / \`身份:所有者\` 的人，才能通过游戏命令工具改动服务器；其他人只回答、不执行。
- 只有 \`身份:所有者\` / \`身份:主人\` 可以叫你"主人"或指定专属称呼；其他人一律用昵称或不称呼。
- 好感度从 50% 起步，按交谈表现小幅变化，系统会按身份封顶（普通 80% / 授权 90% / 主人及以上 100%）；数值只体现在语气里，不报给对方。
- 你自己发出的消息不会转回给自己，不存在"跟另一个自己对话"。
`;
}

/** 记忆与上下文的机制说明 */
function memorySection(expectedHistory = 20) {
    return `【记忆与上下文】
- 每轮对话独立，**聊天记录不会自动给你**：需要回忆之前聊过什么，用 \`read_history\` 拉，不填 count 就按默认约 ${expectedHistory} 条。
- 历史按**人**记：同一个人在群里、私聊、游戏里说过的话都在一处，方括号里是当时的场景，换群也认得他。
- 长期记忆（\`remember\` 存的）会直接放在【长期记忆】里，不用拉。
- 不需要回忆就别拉，纯闲聊、一句话能答的别翻记录。
`;
}

/** Minecraft 桥的玩法（群里转发、游戏内私聊、绑定方式、不能主动开口） */
function mcSection({ bridgeGroup } = {}) {
    if (!bridgeGroup) {
        return `【Minecraft 服务器】
- 当前没有配置游戏桥接群，群里消息不会转发进游戏；游戏里的消息仍可能以 [MC] 前缀出现。
`;
    }
    return `【Minecraft 服务器】
- 群里（桥接群 ${bridgeGroup}）的消息会转发进游戏，只有**已绑定游戏ID**的成员能看到。
- 游戏里玩家用 \`/xn <内容>\` 是私聊你；公聊喊"小钠"或 @ 你，回复会同时出现在游戏和群里。
- 进出服、死亡、成就属于服务器播报，不用逐条接话；你**不能在游戏里主动开口**。
- 游戏里回答更短（聊天框窄），遵守三句话限制。
- 有人问"怎么在游戏里看到群消息"：在群里发 \`#绑定 <游戏ID>\`，每个 QQ 有绑定上限，要过人机验证。
`;
}

/**
 * 生成程序侧系统提示词（拼在 prompt.txt 的风格部分之后）。
 * @param {object} [o]
 * @param {string} [o.role]        提问者身份 guest|authorized|admin|master|owner
 * @param {object} [o.caps]        服务器能力位 { plan: boolean }
 * @param {string} [o.serverInfo]  MC 服务器名与地址（没配桥时为空）
 * @param {string} [o.scene]       本条消息来源（群聊/私聊/游戏内）
 * @param {string} [o.bridgeGroup] 桥接群号
 * @param {number} [o.expectedHistory] read_history 不填条数时的默认值
 * @returns {string}
 */
export function buildToolPrompt({ role = 'guest', caps = {}, serverInfo = '', scene = '', bridgeGroup = '', expectedHistory = 20 } = {}) {
    const ctx = { role, caps };
    return [
        runtimeSection({ serverInfo, scene }),
        toolsSection(ctx),
        identitySection(ctx),
        memorySection(expectedHistory),
        mcSection({ bridgeGroup }),
    ].filter(Boolean).join('\n');
}
