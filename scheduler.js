// ============================================================
// scheduler.js - 定时任务模块（定时提醒 / 定时禁言 / 定时解禁）
// 通过 initScheduler() 注入依赖，由 index.js 在启动时调用
// ============================================================
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, readJsonSafe } from './datafile.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 依赖注入（index.js 提供） ----------
let callApi = null;
let sendReply = null;
let segText = null;
let getBotId = () => 0;
let saveDir = null;
let SCH_FILE = '';

// ---------- 任务存储 ----------
let schTasks = []; // 普通：{id,type,runAt,repeatDaily,group_id,user_id,duration,content}；时间段禁言：{id,type:'muteWindow',group_id,user_id,startH,startM,endH,endM,lastDate}
let schSeq = 1;

const pad2 = (n) => String(n).padStart(2, '0');

export function initScheduler(deps) {
  callApi = deps.callApi;
  sendReply = deps.sendReply;
  segText = deps.segText;
  getBotId = deps.getBotId || (() => 0);
  saveDir = deps.saveDir || path.join(__dirname, 'data');
  SCH_FILE = path.join(saveDir, 'scheduler.json');
  schLoad();
  setInterval(schTick, 10000);
}

function schLoad() {
  const arr = readJsonSafe(SCH_FILE, [], 'scheduler.json');
  if (Array.isArray(arr)) schTasks = arr;
}
function schSave() {
  writeJsonAtomic(SCH_FILE, schTasks);
}
function nextClock(h, min, now) {
  const t = new Date(now);
  t.setHours(h, min, 0, 0);
  if (t.getTime() <= now) t.setTime(t.getTime() + 86400000);
  return t.getTime();
}
// 解析时间：N秒 / N分钟 / N小时 / HH:MM（可加"每天"）
function parseWhen(s, now) {
  now = now || Date.now();
  let m = s.match(/^(\d+)\s*秒/); if (m) return { runAt: now + +m[1] * 1000, repeatDaily: false };
  m = s.match(/^(\d+)\s*分/); if (m) return { runAt: now + +m[1] * 60000, repeatDaily: false };
  m = s.match(/^(\d+)\s*小/); if (m) return { runAt: now + +m[1] * 3600000, repeatDaily: false };
  m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    const repeatDaily = /每天|每日|daily/i.test(s);
    return { runAt: nextClock(+m[1], +m[2], now), repeatDaily };
  }
  return null;
}
function schTargetId(event, arg) {
  // 优先取 @ 目标，其次参数中的 QQ 号
  const ats = (Array.isArray(event.message) ? event.message : [])
    .filter((s) => s.type === 'at' && String(s.data.qq) !== String(getBotId()));
  if (ats.length) return String(ats[0].data.qq);
  const m = arg ? arg.match(/\d{5,14}/) : null;
  return m ? m[0] : null;
}

