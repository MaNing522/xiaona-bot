// ============================================================
// forward.js - 合并转发（伪造聊天记录）的解析与构造
//
// #聊天记录 的多行输入 → OneBot 11 的合并转发节点。
// 每行格式：<QQ号 或 @某人> <空白/冒号> <文案>
//
// 这里只做**纯函数**的解析与构造：不碰网络、不读环境变量、不管权限与冷却 ——
// 那些都在 index.js（只有那里才有 callApi 和权限判断）。这样解析逻辑可以直接单测。
// ============================================================

/** 一条卡片最多几行：太多既超出卡片可读范围，也更容易被判刷屏 */
export const MAX_FORWARD_NODES = 30;

/** 单个节点文案的长度上限（卡片里太长会被折叠） */
const MAX_TEXT_LEN = 500;

/**
 * 取出命令后面**保留换行**的原始参数。
 *
 * 为什么需要它：handleCommand 里 `text.split(/\s+/)` + `rest.join(' ')` 会把换行压成空格，
 * 而 #聊天记录 正是靠换行分行的。这里只去掉命令后紧跟的空格/制表符，换行原样留着。
 * 行尾多余的空白仍然去掉（用户多敲一个回车不该变成一行空内容）。
 * @param {string} text     整条命令文本（含命令名）
 * @param {string} cmdToken 命令名（不含 # 或 / 前缀）
 */
export function rawArgAfter(text, cmdToken) {
  return String(text || '')
    .slice(String(cmdToken || '').length)
    .replace(/^[^\S\r\n]+/, '')
    .trim();
}

/**
 * 解析多行输入。
 * @param {string} text  #聊天记录 之后的原始内容（保留换行）
 * @param {(token:string)=>string} [resolveAt]  @昵称 → QQ号；认不出返回 ''。
 *                                              纯数字的 @号码 由本函数自行处理，不走它。
 * @returns {{entries:Array<{uin:string,text:string}>, errors:string[]}}
 */
export function parseForwardInput(text, resolveAt) {
  const entries = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // 空行只是排版，不算错
    const no = i + 1;

    if (entries.length >= MAX_FORWARD_NODES) {
      errors.push(`最多 ${MAX_FORWARD_NODES} 条，第 ${no} 行起忽略`);
      break;
    }

    // 目标在前、文案在后，中间至少一个空白或冒号分隔
    const m = line.match(/^(@\S+|\d{5,14})[\s:：,，]+([\s\S]*)$/);
    if (!m) {
      // 整行只有一个目标（如单写一行 QQ 号）：提示"没写内容"比"开头要是…"好懂
      if (/^(@\S+|\d{5,14})$/.test(line)) errors.push(`第 ${no} 行：只写了人，没写内容`);
      else errors.push(`第 ${no} 行：开头要是 QQ号 或 @某人`);
      continue;
    }

    const target = m[1];
    const body = m[2].trim();
    if (!body) {
      errors.push(`第 ${no} 行：只写了人，没写内容`);
      continue;
    }

    let qq;
    if (target.startsWith('@')) {
      const token = target.slice(1);
      qq = /^\d{5,14}$/.test(token) ? token : resolveAt ? resolveAt(token) : '';
    } else {
      qq = target;
    }
    if (!qq) {
      errors.push(`第 ${no} 行：认不出「${target}」，可以直接写 QQ 号`);
      continue;
    }

    entries.push({ uin: String(qq), text: body.slice(0, MAX_TEXT_LEN) });
  }

  return { entries, errors };
}

/**
 * 构造 OneBot 11 的合并转发节点（type: 'node'）。
 * @param {Array<{uin:string,name?:string,text:string}>} entries
 * @returns {Array<{type:string,data:{uin:string,name:string,content:Array}>}>}
 */
export function buildForwardNodes(entries) {
  return (Array.isArray(entries) ? entries : []).map((e) => ({
    type: 'node',
    data: {
      uin: String(e.uin),
      name: String(e.name || e.uin), // 拿不到昵称就退回号码，别显示空名
      content: [{ type: 'text', data: { text: String(e.text) } }],
    },
  }));
}
