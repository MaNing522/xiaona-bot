import { describe, it, expect } from 'vitest';
import { randomDelayMs, normalizeQzone, qzoneStatus, postQzoneNow, flattenComments, pickNewComments } from '../src/qzone.js';

const DAY = 24 * 60 * 60 * 1000;

describe('QQ 空间自动说说', () => {
  it('随机间隔落在设定天数范围内', () => {
    expect(randomDelayMs(1, 7, () => 0)).toBe(DAY);
    expect(randomDelayMs(1, 7, () => 1)).toBe(7 * DAY);
    expect(randomDelayMs(1, 7, () => 0.5)).toBe(4 * DAY);
  });

  it('参数校正：天数夹在 1~7，min/max 颠倒时自动交换', () => {
    const q = normalizeQzone({ minDays: 9, maxDays: 0, commentEvery: 99, checkMinutes: 1, maxLength: 1 });
    expect(q.minDays).toBe(1);
    expect(q.maxDays).toBe(7);
    expect(q.commentEvery).toBe(10);
    expect(q.checkMinutes).toBe(5);
    expect(q.maxLength).toBe(20);
  });

  it('未知查看权限回落到公开，开关默认开启', () => {
    const q = normalizeQzone({ ugcRight: 9999 });
    expect(q.ugcRight).toBe(1);
    expect(q.enabled).toBe(true);
    expect(normalizeQzone({ enabled: false }).enabled).toBe(false);
    expect(normalizeQzone({ replyComments: false }).replyComments).toBe(false);
  });

  it('状态里带当前参数和调度信息', () => {
    const s = qzoneStatus();
    expect(s).toHaveProperty('nextAt');
    expect(s).toHaveProperty('postCount');
    expect(s.commentEvery).toBeGreaterThanOrEqual(0);
    expect([1, 4, 64]).toContain(s.ugcRight);
  });

  it('未初始化时手动发布给出明确错误', async () => {
    await expect(postQzoneNow()).rejects.toThrow('机器人未连接');
  });

  it('评论拍平：一级评论带昵称，二级回复标注回复谁，空内容剔除', () => {
    const list = flattenComments([
      {
        comment_id: 'c1',
        uin: 111,
        name: '阿伟',
        content: '真好听\n我也想唱',
        replies: [{ comment_id: 'r1', uin: 222, name: '小美', content: '那就来啊' }],
      },
      { comment_id: 'c2', uin: 999, name: '小钠', content: '自己接一句' },
      { comment_id: 'c3', uin: 333, name: '', content: '   ' },
      null,
    ]);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ id: 'c1', uin: '111', name: '阿伟', content: '真好听 我也想唱', replyTo: '' });
    expect(list[1]).toMatchObject({ id: 'c1/r1', uin: '222', name: '小美', content: '那就来啊', replyTo: '阿伟' });
    expect(list[2]).toMatchObject({ id: 'c2', uin: '999', name: '小钠', replyTo: '' });
    expect(list[3]).toMatchObject({ id: 'c3', name: '好友', content: '' });
    expect(flattenComments(null)).toEqual([]);
  });

  it('挑新评论：剔除自己的评论、已知 id 和空内容', () => {
    const detail = [
      {
        comment_id: 'c1',
        uin: 111,
        name: '阿伟',
        content: '真好听',
        replies: [{ comment_id: 'r1', uin: 222, name: '小美', content: '那就来啊' }],
      },
      { comment_id: 'c2', uin: 999, name: '小钠', content: '自己接一句' },
      { comment_id: 'c3', uin: 333, name: '路人', content: '   ' },
    ];
    const fresh = pickNewComments(detail, '999', new Set(['c1']));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ id: 'c1/r1', name: '小美', replyTo: '阿伟' });
    // knownIds 传数组也照常处理
    expect(pickNewComments(detail, '999', ['c1', 'c1/r1'])).toEqual([]);
    expect(pickNewComments(null, '999', [])).toEqual([]);
  });
});
