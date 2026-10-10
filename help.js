// ============================================================
// help.js - #帮助 动态菜单（分类/搜索/分页/权限，纯文本，不输出图片）
// ============================================================

// 权限档位（从高到低，高档自动包含低档的全部命令）：
//   owner  主人      全部命令 + 主人专属
//   admin  管理员    群管 / 定时 / 账务 / 强制解绑
//   auth   授权用户  公开命令 + 工具（截图 / 网址截图 / 合成转发）
//   all    普通用户  公开命令
// role: all(人人可见) | auth(需授权) | admin(管理员/主人) | owner(仅主人)
export const HELP_CMDS = [
  { c: '#帮助 [分类/关键词]', d: '帮助菜单（#帮助 基础/绑定/群管/定时/记忆/主人/工具/权限）', cat: '基础', role: 'all' },
  { c: '#状态', d: '查看服务器（MC）与机器人的运行状态', cat: '基础', role: 'all' },
  { c: '#查询 <玩家名>', d: '查某个玩家的 Plan 数据（时长/最后在线/活跃度）', cat: '基础', role: 'all' },
  { c: '#mc <地址[:端口]>', d: '查询 MC 服务器状态', cat: '基础', role: 'all' },
  { c: '#申请授权', d: '提交授权申请，等待主人审批', cat: '基础', role: 'all' },
  { c: '#绑定 <游戏ID>', d: '绑定QQ到游戏ID（需输验证码），群里消息才会转发进游戏', cat: '绑定', role: 'all' },
  { c: '#我的绑定', d: '查看自己已绑定的游戏ID', cat: '绑定', role: 'all' },
  { c: '#解绑 <游戏ID|all>', d: '解除绑定（all=全部）', cat: '绑定', role: 'all' },
  { c: '#强制解绑 <QQ号> [游戏ID]', d: '主人/管理员强制解除他人绑定（不带游戏ID则清空该QQ）', cat: '绑定', role: 'admin' },
  { c: '#记住 <内容>', d: '存入长期记忆（多条）', cat: '记忆', role: 'all' },
  { c: '#记忆 [关键词]', d: '查看/搜索记忆', cat: '记忆', role: 'all' },
  { c: '#忘记 <序号>', d: '删除某条长期记忆', cat: '记忆', role: 'all' },
  { c: '#清除记忆', d: '清空本会话全部记忆', cat: '记忆', role: 'all' },
  { c: '#clear', d: '同 #清除记忆', cat: '记忆', role: 'all' },
  { c: '#禁言 @或QQ号 [分钟]', d: '禁言成员（默认10分钟）', cat: '群管', role: 'admin' },
  { c: '#临时禁言 @或QQ号 [秒]', d: '临时禁言（默认60秒）', cat: '群管', role: 'admin' },
  { c: '#解禁 @或QQ号', d: '解除禁言', cat: '群管', role: 'admin' },
  { c: '#踢出 @或QQ号', d: '移出本群', cat: '群管', role: 'admin' },
  { c: '#拉黑 @或QQ号', d: '移出并拒绝再次入群', cat: '群管', role: 'admin' },
  { c: '#全体禁言 / #解除全体禁言', d: '开启/关闭全体禁言', cat: '群管', role: 'admin' },
  { c: '#群公告 <内容>', d: '发布群公告', cat: '群管', role: 'admin' },
  { c: '#撤回 [条数]', d: '引用我发的消息后发送可撤回它；带条数则连它前面我发的共撤回 <条数> 条', cat: '群管', role: 'admin' },
  { c: '#定时提醒 <时间> <内容>', d: '定时提醒（N分钟/N小时/HH:MM）', cat: '定时', role: 'admin' },
  { c: '#定时禁言 <@或QQ> <开始>-<结束>', d: '时间段禁言，每天重复', cat: '定时', role: 'admin' },
  { c: '#定时解禁 <@或QQ> <时间>', d: '定时解禁成员', cat: '定时', role: 'admin' },
  { c: '#定时列表', d: '查看定时任务', cat: '定时', role: 'admin' },
  { c: '#取消定时 <id>', d: '取消定时任务', cat: '定时', role: 'admin' },
  { c: '#授权 [@或QQ]', d: '查看授权列表 / 同意授权', cat: '主人', role: 'owner' },
  { c: '#余额', d: '查看 AI 账户余额（还剩多少钱）', cat: '主人', role: 'admin' },
  { c: '#拒绝授权 <@或QQ>', d: '拒绝授权申请', cat: '主人', role: 'owner' },
  { c: '#取消授权 <@或QQ>', d: '撤销授权', cat: '主人', role: 'owner' },
  { c: '#换名 <新昵称>', d: '修改机器人昵称', cat: '主人', role: 'owner' },
  { c: '#换头像 <图片>', d: '更换机器人头像（自动裁剪）', cat: '主人', role: 'owner' },
  { c: '#接管 / #恢复AI', d: '人工接管会话 / 恢复自动回复', cat: '主人', role: 'owner' },
  { c: '（引用申请通知）同意 / 拒绝', d: '进群、好友申请会自动私聊你，引用那条通知回复"同意"或"拒绝 [理由]"', cat: '主人', role: 'owner' },
  { c: '#同意 / #拒绝 <QQ号> [备注|理由]', d: '手动审批进群/好友申请（私聊里用；不方便引用通知时）', cat: '主人', role: 'owner' },
  { c: '#聊天记录 <QQ号 或 @某人> <文案>', d: '把多行内容合成一条合并转发卡片（每行一条，需授权）', cat: '工具', role: 'auth' },
  { c: '#screenshot / #截图', d: '本机屏幕截图', cat: '工具', role: 'auth' },
  { c: '#shot <网址>', d: '网址截图', cat: '工具', role: 'auth' },
];

