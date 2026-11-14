// ============================================================
// mcbot.js - 小钠自己的 MC 客户端（mineflayer，离线登录，名字固定 xiaona）
//
// 桥接 mod 只能看"我们自己的服务器"；这个模块让 AI 能主动连别的服务器去看看：
// 聊天、看状态/背包、走动、挖方块、放方块、用物品。
//
// 所有"动手"类操作都**先转向对象**：
//   · 移动：先朝移动方向看（走坐标则朝目标），再前进
//   · 挖掘：先看方块中心
//   · 放置：先看参照方块朝向目标的那一面
//   · 使用物品 / 聊天：不需要转向
// ============================================================
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import vec3 from 'vec3';
import { logger } from './logger.js';

const { pathfinder, Movements, goals } = pf;
const DEFAULT_PORT = 25565;
const BOT_NAME = 'xiaona';
const CONNECT_TIMEOUT = 30000;
const MAX_CHAT_LOG = 50;

let bot = null;
let joining = false;
let chatLog = [];
let meta = { address: '', port: 0, state: 'offline', version: '', error: '', joinedAt: 0 };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPos(p) {
  if (!p) return '未知';
  return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
}

function requireOnline() {
  if (!bot || meta.state !== 'online' || !bot.entity) {
    throw new Error(`小钠现在不在服务器里（${meta.state === 'connecting' ? '正在连接' : '离线'}），先用 mcbot_join 进去`);
  }
  return bot;
}

/** 指南针方向 → MC yaw（弧度）；0 = 南(+Z)，π/2 = 西(-X)，π = 北(-Z)，-π/2 = 东(+X) */
export function yawOfDirection(dir) {
  const d = String(dir || '').toLowerCase();
  if (d === 'south') return 0;
  if (d === 'west') return Math.PI / 2;
  if (d === 'north') return Math.PI;
  if (d === 'east') return -Math.PI / 2;
  return null;
}

/** 相对方向（forward/back/left/right）在当前朝向上的 yaw */
function yawRelative(currentYaw, dir) {
  if (dir === 'forward') return currentYaw;
  if (dir === 'back') return currentYaw + Math.PI;
  if (dir === 'left') return currentYaw - Math.PI / 2;
  if (dir === 'right') return currentYaw + Math.PI / 2;
  return null;
}

/** 记录玩家聊天（最近 50 条，供 AI 回看） */
function pushChat(username, message) {
  chatLog.push({ t: Date.now(), user: String(username || ''), text: String(message || '') });
  if (chatLog.length > MAX_CHAT_LOG) chatLog.shift();
}

export function status() {
  const b = bot;
  const lines = [];
  const stateText = { online: '在线', connecting: '连接中', offline: '离线' }[meta.state] || meta.state;
  lines.push(`状态：${stateText}${meta.address ? `（${meta.address}:${meta.port}）` : ''}`);
  if (meta.version) lines.push(`协议版本：${meta.version}`);
  if (meta.error) lines.push(`最近错误：${meta.error}`);
  if (b && b.entity && meta.state === 'online') {
    lines.push(`坐标：${fmtPos(b.entity.position)}（维度 ${b.game && b.game.dimension ? b.game.dimension : '未知'}）`);
    lines.push(`血量：${b.health ?? '?'} / 饥饿：${b.food ?? '?'}`);
    const held = b.heldItem;
    lines.push(`手持：${held ? `${held.name} ×${held.count}` : '空手'}`);
    const players = Object.keys(b.players || {});
    lines.push(`在线玩家（${players.length}）：${players.slice(0, 30).join('、') || '只有我自己'}`);
  }
  return lines.join('\n');
}

/**
 * 连接服务器（离线登录，名字 xiaona）。
 * @param {string} address 主机名/IP，允许带 :端口
 * @param {number} port 端口（地址里带端口时以地址为准）
 * @param {string} version 可选，如 "1.21.11"；不填自动按服务器 ping 的版本
 */
