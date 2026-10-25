// ============================================================
// config.js - 运行时可调参数（冷却 / 限流 / 时效）的加载器
//
// 与 .env 的分工：
//   · .env         —— 密钥、账号、开关等"部署相关"的东西
//   · config.json  —— 数值类可调项（冷却、限流、超时…），本模块负责读它
// 两者互相独立：这里**不读 process.env**（只有 BOT_CONFIG 例外，用于指定配置文件路径）。
//
// config.json 支持 // 行注释与 /* */ 块注释；缺字段用 DEFAULTS 兜底；
// 数值必须是 ≥ 0 的数字，非法值忽略并回退默认。
// 运行时由 index.js 用 watchConfig() 监听，改完 **1 秒内自动热加载生效，无需重启**；
// 写坏 / 删除文件的瞬间不会生效（reloadConfig 会保留上一份配置）。
// ============================================================
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { ROOT } from './paths.js';

/** 配置文件路径（可用环境变量 BOT_CONFIG 覆盖，便于测试） */
export const CONFIG_PATH = path.resolve(process.env.BOT_CONFIG || path.join(ROOT, 'config.json'));

/** 全部默认值 —— 也是"标准配置"的唯一副本，config.json 缺失/写坏时靠它兜底 */
export const DEFAULTS = {
    rateLimit: {
        userCooldownMs: 2000,
        userPerMinute: 8,
        userPerHour: 60,
        userPerDay: 200,
        groupPerMinute: 20,
        groupPerHour: 200,
        globalMaxConcurrent: 3,
        globalPerMinute: 30,
        queueMax: 15,
        queueTimeoutMs: 20000,
        violationsToCooldown: 5,
        penaltyCooldownMs: 30000,
        floodWindowMs: 10000,
        floodCount: 15,
        penaltyMuteMs: 300000,
    },
    cooldown: {
        pokeMs: 3000,
        shakeMs: 2000,
        forwardDelayMs: 800,
        forwardMs: 5000,
    },
    engage: {
        ttlMs: 600000,
        initiatorLeft: 3,
        otherLeft: 1,
    },
    // 语音识别（asr.js）识别结果的「同音纠正」：把常见错字改回机器人名字，
    // 否则「小钠」被识别成「小娜」时既读着别扭、也匹配不上触发关键词。
    asr: {
        canonicalName: '小钠',   // 目标名字：错字统一改回它
        // 会被改写成目标名字的错字（逗号分隔）；也可写「错字=正确词」精确指定
        homophones: '小娜,小纳,小呐,小哪,小那,晓娜,晓纳,晓钠,筱钠,筱娜,小拿,笑纳',
    },
    // 会话层的全局默认（网页「会话管理」里会话可单独覆盖，见 chatSettings.js）
    chat: {
        botReply: true,        // AI 是否回复（全局开关；会话可单独静音）
        keyword: '小钠',       // 群聊里触发回应的关键词（@ 与引用始终触发，不受此影响）
        voice: true,           // 是否允许发语音
        extraPrompt: '',       // 追加给 AI 的补充提示词（会话级可覆盖）
    },
    // 进群 / 退群提醒（网页「会话管理」里单个群可单独覆盖；只有群聊用得上）
    // 文案里可用占位符：{name} 昵称、{kind} 进/退群描述、{note} 附加说明（如自动解绑）
    notice: {
        enabled: true,
        joinText: '欢迎加入群聊！🎉',
        leaveText: '👋 {name} {kind}{note}',
    },
    // 游戏ID 绑定的全局默认「每人上限」（网页「全局设置」可改）。
    // 单个 QQ 的覆盖值由管理员及以上用 #绑定上限 命令设置（见 binding.js）。
    bind: {
        maxPerQQ: 3,           // 每个 QQ 最多绑定几个游戏ID
        unbindRetainDays: 15,  // 解绑记录在网页「绑定管理」里保留多少天，到期自动删除
    },
    // 联网搜索后端（网页「全局设置」可切换）：
    //   provider = off关闭 | baidu百度智能搜索 | deepseek DeepSeek官方搜索 | custom自定义接口
    // deepseek 复用 .env 的 AI_API_KEY（官方 Search API，按次计费）；
    // custom 的密钥放 .env 的 SEARCH_CUSTOM_KEY（留空则接口免鉴权访问）。
    search: {
        provider: 'baidu',
        // custom 后端：DeepSeek 风格的原始 JSON 搜索接口地址（POST {query,count} → {results:[...]}）
        customUrl: '',
        limit: 5,              // 每次最多返回几条结果（1~50）
    },
    // 图片识别（多模态）：
    //   provider = ai 用 AI 主模型识别（默认）| custom 自定义视觉接口 | off 关闭图像识别
    // custom 的密钥放 .env 的 VISION_CUSTOM_KEY（留空则接口免鉴权访问）。
    vision: {
        provider: 'ai',
        customUrl: '',         // custom 后端：OpenAI 兼容 /chat/completions 地址（需支持 image_url）
        customModel: '',       // custom 后端要用的模型名（留空由接口自己决定）
    },
    // Minecraft 服务器连接（网页「全局设置」可切换）：
    //   mode = ''用 .env 的 MC_BRIDGE_URL（默认）| off无连接 | loopback本地回环 | lan局域网 | public公网地址
    // 密钥/桥接群仍看 .env 的 MC_BRIDGE_SECRET / MC_BRIDGE_GROUP。
    bridge: {
        mode: '',
        port: 25565,           // loopback / lan 模式用：桥 HTTP 端口（服务商只放行的那一个）
        lanHost: '',           // lan 模式用：服务器局域网地址（IP 或主机名）
        publicUrl: '',         // public 模式用：完整公网地址（含 http:// 与端口）
    },
};

