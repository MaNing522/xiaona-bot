// ============================================================
// agent.js - 工具调用（function calling）agent 框架
//
// 小钠从"靠提示词标记硬解析"的伪 agent，升级为**真·工具调用**：
// 模型自己决定调哪个工具，拿到结果后再决定下一步，直到给出最终回复。
//
// 「对应身份对应调用」：每个工具声明所需的最低身份 minRole（与 permission.js 一致），
//   提示模型前**按提问者身份过滤**，模型根本看不到自己无权用的工具；
//   执行时**再校验一次**（双保险），越权调用直接拒绝。
//   身份高低：guest < authorized < admin < master(主人) < owner(所有者)
// ============================================================

/** 身份高低（数值越大越高） */
export const ROLE_RANK = { guest: 0, authorized: 1, admin: 2, master: 3, owner: 4 };

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
    // 依赖服务器装了 Plan（没装时 mod 会禁用 /bridge/player，这里同步隐藏工具）
    requires: 'plan',
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
      name: 'sing',
      description: '唱一段歌给对方听：系统会把歌声合成语音并直接发出去（QQ 聊天、网页试用有语音；游戏内没有）。歌词必须放在 lyrics；如果你记不全歌词，**先调用 web_search 搜「歌名 歌词」**，拿到歌词后再调用本工具；搜不到就直说不会唱这首，别瞎编歌词。唱 4~8 句就好，别整首唱完。歌词里不要带 emoji。',
      parameters: {
        type: 'object',
        properties: {
          song: { type: 'string', description: '歌名（可选，如《海阔天空》）' },
          lyrics: { type: 'string', description: '要唱的歌词，4~8 句；不知道就先搜索，不要瞎编。分行写也没关系，系统会合成一整行' },
        },
        required: ['lyrics'],
      },
    },
    run: async (args, ctx) => ctx.sing(String(args.lyrics || '').trim(), String(args.song || '').trim()),
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
  {
    minRole: 'authorized',
    function: {
      name: 'write_note',
      description: '把内容写进小钠本地的文本笔记（data/notes/），以后可以用 read_note 读回来。适合保存清单、资料、约定、长文本等需要长期留存的内容；只在对方明确要求保存或确实值得存档时用，不要记录闲聊。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '笔记文件名，如「购物清单」「服务器资料」（自动补 .txt）' },
          content: { type: 'string', description: '要保存的文本内容' },
          append: { type: 'boolean', description: 'true=追加到文件末尾；false 或不填=覆盖' },
        },
        required: ['name', 'content'],
      },
    },
    run: async (args, ctx) => ctx.writeNote(
      String(args.name || '').trim(),
      String(args.content || ''),
      args.append === true,
    ),
  },
  {
    minRole: 'authorized',
    function: {
      name: 'read_note',
      description: '读取小钠本地文本笔记。不填 name 时列出所有笔记；填 name 时返回该笔记内容。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '笔记文件名（可省略；省略则列出全部笔记）' } },
      },
    },
    run: async (args, ctx) => ctx.readNote(String(args.name || '').trim()),
  },
  {
    minRole: 'guest',
    function: {
      name: 'sleep',
      description: '等一会儿再继续说（最多 30 秒）。只在确实该等的时候用：对方说“等我一下/马上回来”、需要隔一会儿再回应、或者想让节奏别太抢话。不要拿它拖正常回复。',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number', description: '等多少秒（1~30）' } },
        required: ['seconds'],
      },
    },
    run: async (args) => {
      const sec = Math.min(30, Math.max(1, Math.round(Number(args.seconds) || 1)));
      await new Promise((r) => setTimeout(r, sec * 1000));
      return `已等待 ${sec} 秒。`;
    },
  },
  {
    minRole: 'master',
    function: {
      name: 'bot_update_check',
      description: '查看小钠的 GitHub 仓库有没有新版本、更新了哪些提交（只 fetch 对比，不改代码、不重启）。对方问"有没有更新 / 更新了啥 / 看看新版本"时先用它把结果告诉对方；对方确认更要更新，再调 bot_update。',
      parameters: { type: 'object', properties: {} },
    },
    run: async (_args, ctx) => (ctx.checkUpdate ? ctx.checkUpdate() : '当前场景不能查询更新。'),
  },
  {
    minRole: 'master',
    function: {
      name: 'bot_update',
      description: '把小钠自己更新到 GitHub 仓库的最新代码（直连失败会自动换镜像，成功后自动重启）。**只在对方是主人/所有者、且明确要求"更新/升级/拉最新代码/把你自己更新一下"时才用**；对方只是问有没有更新，用 bot_update_check 看就行，不要直接更新。不要自己主动更新，也别为了尝鲜调用。',
      parameters: { type: 'object', properties: {} },
    },
    run: async (_args, ctx) => (ctx.selfUpdate ? ctx.selfUpdate() : '当前场景不能更新。'),
  },
  {
    minRole: 'guest',
    function: {
      name: 'read_history',
      description: '拉取你和**当前这个人**以前的聊天记录（按人存：群里、私聊、游戏里说过的话都在一处）。需要回忆之前聊过什么时用；不确定拉多少条就**不要填 count**，系统按默认值给你。不要每轮都拉。',
      parameters: {
        type: 'object',
        properties: { count: { type: 'integer', description: '拉多少条（可选；不填用默认值）' } },
      },
    },
    run: async (args, ctx) => ctx.readHistory(args.count),
  },
];