export async function join(address, port = DEFAULT_PORT, version = '') {
  if (joining) throw new Error('上一次连接还没结束，稍等几秒');
  if (bot) leave();
  let host = String(address || '').trim();
  if (!host) throw new Error('服务器地址不能为空');
  let p = Number(port) || DEFAULT_PORT;
  if (host.includes(':') && !host.startsWith('[')) {
    const [h, pp] = host.split(':');
    host = h;
    if (pp) p = Number(pp) || p;
  }
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('服务器地址格式不对（只填域名/IP，不要带 http://）');
  if (!(p >= 1 && p <= 65535)) throw new Error('端口不对（1-65535）');

  joining = true;
  meta = { address: host, port: p, state: 'connecting', version: '', error: '', joinedAt: 0 };
  const opts = { host, port: p, username: BOT_NAME, auth: 'offline' };
  const v = String(version || '').trim();
  opts.version = v || false; // false = 按服务器 ping 自动选协议
  logger.info(`[MC机器人] 连接 ${host}:${p}（离线名 ${BOT_NAME}${v ? `, 版本 ${v}` : ''}）`);

  let b;
  try {
    b = mineflayer.createBot(opts);
  } catch (e) {
    joining = false;
    meta.state = 'offline';
    meta.error = e.message;
    throw e;
  }
  bot = b;
  b.loadPlugin(pathfinder);

  b.on('chat', (username, message) => pushChat(username, message));
  b.on('kicked', (reason) => {
    const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
    meta.error = `被踢出：${String(text).slice(0, 300)}`;
    logger.warn(`[MC机器人] ${meta.error}`);
  });
  b.on('error', (err) => {
    meta.error = String((err && err.message) || err).slice(0, 300);
    logger.warn(`[MC机器人] 连接错误：${meta.error}`);
  });
  b.on('end', (reason) => {
    if (bot === b) bot = null;
    if (meta.state === 'online' || meta.state === 'connecting') {
      meta.state = 'offline';
      if (reason) meta.error = String(reason).slice(0, 300);
    }
    logger.info(`[MC机器人] 已断开（${reason || '连接关闭'}）`);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { b.quit(); } catch { /* 已经断了 */ }
      reject(new Error(`连接超时（${CONNECT_TIMEOUT / 1000} 秒），检查地址/端口，或服务器是否在线模式`));
    }, CONNECT_TIMEOUT);
    b.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
    b.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    b.once('end', () => {
      clearTimeout(timer);
      reject(new Error(meta.error || '连接被服务器关闭'));
    });
  }).catch((e) => {
    joining = false;
    meta.state = 'offline';
    meta.error = String((e && e.message) || e);
    try { b.quit(); } catch { /* 已经断了 */ }
    if (bot === b) bot = null;
    throw new Error(`进服失败：${meta.error}`);
  });

  joining = false;
  meta.state = 'online';
  meta.version = String(b.version || '');
  meta.joinedAt = Date.now();
  logger.info(`[MC机器人] 已进入 ${host}:${p}（版本 ${meta.version}）`);
  return `已进入 ${host}:${p}（离线名 ${BOT_NAME}）。\n${status()}`;
}

/** 退出服务器（没连上也不报错） */
export function leave() {
  const b = bot;
  bot = null;
  meta.state = 'offline';
  chatLog = [];
  if (b) {
    try { b.quit(); } catch { /* 已断 */ }
    return '已退出服务器。';
  }
  return '本来就不在服务器里。';
}

/** 发聊天（不用转向）。空文本时返回最近聊天记录，方便"看看大家在说什么" */
export function chat(text) {
  const b = requireOnline();
  const msg = String(text || '').replace(/[\r\n]+/g, ' ').trim();
  if (!msg) {
    const lines = chatLog.slice(-20).map((c) => `${c.user || '系统'}: ${c.text}`);
    return lines.length ? lines.join('\n') : '最近没有聊天记录。';
  }
  if (msg.length > 200) throw new Error('聊天太长（最多 200 字）');
  b.chat(msg);
  return `已在游戏里发言：${msg}`;
}

/** 背包摘要 */
export function inventory() {
  const b = requireOnline();
  const items = b.inventory.items();
  if (!items.length) return '背包是空的。';
  const agg = new Map();
  for (const it of items) agg.set(it.name, (agg.get(it.name) || 0) + it.count);
  const list = [...agg.entries()].sort((a, b2) => b2[1] - a[1]);
  const held = b.heldItem;
  return `手持：${held ? `${held.name} ×${held.count}` : '空手'}\n背包（${list.length} 种）：\n`
    + list.slice(0, 40).map(([n, c]) => `- ${n} ×${c}`).join('\n');
}

/**
 * 按方向走一小段：先转向移动方向，再前进。
 * @param {string} direction forward/back/left/right 或 north/south/east/west
 * @param {number} seconds 1~10 秒
 */
export async function move(direction = 'forward', seconds = 1) {
  const b = requireOnline();
  const dir = String(direction || 'forward').toLowerCase();
  const sec = Math.min(10, Math.max(0.2, Number(seconds) || 1));
  const current = b.entity.yaw;
  const yaw = yawOfDirection(dir) ?? yawRelative(current, dir);
  if (yaw === null) throw new Error('方向只能是 forward/back/left/right 或 north/south/east/west');
  await b.look(yaw, 0, true); // 先转向，再走
  b.setControlState('forward', true);
  try {
    await sleep(sec * 1000);
  } finally {
    b.setControlState('forward', false);
  }
  return `朝 ${dir} 走了约 ${sec} 秒，现在在 ${fmtPos(b.entity.position)}`;
}