/**
 * 去掉 JSON 文本里的注释（// 与 块注释），字符串字面量内的内容一律不动。
 * 这样配置文件里能写人话注释，又不引入任何依赖。
 */
export function stripComments(text) {
    let out = '';
    let inStr = false, esc = false, inLine = false, inBlock = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], n = text[i + 1];
        if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
        if (inStr) {
            out += c;
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; out += c; continue; }
        if (c === '/' && n === '/') { inLine = true; i++; continue; }
        if (c === '/' && n === '*') { inBlock = true; i++; continue; }
        out += c;
    }
    return out;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 用 over 覆盖 base 的字段，并把值校正成合法数字。
 * 只认 base 里已有的键（多余字段忽略），数字键强制 ≥ 0 的有限数，非法则保留默认。
 */
function applyOverrides(base, over) {
    for (const [k, v] of Object.entries(base)) {
        const o = isPlainObject(over) ? over[k] : undefined;
        if (typeof v === 'number') {
            const n = Number(o);
            base[k] = Number.isFinite(n) && n >= 0 ? n : v;
        } else if (typeof v === 'boolean') {
            base[k] = typeof o === 'boolean' ? o : v;
        } else if (typeof v === 'string') {
            base[k] = typeof o === 'string' ? o : v;
        } else if (isPlainObject(v)) {
            applyOverrides(v, o);
        }
    }
    return base;
}

/**
 * 从指定文件读取配置并与默认值合并（纯函数式，便于单测直接给定路径）。
 * 文件不存在或解析失败 → 返回一份默认值副本。
 */
export function loadConfig(filePath = CONFIG_PATH) {
    let over = {};
    try {
        if (fs.existsSync(filePath)) {
            over = JSON.parse(stripComments(fs.readFileSync(filePath, 'utf8')));
        } else {
            logger.warn(`[配置] 未找到 ${filePath}，全部使用内置默认值。`);
        }
    } catch (e) {
        logger.error(`[配置] 解析 ${filePath} 失败，改用默认值：${e.message}`);
        over = {};
    }
    return applyOverrides(structuredClone(DEFAULTS), over);
}

let current = loadConfig();

/** 当前生效的配置（只读，别直接改） */
export function config() {
    return current;
}

/**
 * 重新从磁盘读取并**原地更新** current。
 * 原地更新的意义：已经持有 config() 引用的调用方（如 index.js 的 cfg）无需重新获取，
 * 热加载后能直接读到新值。解析失败 / 文件被删时保留旧配置，绝不因为一次写坏就重置成默认值。
 * @param {string} [filePath] 配置文件路径（默认 CONFIG_PATH，便于测试直接给路径）
 */
export function reloadConfig(filePath = CONFIG_PATH) {
    if (!fs.existsSync(filePath)) {
        logger.warn(`[配置] 热重载跳过：${filePath} 不存在，保留当前配置。`);
        return current;
    }
    let over;
    try {
        over = JSON.parse(stripComments(fs.readFileSync(filePath, 'utf8')));
    } catch (e) {
        logger.error(`[配置] 热重载失败，保留当前配置：${e.message}`);
        return current;
    }
    const next = applyOverrides(structuredClone(DEFAULTS), over);
    // 原地替换：删掉已移除的键，再覆盖新值（保持 current 引用不变）
    for (const k of Object.keys(current)) if (!(k in next)) delete current[k];
    Object.assign(current, next);
    return current;
}

/**
 * 监听配置文件变化并触发热重载（轮询方式，跨编辑器 / 系统更稳）。
 * @param {() => void} onReload 文件变化时的回调
 * @param {number} [intervalMs] 轮询间隔
 * @param {string} [filePath] 监听的文件（默认 CONFIG_PATH）
 * @returns {() => void} 停止监听的函数
 */
export function watchConfig(onReload, intervalMs = 1000, filePath = CONFIG_PATH) {
    const listener = (curr, prev) => {
        // 内容没变（只有访问时间变）不触发
        if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
        onReload();
    };
    fs.watchFile(filePath, { interval: intervalMs }, listener);
    return () => fs.unwatchFile(filePath, listener);
}