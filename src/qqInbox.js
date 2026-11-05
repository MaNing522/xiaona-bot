// ============================================================
// qqInbox.js - 网页 QQ 客户端的内存收件箱
// 只保留最近的消息，供网页按会话查看；不落盘，机器人重启即清空。
// ============================================================
const MAX_CONVS = 200;      // 最多保留的会话数（超了丢最久没消息的）
const MAX_MSGS = 300;       // 每个会话最多保留的消息条数

const convs = new Map();    // key -> { key, kind, id, name, messages: [], unread, lastAt }
let seq = 0;                // 全局递增的消息 id，前端用它做增量拉取

function convKey(kind, id) {
    return (kind === 'group' ? 'g:' : 'p:') + String(id);
}

function ensureConv(key, kind, id) {
    let c = convs.get(key);
    if (c) return c;
    if (convs.size >= MAX_CONVS) {
        // Map 保持插入顺序，但会话可能被反复更新；按最后消息时间找最旧的删
        let oldest = '';
        let oldestAt = Infinity;
        for (const [k, v] of convs) {
            if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldest = k; }
        }
        if (oldest) convs.delete(oldest);
    }
    c = { key, kind, id: String(id), name: '', messages: [], unread: 0, lastAt: 0 };
    convs.set(key, c);
    return c;
}

function pushMsg(c, m) {
    c.messages.push(m);
    if (c.messages.length > MAX_MSGS) c.messages.splice(0, c.messages.length - MAX_MSGS);
    c.lastAt = m.t;
}

/** 记一条收到的消息（群聊或私聊） */
export function recordIncoming({ kind, id, name = '', senderId = '', senderName = '', text = '', t = Date.now() }) {
    const body = String(text || '');
    if (!body || (kind !== 'group' && kind !== 'private')) return null;
    const key = convKey(kind, id);
    const c = ensureConv(key, kind, id);
    if (name && !c.name) c.name = String(name);
    const m = {
        id: ++seq,
        dir: 'in',
        senderId: String(senderId || ''),
        senderName: String(senderName || ''),
        text: body,
        t: Number.isFinite(Number(t)) ? Number(t) : Date.now(),
    };
    pushMsg(c, m);
    c.unread = (c.unread || 0) + 1;
    return m;
}

/** 记一条机器人发出的消息（AI 回复、网页发送、群通知等） */
export function recordOutgoing(key, text, name = '', t = Date.now()) {
    const body = String(text || '');
    const k = String(key || '');
    const hit = k.match(/^(g|p):(\d{5,14})$/);
    if (!body || !hit) return null;
    const kind = hit[1] === 'g' ? 'group' : 'private';
    const c = ensureConv(k, kind, hit[2]);
    if (name && !c.name) c.name = String(name);
    const m = {
        id: ++seq,
        dir: 'out',
        senderId: '',
        senderName: '小钠',
        text: body,
        t: Number.isFinite(Number(t)) ? Number(t) : Date.now(),
    };
    pushMsg(c, m);
    return m;
}

/** 用外部名单（群名/好友备注）补会话显示名 */
export function setConvName(key, name) {
    const c = convs.get(String(key || ''));
    if (c && name) c.name = String(name);
}

/** 会话列表：按最后消息时间倒序，带未读数与最后一条预览 */
export function listConversations() {
    return [...convs.values()]
        .sort((a, b) => b.lastAt - a.lastAt)
        .map((c) => {
            const last = c.messages[c.messages.length - 1] || null;
            return {
                key: c.key,
                kind: c.kind,
                id: c.id,
                name: c.name,
                unread: c.unread,
                lastAt: c.lastAt,
                lastText: last ? last.text : '',
                lastSender: last ? last.senderName : '',
                count: c.messages.length,
            };
        });
}

/** 取某会话的消息；afterId 用于增量拉取（只返回 id 更大的） */
export function getMessages(key, afterId = 0) {
    const c = convs.get(String(key || ''));
    if (!c) return [];
    const after = Number(afterId) || 0;
    return c.messages.filter((m) => m.id > after);
}

/** 会话是否存在 */
export function hasConversation(key) {
    return convs.has(String(key || ''));
}

/** 打开会话即把未读清零 */
export function markRead(key) {
    const c = convs.get(String(key || ''));
    if (c) c.unread = 0;
}

/** 会话显示名（没有就返回空串） */
export function convName(key) {
    const c = convs.get(String(key || ''));
    return (c && c.name) || '';
}

/** 测试用：清空所有会话 */
export function resetInbox() {
    convs.clear();
    seq = 0;
}