const ALIAS_CAT = { '管理': ['群管', '定时', '主人'], '插件': ['工具'] };
/** #帮助 里查「权限档位表」的关键词 */
const TIER_ALIAS = ['权限', '档位', '角色', '身份', '等级', 'tier'];

/**
 * 权限档位定义（从高到低）。高档自动包含低档的全部命令：
 *   主人 ⊃ 管理员 ⊃ 授权用户 ⊃ 普通用户
 * role 与 permission.js 的 role() 一致；'all' 就是人人可用的公开命令。
 */
export const TIERS = [
  { role: 'owner', name: '👑 主人', note: '全部命令，含主人专属' },
  { role: 'admin', name: '🛡️ 管理员', note: '群管、定时、账务、强制解绑' },
  { role: 'auth', name: '✅ 授权用户', note: '公开命令 + 工具' },
  { role: 'all', name: '👤 普通用户', note: '公开命令' },
];

/** 档位表里的短命令名：只取第一个词（长参数/说明不占位） */
const shortCmd = (c) => String(c.c).split(' ')[0];

/** 权限档位表：从上到下逐档列出「本档新增」的命令 */
function tierTable() {
  const out = ['🪪 权限档位（从上到下，高档自动包含低档的全部命令）', ''];
  for (const t of TIERS) {
    // 纯说明条目（以「（」开头）不进表
    const names = [...new Set(HELP_CMDS.filter((c) => c.role === t.role && !c.c.startsWith('（')).map(shortCmd))];
    out.push(`${t.name}：${t.note}`);
    out.push(`  ${names.join(' ')}`);
    out.push('');
  }
  out.push('菜单会按你的身份过滤——只显示你有权用的命令。');
  return out.join('\n');
}

/** 生成帮助文本：role 为 'owner'|'admin'|'authorized'|'guest' */
export function buildHelp(role, arg) {
  const allow = (c) =>
    c.role === 'all' ||
    (c.role === 'auth' && role !== 'guest') ||
    (c.role === 'admin' && (role === 'admin' || role === 'owner')) ||
    (c.role === 'owner' && role === 'owner');
  const cmds = HELP_CMDS.filter(allow);
  const a = String(arg || '').trim();

  if (!a) {
    const cats = [...new Set(cmds.map((c) => c.cat))];
    const line = cats.map((cat) => `${cat}(${cmds.filter((c) => c.cat === cat).length})`).join(' · ');
    return `🤖 #帮助 分类：${line}\n用法：#帮助 <分类> 或 #帮助 <关键词>（如 #帮助 记忆 / #帮助 禁言）`;
  }

  const parts = a.split(/\s+/);
  let page = 1;
  if (/^\d+$/.test(parts[parts.length - 1])) page = Number(parts.pop());
  const kw = parts.join(' ').trim();

  // 权限档位表：主人 / 管理员 / 授权用户 / 普通用户
  if (TIER_ALIAS.includes(kw.toLowerCase())) return tierTable();

  let list = [];
  const cats = ALIAS_CAT[kw] || [kw];
  for (const cat of cats) list = list.concat(cmds.filter((c) => c.cat === cat));
  if (!list.length) list = cmds.filter((c) => c.c === kw || c.c.startsWith(kw));
  if (!list.length) list = cmds.filter((c) => (c.c + ' ' + c.d).includes(kw));
  if (!list.length) return `❌ 没有找到与 "${a}" 相关的内容，试试 #帮助 查看分类。`;

  const PER = 12;
  const total = list.length, pages = Math.ceil(total / PER);
  if (page > pages) page = pages;
  const slice = list.slice((page - 1) * PER, page * PER);
  const head = list.length === 1 && (list[0].c === kw || list[0].c.startsWith(kw))
    ? `🔍 ${kw}：`
    : `${ALIAS_CAT[kw] || cats.includes(kw) ? '📋' : '🔍'} ${kw}（${total} 条${pages > 1 ? '，第 ' + page + '/' + pages + ' 页' : ''}）`;
  const body = slice.map((c) => `${c.c}  ${c.d}`).join('\n');
  const tail = pages > 1 ? `\n更多： #帮助 ${kw} ${page < pages ? page + 1 : 1}` : '';
  return head + '\n' + body + tail;
}
