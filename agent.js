// ============================================================
// agent.js - 工具调用（function calling）agent 框架
//
// 小钠从"靠提示词标记硬解析"的伪 agent，升级为**真·工具调用**：
// 模型自己决定调哪个工具，拿到结果后再决定下一步，直到给出最终回复。
//
// 「对应身份对应调用」：每个工具声明所需的最低身份 minRole（与 permission.js 一致），
//   提示模型前**按提问者身份过滤**，模型根本看不到自己无权用的工具；
//   执行时**再校验一次**（双保险），越权调用直接拒绝。
//   身份高低：guest < authorized < admin < owner
// ============================================================

/** 身份高低（数值越大越高） */
export const ROLE_RANK = { guest: 0, authorized: 1, admin: 2, owner: 3 };

/**
 * 工具注册表。每项：
 *   minRole   最低身份要求
 *   function  OpenAI 兼容的工具定义（name/description/parameters）
 *   run(args, ctx) 实际执行，返回给模型看的字符串结果
 * ctx 由调用方（index.js）按当前会话构造，把真实能力注入进来。
 */
export const AGENT_TOOLS = [
  {
    minRole: 'guest',
    function: {
      name: 'web_search',
      description: '联网搜索**外部**实时信息。只在答案依赖此刻的外部公开信息、你凭自己不可能知道时才用：天气、新闻、赛事比分、股价汇率、票价、软件最新版本等。**任何 Minecraft 服务器的查询（自己的或别人的，只要给的是服务器地址）都不要用本工具，改用 mc_status。** 闲聊、常识、算数、翻译、写代码不要用。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词，简短、可直接喂给搜索引擎' } },
        required: ['query'],
      },
    },
    run: async (args, ctx) => ctx.search(String(args.query || '').trim()),
  },
  {
    minRole: 'guest',
    function: {
      name: 'analyze_image',
      description: '识别本条消息里图片的内容（描述画面、读截图里的文字/OCR、分析图表等）。只在**本条消息带有 [图片]**、且你确实需要知道图里是什么才能回答时才用；纯文字消息、或不用看图就能答的不要用。',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: '你想从图里了解什么，如「图里的文字是什么」「这张截图报的什么错」（可选）' } },
      },
    },
    run: async (args, ctx) => ctx.analyzeImage(String(args.question || '').trim()),
  },
  {
    minRole: 'guest',
    function: {
      name: 'mc_status',
      description: '查询 Minecraft 服务器状态（是否在线 / 版本 / 在线人数 / 玩家列表）。**不填 address** → 查小钠自己连着的那个服；**填 address**（如 play.example.com 或 1.2.3.4:25565）→ 查任意指定的服务器。**查任何 MC 服务器都用本工具（自己的和别人的都是），不要用 web_search。**',
      parameters: {
        type: 'object',
        properties: { address: { type: 'string', description: '要查的服务器地址（可选，如 play.example.com:25565）。不填则查小钠自己连着的服' } },
      },
    },
    run: async (args, ctx) => ctx.mcStatus(String(args.address || '').trim()),
  },
  {
    minRole: 'guest',
    function: {
      name: 'player_query',
      description: '查询某个 Minecraft 玩家的统计数据（游玩时长、最后在线、活跃度等），数据来自服务器 Plan 插件。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '玩家游戏ID，3-16 位字母/数字/下划线' } },
        required: ['name'],
      },
    },
    run: async (args, ctx) => ctx.playerQuery(String(args.name || '').trim()),
  },
  {
    minRole: 'admin',
    function: {
      name: 'ai_balance',
      description: '查询 AI 服务商账户余额（还剩多少钱、累计充值、已使用）。属于账务信息。',
      parameters: { type: 'object', properties: {} },
    },
    run: async (_args, ctx) => ctx.balance(),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mc_command',
      description: '在 Minecraft 服务器上执行一条命令（如 tp、give、gamemode、time、weather、kill、ban…）。**仅管理员/主人可用**。对方明确要求你改游戏状态时才用（如"把时间调成白天""给某人加个权限"）；只是好奇地问"能不能"不要执行。命令不要带前导斜杠。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的服务器命令，不含前导 /，例如 "time set day" 或 "give Steve diamond 1"' } },
        required: ['command'],
      },
    },
    run: async (args, ctx) => ctx.runCommand(String(args.command || '').trim()),
  },
  {
    minRole: 'guest',
    function: {
      name: 'adjust_favor',
      description: '调整你对当前说话人的好感度（初始 50%，你按对方的表现累积；系统会按身份封顶，主人固定 100%）。用得克制：对方让你舒服、真诚、帮了你的忙，就小幅加（+1~+5）；对方惹你烦、冒犯、撒谎、无理取闹，可小幅减（-1~-5）。同一轮最多调一次，幅度别夸张，别为了讨好乱加。',
      parameters: {
        type: 'object',
        properties: {
          delta: { type: 'integer', description: '好感度增减量：正数加、负数减，通常 -5~+5' },
          reason: { type: 'string', description: '一句话说明为什么增减（可选，仅用于日志）' },
        },
        required: ['delta'],
      },
    },
    run: async (args, ctx) => ctx.adjustFavor(args.delta, String(args.reason || '').trim()),
  },
  {
    minRole: 'guest',
    function: {
      name: 'remember',
      description: '把一条值得长期记住的信息存入记忆（以后对话会用到）。仅当对方明确要求记住、或确实值得长期保存时使用。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要记住的内容，一句完整的话' } },
        required: ['text'],
      },
    },
    run: async (args, ctx) => ctx.remember(String(args.text || '').trim()),
  },
  {
    minRole: 'guest',
    function: {
      name: 'recall_memory',
      description: '按关键词检索以前记住的信息（长期记忆），用于回忆对方之前提过的事。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '要检索的关键词' } },
        required: ['keyword'],
      },
    },
    run: async (args, ctx) => ctx.recall(String(args.keyword || '').trim()),
  },
];

