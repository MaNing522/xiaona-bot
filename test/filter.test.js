import { describe, it, expect } from 'vitest';
import { parseSensitiveWords, maskSensitive } from '../src/filter.js';

describe('敏感词过滤', () => {
  it('词表支持多种分隔符并去重', () => {
    expect(parseSensitiveWords('傻逼，sb、外挂; 代练\n傻逼|加群')).toEqual(['傻逼', 'sb', '外挂', '代练', '加群']);
  });

  it('命中后替换成占位符，英文不区分大小写', () => {
    const opt = { enabled: true, words: 'sb,外挂', replace: '***' };
    expect(maskSensitive('你个SB，还开外挂？', opt)).toBe('你个***，还开***？');
    expect(maskSensitive('SbSb', opt)).toBe('******');
  });

  it('关闭或词表为空时原样返回', () => {
    expect(maskSensitive('正常聊天', { enabled: false, words: '聊天' })).toBe('正常聊天');
    expect(maskSensitive('正常聊天', { enabled: true, words: '' })).toBe('正常聊天');
  });

  it('词里的正则元字符按普通字符匹配', () => {
    expect(maskSensitive('a.b axb', { words: 'a.b', replace: '#' })).toBe('# axb');
  });
});
