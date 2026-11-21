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
    minRole: 'guest',
    function: {
      name: 'player_pos',
      description: '查询某个在线玩家当前的坐标（X/Y/Z）和所在维度（主世界/下界/末地）。只需要游戏ID，不会改动任何东西；玩家不在线时会返回服务器提示。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '玩家游戏ID，3-16 位字母/数字/下划线' } },
        required: ['name'],
      },
    },
    run: async (args, ctx) => {
      const name = String(args.name || '').trim();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return '玩家名格式不对（3-16 位字母、数字或下划线）。';
      const pos = await ctx.runCommand(`data get entity ${name} Pos`);
      let dimText = '';
      try {
        dimText = await ctx.runCommand(`data get entity ${name} Dimension`);
      } catch { /* 查不到维度不影响坐标结果 */ }
      const raw = (String(dimText || '').match(/minecraft:[a-z_]+/) || [])[0] || '';
      const label = {
        'minecraft:overworld': '主世界',
        'minecraft:the_nether': '下界',
        'minecraft:the_end': '末地',
      }[raw] || raw;
      return `${pos}${label ? `\n所在维度：${label}` : ''}`;
    },
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_join',
      description: '让小钠用自带的 MC 客户端（离线登录，默认名 xiaona，Baritone 式寻路/挖矿/飞行）进入一个服务器。地址只填域名/IP（可带 :端口），不要带 http://。已经在同一个服务器里时调用不会重连（直接回“已在里面”），所以不确定时也可以放心先 mcbot_status 看一眼再决定。被服务器踢出后不会自动重连；除非用户明确要求重进，否则不要自己再 join。',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: '服务器地址，如 play.example.com 或 1.2.3.4:25565' },
          port: { type: 'number', description: '端口，默认 25565；地址里已带端口时可不填' },
          version: { type: 'string', description: '可选，如 1.21.11；不填用客户端默认版本' },
        },
        required: ['address'],
      },
    },
    run: async (args, ctx) => ctx.mcbot.join(
      String(args.address || '').trim(),
      Number(args.port) || 25565,
      String(args.version || '').trim(),
    ),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_leave',
      description: '让小钠退出当前进入的 MC 服务器（同时停掉正在执行的任务）。',
      parameters: { type: 'object', properties: {} },
    },
    run: async (args, ctx) => ctx.mcbot.leave(),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_status',
      description: '查看小钠 MC 客户端的状态：服务器、是否已进服、坐标、血量、饥饿、背包、附近玩家、当前任务进度。进服后先看这个。',
      parameters: { type: 'object', properties: {} },
    },
    run: async (args, ctx) => ctx.mcbot.status(),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_map',
      description: '画一张小钠附近地形的俯视地图：自动保存成 PNG 并发到当前 QQ 会话，同时返回地形摘要（方块分布/海拔/水域），并让视觉模型看一眼画面（水、岩浆、建筑、道路、玩家位置）。用户想看地形/周围环境时用。',
      parameters: {
        type: 'object',
        properties: {
          radius: { type: 'number', description: '半径（格），8~64，默认 32；越大越慢' },
          look: { type: 'boolean', description: '是否让视觉模型描述画面，默认 true' },
        },
      },
    },
    run: async (args, ctx) => ctx.mcbotMap(Number(args.radius) || 32, args.look !== false),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_mapitem',
      description: '把小钠物品栏里的地图物品（filled_map）导出成图片并发到当前 QQ 会话，同时把画面内容交给你：占比最大的地形/水域、未探索比例、图上标记数，接了视觉模型时还有画面描述。要求小钠身上有地图、且这张图已经探索过。',
      parameters: {
        type: 'object',
        properties: {
          look: { type: 'boolean', description: '是否让视觉模型描述画面，默认 true' },
        },
      },
    },
    run: async (args, ctx) => ctx.mcbotMapItem(args.look !== false),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_captcha',
      description: '取最近的登录验证码地图（AuthMe captcha，图上画着数字），发到当前 QQ 会话，并附视觉识别结果（仅供参考）。把图给用户看，等用户告诉你验证码是多少，再用 mcbot_command 发服务器要求的命令（如 /captcha 数字）；不要自己猜数字提交。',
      parameters: {
        type: 'object',
        properties: {
          look: { type: 'boolean', description: '是否让视觉模型描述画面，默认 true' },
        },
      },
    },
    run: async (args, ctx) => ctx.mcbotCaptcha(args.look !== false),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_hud',
      description: '读小钠 MC 客户端的界面信息：最近聊天、屏幕标题/副标题/动作栏、侧边计分板、Boss 栏。服务器提示、验证码要求、任务目标都在这里，遇到看不懂的局面先调它。',
      parameters: { type: 'object', properties: {} },
    },
    run: async (args, ctx) => ctx.mcbotHud(),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_chat',
      description: '让小钠在游戏公屏发言。**要执行服务器命令（/login、/spawn 等）请用 mcbot_command**。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要说的话（最多 200 字）' } },
        required: ['text'],
      },
    },
    run: async (args, ctx) => ctx.mcbot.chat(String(args.text || '').trim()),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_command',
      description: '以小钠的 MC 客户端执行一条服务器命令（不用写 / 也行，会自动补）。适合 /login、/reg、/spawn、/home 等服务器指令。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '命令内容，如 /login 密码 或 spawn' } },
        required: ['command'],
      },
    },
    run: async (args, ctx) => ctx.mcbot.command(String(args.command || '').trim()),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_cmd',
      description: [
        '给小钠的 MC 客户端下任务指令（进服后使用），原样转给游戏客户端。常用：',
        'goto x y z（寻路过去）、fly x y z（鞘翅飞过去）、collect <方块> [数量]（扫描并挖矿，如 collect diamond_ore 8）、',
        'develop（自动发育：木头→石镐→铁镐→钻石套）、pvp [玩家]（打最近的/指定玩家）、mace [玩家]（重锤跳劈）、',
        'follow [玩家]（跟随）、stop（停）、xray 开/关/auto（反矿透策略）、toss [n]（丢垃圾）。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '任务指令，如 goto 100 64 100' } },
        required: ['command'],
      },
    },
    run: async (args, ctx) => ctx.mcbot.run(String(args.command || '').trim()),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_players',
      description: '查看小钠客户端渲染范围内（默认 64 格，最多 256 格）能看到哪些玩家及距离。',
      parameters: {
        type: 'object',
        properties: { radius: { type: 'number', description: '观察半径（格），默认 64' } },
      },
    },
    run: async (args, ctx) => ctx.mcbot.nearbyPlayers(Number(args.radius) || 64),
  },
  {
    minRole: 'admin',
    function: {
      name: 'mcbot_inventory',
      description: '查看小钠 MC 客户端背包里的物品和数量。',
      parameters: { type: 'object', properties: {} },
    },
    run: async (args, ctx) => ctx.mcbot.inventory(),
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
      description: '把小钠自己更新到 GitHub 仓库的最新代码（直连失败会自动换镜像，成功后自动重启）。**只在对方是主人/所有者、且明确要求"更新/升级/拉最新代码/把你自己更新一下"时才用**；对方只是问有没有更新，用 bot_update_check 看就行，不要直接更新。不要自己主动更新，也别为了尝鲜调用。更新结果只用一两句话自然带过，不要罗列提交标题、哈希或镜像源。',
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
  {
    minRole: 'guest',
    function: {
      name: 'group_notice',
      description: '读当前群的群公告（群规、活动、注意事项常写在这里）。只有在群聊里能用；私聊/游戏里会说明看不到。有人问「群公告写了什么」「群规是什么」时用。',
      parameters: { type: 'object', properties: {} },
    },
    run: async (args, ctx) => ctx.groupNotice(),
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

/** 已经取消就立刻抛错，让整轮 agent 尽快收尾（不再继续请求模型/工具） */
function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const e = new Error('本轮已取消');
    e.name = 'AbortError';
    throw e;
  }
}

