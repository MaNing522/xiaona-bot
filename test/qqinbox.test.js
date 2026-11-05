import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordIncoming, recordOutgoing, listConversations,
  getMessages, markRead, setConvName, resetInbox,
} from '../src/qqInbox.js';

describe('网页 QQ 收件箱', () => {
  beforeEach(() => resetInbox());

  it('记录收到的消息并按时间倒序列出会话', () => {
    recordIncoming({ kind: 'group', id: 10001, senderId: 20001, senderName: '小明', text: '在吗', t: 1000 });
    recordIncoming({ kind: 'private', id: 30001, name: '小红', senderId: 30001, senderName: '小红', text: '你好', t: 2000 });
    const list = listConversations();
    expect(list.length).toBe(2);
    expect(list[0].key).toBe('p:30001');
    expect(list[0].lastText).toBe('你好');
    expect(list[1].key).toBe('g:10001');
    expect(list[1].lastSender).toBe('小明');
    expect(list[1].unread).toBe(1);
  });

  it('发出的消息不进未读数，也能按 id 增量取', () => {
    const a = recordIncoming({ kind: 'group', id: 10001, senderName: '小明', text: '早' });
    const b = recordOutgoing('g:10001', '早呀');
    expect(listConversations()[0].unread).toBe(1);
    expect(getMessages('g:10001', a.id)).toEqual([b]);
    expect(getMessages('g:10001', 0).length).toBe(2);
  });

  it('打开会话后未读清零', () => {
    recordIncoming({ kind: 'group', id: 10001, text: '1' });
    recordIncoming({ kind: 'group', id: 10001, text: '2' });
    markRead('g:10001');
    expect(listConversations()[0].unread).toBe(0);
  });

  it('会话名可被群名/好友备注覆盖', () => {
    recordIncoming({ kind: 'private', id: 30001, senderName: '昵称', text: 'hi' });
    setConvName('p:30001', '备注名');
    expect(listConversations()[0].name).toBe('备注名');
  });

  it('每个会话最多保留 300 条，超出丢最旧的', () => {
    for (let i = 0; i < 310; i++) {
      recordIncoming({ kind: 'private', id: 30001, text: 'm' + i, t: i });
    }
    const all = getMessages('p:30001', 0);
    expect(all.length).toBe(300);
    expect(all[0].text).toBe('m10');
    expect(all[299].text).toBe('m309');
  });

  it('会话数量上限 200，超出丢最久没消息的', () => {
    for (let i = 0; i < 205; i++) {
      recordIncoming({ kind: 'private', id: 10000 + i, text: 'x', t: i });
    }
    const list = listConversations();
    expect(list.length).toBe(200);
    expect(list.map((c) => c.id)).not.toContain('10000');
  });

  it('空消息、非法 key 不记录', () => {
    expect(recordIncoming({ kind: 'group', id: 10001, text: '' })).toBe(null);
    expect(recordOutgoing('x:123', 'hi')).toBe(null);
    expect(recordOutgoing('g:12', 'hi')).toBe(null);
    expect(listConversations().length).toBe(0);
  });
});
