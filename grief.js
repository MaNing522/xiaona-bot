// ============================================================
// grief.js - 查询 MC 服务器 GriefLogger 的方块/容器操作记录
//
// 数据链路：本机 → mod 的 /bridge/grief → 服务端 mod 只读直连 GriefLogger 的 SQLite。
// 两条入口：
//   · #查记录        → 直接格式化展示最近记录（不喂 AI，展示上限 = threshold）
//   · 唤起小钠(AI)    → AI 判断需要查询 → 条数 > threshold 先询问"继续" → 喂 AI 总结 ≤100 字
// ============================================================
import { getGriefRecords } from './mcbridge.js';
import { chatCompletion } from './aiService.js';
import { config } from './config.js';

/** 维度 id → 中文名 */
const LEVEL_NAMES = {
    'minecraft:overworld': '主世界',
    'minecraft:the_nether': '下界',
    'minecraft:the_end': '末地',
};

/** blocks.action 的整数码（见 mod GriefQuery） */
const BLOCK_ACTIONS = {
    0: '破坏方块', 1: '放置方块', 2: '交互方块', 3: '击杀实体', 4: '交互实体',
};

/** containers.action 的整数码 */
const ITEM_ACTIONS = {
    0: '取出', 1: '存入', 2: '丢弃', 3: '拾取', 4: '合成', 5: '损坏',
    6: '消耗', 7: '投掷', 8: '射出', 9: '末影箱存入', 10: '末影箱取出',
};

function levelName(id) {
    const s = String(id || '');
    if (LEVEL_NAMES[s]) return LEVEL_NAMES[s];
    return s.replace(/^minecraft:/, '') || '未知世界';
}

function actionLabel(row) {
    const id = Number(row.actionId);
    const map = row.kind === 'container' ? ITEM_ACTIONS : BLOCK_ACTIONS;
    return map[id] || `操作#${id}`;
}

function materialName(m) {
    return String(m || '未知').replace(/^minecraft:/, '') || '未知';
}

/** epoch 毫秒 → "MM-DD HH:mm" */
function timeStr(ms) {
    const d = new Date(Number(ms) || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一条记录 → 一行可读文本 */
function formatRow(row) {
    const who = row.player || '未知';
    const pos = `${row.x},${row.y},${row.z}`;
    const what = materialName(row.material);
    const t = timeStr(row.time);
    const amt = row.kind === 'container' && row.amount ? ` x${row.amount}` : '';
    return `${t} ${who} 在 ${levelName(row.level)}(${pos}) ${actionLabel(row)} ${what}${amt}`;
}

/** 查询范围的中文描述 */
function scopeText(res) {
    const who = res.player ? `玩家「${res.player}」` : '全服';
    const h = res.hours ? `最近 ${res.hours} 小时 ` : '';
    return `${h}${who}`;
}

/**
 * 调 mod 的 /bridge/grief，并把"版本太旧 / 连不上"等错误翻译成人话。
 * @returns {Promise<{ok:boolean,total:number,rows:Array,hours?:number,player?:string,db?:string,error?:string}>}
 */
export async function queryGrief({ player = '', hours = 0, limit = 0 } = {}) {
    try {
        const r = await getGriefRecords({ player, hours, limit });
        if (!r || r.ok !== true) {
            return { ok: false, total: 0, rows: [], error: String((r && r.error) || '服务器没有返回数据') };
        }
        return {
            ok: true,
            total: Number(r.total) || 0,
            rows: Array.isArray(r.rows) ? r.rows : [],
            hours: r.hours,
            player: r.player,
            db: r.db,
        };
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (/HTTP 404/.test(msg)) {
            return { ok: false, total: 0, rows: [], error: '服务端 mod 版本过旧，不认识查询接口，请升级 mod（≥ 2.6.0）。' };
        }
        return { ok: false, total: 0, rows: [], error: msg };
    }
}

/**
 * 把查询结果格式化成文本（#查记录 直接展示用，不经过 AI）。
 * @param {object} res     queryGrief 的返回值
 * @param {number} [maxRows] 最多展示几条（默认 threshold）
 */
export function formatGrief(res, maxRows = config().grief.threshold) {
    if (!res || res.ok !== true) return `❌ 查询失败：${(res && res.error) || '未知错误'}`;
    if (!res.rows.length) return `🔍 ${scopeText(res)}没有查到操作记录。`;
    const shown = res.rows.slice(0, Math.max(1, maxRows));
    const head = `📜 ${scopeText(res)}共 ${res.total} 条记录`
        + (res.total > shown.length ? `，以下是最近 ${shown.length} 条：` : '：');
    return [head, ...shown.map(formatRow)].join('\n');
}

/**
 * 把记录喂给 AI，让它用 ≤100 字总结（AI 路径用）。
 * @param {Array}  rows      记录（已按时间倒序）
 * @param {number} total     窗口内总条数
 * @param {string} userInput 用户原话
 * @param {string} userId    提问者 QQ
 */
export async function summarizeGrief(rows, total, userInput = '', userId = '') {
    const lines = rows.map(formatRow);
    const prompt = `用户问题：${userInput || '查询服务器操作记录'}

以下是 GriefLogger 记录到的服务器操作日志（共 ${total} 条，这里给出最近 ${lines.length} 条，时间为「月-日 时:分」）：
${lines.join('\n')}

请用中文归纳成一段给用户看的结论，**必须控制在 100 字以内**，直接说重点：谁、什么时候、做了什么、涉及什么物品/方块、在哪个世界的大致位置。
不要逐条罗列，不要用"以下是/根据记录"这类套话，不要编造日志里没有的信息。若只是零散活动，就概括总体情况。`;

    const text = await chatCompletion({
        messages: [
            { role: 'system', content: '你是服务器日志分析助手，回答简洁、准确，只依据给定的日志内容。' },
            { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        maxTokens: 400,
        userId,
    });
    const s = String(text || '').trim();
    return s ? `📜 ${s}` : '📜 这段时间有一些零散的方块/容器操作记录，没有特别集中的行为。';
}