/** 给一个 Promise 套上"取消即拒绝"，避免卡住的工具把整轮对话拖死 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const e = new Error('本轮已取消');
      e.name = 'AbortError';
      reject(e);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * 工具调用循环：反复"让模型决策 → 执行工具 → 回灌结果"，直到模型给出最终文字回复。
 *
 * @param {object} opts
 * @param {Array}  opts.messages   初始消息（含 system + user），会被就地追加
 * @param {Array}  opts.tools      可用的工具定义（已按身份过滤）
 * @param {Function} opts.chat     (body) => {content, tool_calls}
 * @param {object} opts.ctx        工具执行上下文（供各工具 run 使用）
 * @param {number} [opts.maxSteps] 最多循环几步（防止死循环），默认 24
 * @param {Function} [opts.onTool] 每次调用工具时的回调（日志用）
 * @param {Function} [opts.onToolResult] 每次拿到工具结果时的回调 (name, text, ok)（日志用）
 * @param {Function} [opts.steer]  引导：每次请求模型前调用，返回期间用户新发的消息（[{role,content}]），
 *                                 直接追加进当前对话——正常 agent 的 steering，而不是排队等下一轮。
 * @returns {Promise<string>} 模型最终的文字回复
 */
export async function runAgentLoop({ messages, tools, chat, ctx, maxSteps = 24, onTool, onToolResult, signal, steer }) {
  // AI 自己中途发出去的话（唱歌/图片/旁白，由 ctx.noteSent 收集进 ctx.ownSaid）：
  // 下一次请求模型前回灌成 assistant 消息，让它知道自己已经发过什么，别重复或自相矛盾。
  const drainSaid = () => {
    const q = ctx && ctx.ownSaid;
    if (!Array.isArray(q) || !q.length) return;
    const said = q.splice(0).map((s) => String(s || '').trim()).filter(Boolean).join('\n');
    if (said) messages.push({ role: 'assistant', content: said });
  };

  // 引导：模型正在思考/跑工具时用户又发消息，不打断当前请求（模型调用无法中途插话），
  // 而是赶在下一次请求模型前把它追加成新的 user 消息，让模型把最新输入一起考虑。
  const pullSteer = async () => {
    if (!steer) return 0;
    throwIfAborted(signal);
    const extra = await raceAbort(Promise.resolve(steer()), signal);
    if (!Array.isArray(extra)) return 0;
    let n = 0;
    for (const m of extra) {
      if (m && m.role && m.content) {
        messages.push(m);
        n += 1;
      }
    }
    return n;
  };

  let toolFailed = false

  for (let step = 0; step < maxSteps; step += 1) {
    throwIfAborted(signal);
    await pullSteer();
    drainSaid();
    const msg = await raceAbort(chat({ messages, tools }), signal);
    const calls = msg && msg.tool_calls;
    if (!calls || !calls.length) {
      // 模型刚要给出最终答复，用户又发来了新消息：这份回答已经过时，
      // 先把它记进对话，补上新消息后再让模型重答一轮（而不是回一句没看到新消息的话）。
      const late = await pullSteer();
      if (late) {
        if (msg && msg.content) messages.push({ role: 'assistant', content: msg.content });
        continue;
      }
      const text = (msg && msg.content) || '';
      // 工具失败后模型什么都没说：不能让它悄悄吞掉，逼它用一句话把失败告诉用户
      if (!String(text).trim() && toolFailed) {
        if (msg && msg.content) messages.push({ role: 'assistant', content: msg.content });
        messages.push({
          role: 'user',
          content: '（系统提示）刚才的工具调用失败了。请用你自己的话，用一句自然的话告诉对方这次没办成、原因是什么、接下来你打算怎么办；不要假装成功，也不要沉默。',
        });
        drainSaid();
        const retry = await raceAbort(chat({ messages, tools: [] }), signal).catch(() => null);
        return (retry && retry.content) || '';
      }
      return text;
    }

    // 助手这一轮只发起工具调用（可能同时多条），先原样记入，再逐条执行。
    // 注意：这里的 content 是模型的**内部旁白**，不发给用户——真正的 agent 应该
    // 在思维链里把工具跑完，再拿最终结果统一回话，而不是先发一句"我查一下"。
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      throwIfAborted(signal);
      const name = call.function && call.function.name;
      let out;
      try {
        out = await raceAbort(execTool(name, call.function && call.function.arguments, ctx, tools, onTool), signal);
      } catch (e) {
        // 兜底：execTool 自己已经会兜住异常，这里再保险一层，绝不让工具问题中断循环
        out = {
          ok: false,
          text: `工具 ${name} 执行失败：${e && e.message ? e.message : e}。请把这次失败用一句自然的话告诉对方，别装作成功。`,
        };
      }
      if (!out || out.ok === false) toolFailed = true;
      // 工具结果必须始终回灌给模型（成功/失败都要），哪怕空字符串也补一句，
      // 否则有的服务商会对空的 tool 消息报错，整轮回复就断了
      const content = String((out && out.text) ?? '').trim() || '（工具执行完成，但没有返回内容）';
      // 把工具回给模型的内容也交给调用方记日志（截断在外部做）
      if (onToolResult) {
        try { onToolResult(name, content, !(out && out.ok === false)); } catch { /* 日志失败不影响主流程 */ }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  // 步数用完但工具结果还没被模型消化：禁用工具再来一轮，让它基于结果作答，而不是直接吞掉
  try {
    throwIfAborted(signal);
    await pullSteer();
    drainSaid();
    const final = await raceAbort(chat({ messages, tools: [] }), signal);
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
 * @param {number} [opts.maxSteps] 最多循环几步，默认 24
 * @param {boolean} [opts.allowSkip] 是否允许用【REPLY:是】判定"这条不接"
 * @param {Function} [opts.onTool] 工具调用回调（日志用）
 * @param {Function} [opts.onToolResult] 工具结果回调 (name, text, ok)（日志用）
 * @param {Function} [opts.steer] 引导回调：每次请求模型前拉取用户新消息（见 runAgentLoop）
 * @returns {Promise<{reply:string, wantVoice:boolean, skip:boolean}>}
 */
export async function runAgentReply({ messages, tools = [], chat, ctx = {}, maxSteps = 24, allowSkip = false, onTool, onToolResult, signal, steer }) {
  let usedTool = false;
  const raw = await runAgentLoop({
    messages,
    tools,
    chat,
    ctx,
    maxSteps,
    signal,
    onToolResult,
    steer,
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
    return { ok: false, text: `拒绝：你没有权限调用工具 ${name}。把这件事用一句自然的话告诉对方，别装作已经做了。` };
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
    return { ok: true, text: String(out ?? '').slice(0, 4000) };
  } catch (e) {
    // 失败原因照实回灌给模型，由它组织成人话发给用户（不要在这里直接甩给用户）
    return {
      ok: false,
      text: `工具 ${name} 执行失败：${e && e.message ? e.message : e}。请把这次失败用一句自然的话告诉对方，并说明接下来怎么办；不要假装成功。`,
    };
  }
}