/**
 * 按身份取出可用的工具定义（已过滤 + 转为 OpenAI 格式）。
 * @param {string} role guest | authorized | admin | owner
 * @param {object} [caps] 服务器能力位（来自 /bridge/status）：{ plan: boolean }
 *   plan=false 时隐藏依赖 Plan 的工具（player_query），避免模型去调一个必然失败的接口。
 *   不传 caps（或字段缺失）按"可用"处理，保持旧行为。
 * @returns {Array} OpenAI 兼容的 tools 数组
 */
export function toolsForRole(role, caps = {}) {
  const rank = ROLE_RANK[role] ?? 0;
  return AGENT_TOOLS
    .filter((t) => rank >= (ROLE_RANK[t.minRole] ?? 0))
    .filter((t) => !t.requires || caps[t.requires] !== false)
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
    // 模型在发起工具调用时自己写的那句话（如"让我看看这张图""正在搜一下"），先发给用户，
    // 让他知道小钠正在干什么——而不是由代码塞一句固定话术
    if (msg.content && ctx && typeof ctx.notify === 'function') {
      try { await ctx.notify(String(msg.content)); } catch { /* 中间消息发不出去不影响主流程 */ }
    }
    for (const call of calls) {
      const name = call.function && call.function.name;
      let out;
      try {
        out = await execTool(name, call.function && call.function.arguments, ctx, tools, onTool);
      } catch (e) {
        // 兜底：execTool 自己已经会兜住异常，这里再保险一层，绝不让工具问题中断循环
        out = `工具 ${name} 执行失败：${e && e.message ? e.message : e}`;
      }
      // 工具结果必须始终回灌给模型（成功/失败都要），哪怕空字符串也补一句，
      // 否则有的服务商会对空的 tool 消息报错，整轮回复就断了
      const content = String(out ?? '').trim() || '（工具执行完成，但没有返回内容）';
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  // 步数用完但工具结果还没被模型消化：禁用工具再来一轮，让它基于结果作答，而不是直接吞掉
  try {
    const final = await chat({ messages, tools: [] });
    return (final && final.content) || '';
  } catch {
    return '';
  }
}

/**
 * 判定"这条是否要跳过不回复"（只在允许跳过时生效）。
 * 允许跳过时从严：只有明确写了【REPLY:是】才回。**但调过工具=明确在办事，必须放行**——
 * 括号可能是中文【】也可能是英文[]（元数据行用的是[]），两种都认。
 * 否则模型去查了服务器、却因为没写标记被当成"不是在叫我"吞掉。
 * @param {string} reply    模型最终回复
 * @param {boolean} allowSkip 是否启用"判断要不要接话"
 * @param {boolean} usedTool  本轮是否调用过工具
 */
export function decideSkip(reply, allowSkip, usedTool) {
  const s = String(reply || '');
  // 模型自己明确写了【REPLY:否】= 它不想接话：任何场合都尊重，别逼它硬回一句
  // （被 @ 时 allowSkip=false，但它照样可能写"否"，以前会被剥成空串再兜底成"没听懂"）
  const no = /[【[]\s*REPLY\s*[:：]\s*(否|NO|no|false|0)\s*[】\]]/.test(s);
  if (no && !usedTool) return true;
  if (!allowSkip) return false;
  const yes = /[【[]\s*REPLY\s*[:：]\s*(是|YES|yes|true|1)\s*[】\]]/i.test(s);
  return !yes && !usedTool;
}

/**
 * 一轮完整的 agent 回合（所有 AI 能力共用这一个内核）：
 * 跑工具循环 → 解析【REPLY】/【VOICE】标记 → 决定是否跳过。
 * 正常回复、识图、空间文案…都调用这里，区别只在 messages / tools / chat 适配器。
 *
 * @param {object} opts
 * @param {Array}  opts.messages  初始消息（含 system + user），会被就地追加
 * @param {Array}  [opts.tools]   可用工具（已按身份过滤）
 * @param {Function} opts.chat    (body) => {content, tool_calls}；可以是主模型，也可以是视觉/自定义后端适配器
 * @param {object} [opts.ctx]     工具执行上下文
 * @param {number} [opts.maxSteps] 最多循环几步，默认 5
 * @param {boolean} [opts.allowSkip] 是否允许用【REPLY:是】判定"这条不接"
 * @param {Function} [opts.onTool] 工具调用回调（日志用）
 * @returns {Promise<{reply:string, wantVoice:boolean, skip:boolean}>}
 */
export async function runAgentReply({ messages, tools = [], chat, ctx = {}, maxSteps = 5, allowSkip = false, onTool }) {
  let usedTool = false;
  const raw = await runAgentLoop({
    messages,
    tools,
    chat,
    ctx,
    maxSteps,
    // 调过工具 = 明确在办事，即使没写【REPLY:是】也不能被跳过（见 decideSkip）
    onTool: (name, args) => { usedTool = true; if (onTool) onTool(name, args); },
  });

  const skip = decideSkip(raw, allowSkip, usedTool);
  let text = String(raw || '');
  text = text.replace(/[【[]\s*REPLY\s*[:：][^】\]]*[】\]]/g, '');

  let wantVoice = false;
  const voiceMatch = text.match(/[【[]\s*VOICE\s*[:：]\s*(YES|NO|是|否)\s*[】\]]/i);
  if (voiceMatch) wantVoice = /^(YES|是)$/i.test(voiceMatch[1]);
  text = text.replace(/[【[]\s*VOICE\s*[:：][^】\]]*[】\]]/gi, '');

  return { reply: text.trim(), wantVoice, skip };
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