export async function handleScheduler(event, cmd, arg, r) {
  const gid = event.group_id;
  const isGroup = event.message_type === 'group';

  // 查看 / 取消（主人/管理员）
  if (cmd === '/定时列表') {
    if (!['owner', 'admin'].includes(r)) return sendReply(event, '❌ 无权限（需主人或管理员）。');
    if (!schTasks.length) return sendReply(event, '🗓️ 暂无定时任务。');
    const lines = schTasks.map((t) => {
      if (t.type === 'muteWindow') {
        const cross = t.endH * 60 + t.endM <= t.startH * 60 + t.startM;
        return `${t.id} [定时禁言] 每天 ${pad2(t.startH)}:${pad2(t.startM)}-${pad2(t.endH)}:${pad2(t.endM)}${cross ? '(跨天)' : ''} QQ ${t.user_id}`;
      }
      const time = new Date(t.runAt).toLocaleString('zh-CN', { hour12: false });
      const tgt = t.type === 'remind' ? `会话#${t.group_id || t.user_id}` : `QQ ${t.user_id}`;
      return `${t.id} [${t.type}] ${time}${t.repeatDaily ? '(每天)' : ''} ${tgt}${t.content ? ' · ' + t.content.slice(0, 20) : ''}`;
    });
    return sendReply(event, '🗓️ 定时任务：\n' + lines.join('\n'));
  }
  if (cmd === '/取消定时') {
    if (!['owner', 'admin'].includes(r)) return sendReply(event, '❌ 无权限（需主人或管理员）。');
    const id = arg.trim();
    const i = schTasks.findIndex((t) => t.id === id);
    if (i < 0) return sendReply(event, `❌ 未找到定时任务 ${id}。`);
    schTasks.splice(i, 1);
    schSave();
    return sendReply(event, `🗑️ 已取消定时任务 ${id}。`);
  }

  // 定时提醒（任何会话可用）；定理解禁/禁言需主人/管理员且仅群
  const canAdmin = ['owner', 'admin'].includes(r);
  if (cmd === '/定时提醒') {
    // 解析：<时间> <内容>
    const t = parseWhen(arg, Date.now());
    if (!t) return sendReply(event, '❌ 时间格式：N秒 / N分钟 / N小时 / HH:MM（每天HH:MM 可每天重复）');
    const rest = arg.replace(/每天|每日|daily/gi, '').replace(/^[^\s]+\s*/, '').trim();
    if (!rest) return sendReply(event, '❌ 用法：#定时提醒 <时间> <提醒内容>');
    const task = {
      id: 'T' + (schSeq++), type: 'remind', runAt: t.runAt, repeatDaily: t.repeatDaily,
      group_id: isGroup ? gid : undefined, user_id: isGroup ? undefined : event.user_id,
      content: rest,
    };
    schTasks.push(task);
    schSave();
    const when = t.repeatDaily ? '每天 ' + new Date(t.runAt).toTimeString().slice(0, 5) : new Date(t.runAt).toLocaleString('zh-CN', { hour12: false });
    return sendReply(event, `⏰ 已设置提醒（${when}）：${rest}`);
  }

  // 定时禁言 / 定时解禁
  if (!canAdmin) return sendReply(event, '❌ 无权限（需主人或管理员）。');
  if (!isGroup) return sendReply(event, '❌ 仅群聊可用。');
  const target = schTargetId(event, arg);
  if (!target) return sendReply(event, '❌ 未指定目标，请 @对方 或附 QQ 号。');
  if (String(target) === String(getBotId())) return sendReply(event, '❌ 不能针对自己。');

  if (cmd === '/定时解禁') {
    const t = parseWhen(arg.replace(target, '').trim(), Date.now());
    if (!t) return sendReply(event, '❌ 时间格式：N秒 / N分钟 / HH:MM');
    const task = { id: 'T' + (schSeq++), type: 'unmute', runAt: t.runAt, repeatDaily: t.repeatDaily, group_id: gid, user_id: target };
    schTasks.push(task);
    schSave();
    return sendReply(event, `⏰ 已定时：${target} 将于 ${new Date(t.runAt).toLocaleString('zh-CN', { hour12: false })} 解禁。`);
  }

  // 定时禁言：优先时间段模式（HH:MM-HH:MM，每天重复，到点禁言、结束自动解禁）
  const raw = arg.replace(target, '').trim();
  const win = raw.match(/(\d{1,2}):(\d{2})\s*[-~至到]\s*(\d{1,2}):(\d{2})/);
  if (win) {
    const startH = +win[1], startM = +win[2], endH = +win[3], endM = +win[4];
    if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return sendReply(event, '❌ 时间无效，请使用 HH:MM-HH:MM，如 12:00-18:00');
    if (startH * 60 + startM === endH * 60 + endM) return sendReply(event, '❌ 开始与结束时间不能相同。');
    const cross = endH * 60 + endM <= startH * 60 + startM;
    const task = { id: 'T' + (schSeq++), type: 'muteWindow', group_id: gid, user_id: target, startH, startM, endH, endM, lastDate: '' };
    schTasks.push(task);
    schSave();
    return sendReply(event, `⏰ 已设置定时禁言：${target} 每天 ${pad2(startH)}:${pad2(startM)}-${pad2(endH)}:${pad2(endM)}${cross ? '（跨天）' : ''} 期间禁言，结束自动解禁。`);
  }

  // 一次性模式（保留兼容）：N分钟后 禁言M分钟；到时禁言，时长到自动解禁
  const t = parseWhen(raw, Date.now());
  if (!t) return sendReply(event, '❌ 时间格式：时间段 HH:MM-HH:MM（每天重复） 或 N分钟/N小时 后禁言。');
  const durMin = (arg.match(/禁言\s*(\d+)\s*分/) || arg.match(/(\d+)\s*分$/))?.[1] || 10;
  const durSec = Number(durMin) * 60;
  const task = { id: 'T' + (schSeq++), type: 'mute', runAt: t.runAt, repeatDaily: t.repeatDaily, group_id: gid, user_id: target, duration: durSec };
  schTasks.push(task);
  schSave();
  return sendReply(event, `⏰ 已定时：${target} 将于 ${new Date(t.runAt).toLocaleString('zh-CN', { hour12: false })} 禁言 ${durMin} 分钟。`);
}