/**
 * 按身份取出可用的工具定义（已过滤 + 转为 OpenAI 格式）。
 * @param {string} role guest | authorized | admin | owner
 * @returns {Array} OpenAI 兼容的 tools 数组
 */
export function toolsForRole(role) {
  const rank = ROLE_RANK[role] ?? 0;
  return AGENT_TOOLS
    .filter((t) => rank >= (ROLE_RANK[t.minRole] ?? 0))
    .map((t) => ({ type: 'function', function: t.function }));
}

/**
 * 工具调用循环：反复"让模型决策 → 执行工具 → 回灌结果"，直到模型给出最终文字回复。
 *
 * @param {object} opts
 * @param {Array}  opts.messages   初始消息（含 system + user），会被就地追加
 * @param {Array}  opts.tools      可用的工具定义（已按身份过滤）
 * @param {Function} opts.chat     (body) => {content, tool_calls}
 * @param {object} opts.ctx        工具执行上下文（供各工具 run 使用）
 * @param {number} [opts.maxSteps] 最多循环几步（防止死循环），默认 5
 * @param {Function} [opts.onTool] 每次调用工具时的回调（日志用）
 * @returns {Promise<string>} 模型最终的文字回复
 */
export async function runAgentLoop({ messages, tools, chat, ctx, maxSteps = 5, onTool }) {
  for (let step = 0; step < maxSteps; step += 1) {
    const msg = await chat({ messages, tools });
    const calls = msg && msg.tool_calls;
    if (!calls || !calls.length) return (msg && msg.content) || '';

    // 助手这一轮只发起了工具调用（可能同时多条），先原样记入，再逐条执行
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      const name = call.function && call.function.name;
      const out = await execTool(name, call.function && call.function.arguments, ctx, tools, onTool);
      messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  return ''; // 超过 maxSteps：不再让模型继续，交由上层兜底
}

/**
 * 判定"这条是否要跳过不回复"（只在允许跳过时生效）。
 * 允许跳过时从严：只有明确写了【REPLY:是】才回。**但调过工具=明确在办事，必须放行**——
 * 否则模型去查了服务器、却因为没写标记被当成"不是在叫我"吞掉。
 * @param {string} reply    模型最终回复
 * @param {boolean} allowSkip 是否启用"判断要不要接话"
 * @param {boolean} usedTool  本轮是否调用过工具
 */
export function decideSkip(reply, allowSkip, usedTool) {
  if (!allowSkip) return false;
  const yes = /【\s*REPLY\s*[:：]\s*(是|YES|yes|true|1)\s*】/.test(String(reply || ''));
  return !yes && !usedTool;
}

/** 执行单个工具：校验身份（工具是否在允许列表里）→ 解析参数 → 运行 → 返回文本结果 */
async function execTool(name, rawArgs, ctx, allowedTools, onTool) {
  const def = AGENT_TOOLS.find((t) => t.function.name === name);
  // 双保险：不在"该身份可用列表"里的工具一律拒绝（模型理论上看不到，但也防它硬编名字）
  if (!def || !allowedTools.some((t) => t.function.name === name)) {
    return `拒绝：你没有权限调用工具 ${name}。`;
  }
  let args;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    args = {};
  }
  if (!args || typeof args !== 'object') args = {};
  try {
    if (onTool) onTool(name, args);
    const out = await def.run(args || {}, ctx);
    return String(out ?? '').slice(0, 4000);
  } catch (e) {
    return `工具 ${name} 执行失败：${e.message}`;
  }
}
