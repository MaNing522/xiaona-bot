// ============================================================
// config.js - 运行时可调参数（冷却 / 限流 / 时效）的加载器
//
// 与 .env 的分工：
//   · .env         —— 密钥、账号、开关等"部署相关"的东西
//   · config.json  —— 数值类可调项（冷却、限流、超时…），本模块负责读它
// 两者互相独立：这里**不读 process.env**（只有 BOT_CONFIG 例外，用于指定配置文件路径）。
//
// config.json 支持 // 行注释与 /* */ 块注释；缺字段用 DEFAULTS 兜底；
// 数值必须是 ≥ 0 的数字，非法值忽略并回退默认。改完重启生效。
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 配置文件路径（可用环境变量 BOT_CONFIG 覆盖，便于测试） */
export const CONFIG_PATH = path.resolve(process.env.BOT_CONFIG || path.join(__dirname, 'config.json'));

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
    // GriefLogger 服务器记录查询（方块破坏/放置、容器存取等）
    grief: {
        threshold: 50,     // 记录条数超过它时，AI 路径先询问是否继续；#查记录用它当展示上限
        defaultHours: 24,  // 没指定时间范围时，默认往回查多少小时
        maxRows: 100,      // 单次最多取回多少条（AI 总结时喂给模型的条数上限）
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

/** 重新从磁盘读取（供将来做热加载用） */
export function reloadConfig() {
    current = loadConfig();
    return current;
}