// 时间段禁言：在 HH:MM-HH:MM 窗口内禁言（时长覆盖到结束，自动解禁），每天重复
// 用“今天/昨天”两个候选起点判断窗口，兼容跨天窗口（如 22:00-02:00）与重启恢复
export async function checkMuteWindow(t, now) {
  for (const base of [now, now - 86400000]) {
    const start = new Date(base); start.setHours(t.startH, t.startM, 0, 0);
    const end = new Date(base); end.setHours(t.endH, t.endM, 0, 0);
    if (end.getTime() <= start.getTime()) end.setTime(end.getTime() + 86400000);
    if (now >= start.getTime() && now < end.getTime()) {
      const key = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
      if (t.lastDate !== key) {
        const remainSec = Math.ceil((end.getTime() - now) / 1000) + 60;
        await callApi('set_group_ban', { group_id: t.group_id, user_id: t.user_id, duration: Math.max(remainSec, 60) });
        t.lastDate = key;
      }
      return;
    }
  }
  t.lastDate = ''; // 不在任何窗口内，解除今日标记
}

// 定时任务执行循环（每 10 秒扫描一次）
async function schTick() {
  const now = Date.now();
  const due = schTasks.filter((t) => t.type !== 'muteWindow' && t.runAt <= now);
  if (due.length) schTasks = schTasks.filter((t) => t.type !== 'muteWindow' && t.runAt > now);
  for (const t of due) {
    try {
      if (t.type === 'remind') {
        const msg = [segText(`⏰ 定时提醒：${t.content}`)];
        if (t.group_id) await callApi('send_group_msg', { group_id: t.group_id, message: msg });
        else await callApi('send_private_msg', { user_id: t.user_id, message: msg });
      } else if (t.type === 'mute') {
        await callApi('set_group_ban', { group_id: t.group_id, user_id: t.user_id, duration: t.duration || 600 });
      } else if (t.type === 'unmute') {
        await callApi('set_group_ban', { group_id: t.group_id, user_id: t.user_id, duration: 0 });
      }
    } catch (e) {
      logger.error('[定时] 执行失败:', t.id, e.message);
    }
    if (t.repeatDaily) schTasks.push({ ...t, runAt: nextClock(new Date(t.runAt).getHours(), new Date(t.runAt).getMinutes(), now) });
  }
  // 时间段禁言（每天重复，单独处理）
  for (const t of schTasks.filter((x) => x.type === 'muteWindow')) {
    try { await checkMuteWindow(t, now); } catch (e) { logger.error('[定时] 时间段禁言失败:', t.id, e.message); }
  }
  schSave();
}