/** 走到指定坐标（pathfinder；出发前先朝目标看） */
export async function walkTo(x, y, z, timeoutMs = 60000) {
  const b = requireOnline();
  const tx = Number(x);
  const ty = Number(y);
  const tz = Number(z);
  if (![tx, ty, tz].every(Number.isFinite)) throw new Error('坐标必须是数字');
  const pos = b.entity.position;
  await b.look(Math.atan2(-(tx - pos.x), tz - pos.z), 0, true);
  const movements = new Movements(b);
  movements.canDig = false; // 不为了抄近路去挖别人建筑
  b.pathfinder.setMovements(movements);
  const goal = new goals.GoalBlock(Math.floor(tx), Math.floor(ty), Math.floor(tz));
  b.pathfinder.setGoal(goal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try { b.pathfinder.setGoal(null); } catch { /* 已停 */ }
      reject(new Error(`走不过去（超时 ${Math.round(timeoutMs / 1000)} 秒），可能被挡住或没有路`));
    }, timeoutMs);
    function onGoal() {
      cleanup();
      resolve();
    }
    function onPath(upd) {
      if (upd && upd.status === 'noPath') {
        cleanup();
        reject(new Error('找不到路（可能太远、被围住或目标在空中）'));
      }
    }
    function cleanup() {
      clearTimeout(timer);
      b.removeListener('goal_reached', onGoal);
      b.removeListener('path_update', onPath);
    }
    b.once('goal_reached', onGoal);
    b.on('path_update', onPath);
  });
  return `已走到 ${fmtPos(b.entity.position)}（目标 ${Math.round(tx)}, ${Math.round(ty)}, ${Math.round(tz)}）`;
}

/** 挖一个方块（先看方块中心） */
export async function breakBlock(x, y, z) {
  const b = requireOnline();
  const target = vec3(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
  if (![target.x, target.y, target.z].every(Number.isFinite)) throw new Error('坐标必须是数字');
  const block = b.blockAt(target);
  if (!block || block.name === 'air') throw new Error(`那里没有方块（${target.x}, ${target.y}, ${target.z}）`);
  if (block.name.includes('bedrock') || block.name.includes('barrier')) throw new Error('这个方块挖不动');
  if (b.entity.position.distanceTo(block.position) > 5.5) throw new Error('太远了，先走近一点（5 格以内）');
  await b.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  await b.dig(block);
  return `已挖掉 ${block.name}（${target.x}, ${target.y}, ${target.z}）`;
}

/**
 * 放一个方块（先看参照方块朝向目标的那一面）。
 * @param {number} x,y,z 要放到的位置
 * @param {string} item 可选，方块名（如 dirt / oak_planks）；不填自动从背包挑第一个方块
 */
export async function placeBlock(x, y, z, item = '') {
  const b = requireOnline();
  const target = vec3(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
  if (![target.x, target.y, target.z].every(Number.isFinite)) throw new Error('坐标必须是数字');
  if (b.entity.position.distanceTo(target) > 5) throw new Error('太远了，先走近一点（5 格以内）');
  const cur = b.blockAt(target);
  if (cur && cur.boundingBox !== 'empty') throw new Error(`目标位置已经有方块：${cur.name}`);

  // 找一个相邻的实心方块当参照，face 指向目标
  const dirs = [vec3(0, -1, 0), vec3(0, 1, 0), vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 0, 1), vec3(0, 0, -1)];
  let ref = null;
  let face = null;
  for (const d of dirs) {
    const nb = b.blockAt(target.plus(d));
    if (nb && nb.boundingBox === 'block') {
      ref = nb;
      face = d.scaled(-1);
      break;
    }
  }
  if (!ref) throw new Error('目标旁边没有可依附的实心方块');

  const want = String(item || '').trim().toLowerCase();
  const items = b.inventory.items();
  const picked = want
    ? items.find((it) => it.name === want || it.name === `minecraft:${want}` || it.name.endsWith(`_${want}`))
    : items.find((it) => { try { return !!b.registry.blocksByName[it.name]; } catch { return false; } });
  if (!picked) throw new Error(want ? `背包里没有 ${want}` : '背包里没有可放置的方块');
  await b.equip(picked, 'hand');
  // 先转向参照方块的这一面，再放
  const faceCenter = ref.position.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5));
  await b.lookAt(faceCenter, true);
  await b.placeBlock(ref, face);
  return `已用 ${picked.name} 放在 ${target.x}, ${target.y}, ${target.z}`;
}

/** 使用手持物品/吃东西（不用转向）；item 可选，指定就先装备 */
export async function useItem(item = '') {
  const b = requireOnline();
  const want = String(item || '').trim().toLowerCase();
  if (want) {
    const it = b.inventory.items().find((x) => x.name === want || x.name === `minecraft:${want}` || x.name.endsWith(`_${want}`));
    if (!it) throw new Error(`背包里没有 ${want}`);
    await b.equip(it, 'hand');
  }
  const held = b.heldItem;
  if (!held) throw new Error('手上没有东西可用');
  b.activateItem();
  await sleep(1200); // 吃东西/拉弓都需要按住一会儿
  b.deactivateItem();
  return `已使用 ${held.name}`;
}

/** 供 index.js 注入 AI 上下文 */
export const mcbot = {
  join, leave, status, chat, inventory, move, walkTo, breakBlock, placeBlock, useItem,
};
