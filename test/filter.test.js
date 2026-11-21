import { describe, it, expect } from 'vitest';
import { parseSensitiveWords, maskSensitive } from '../src/filter.js';
import { maskByWords } from '../src/tencentWords.js';

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

describe('腾讯词库匹配', () => {
  it('取最长匹配并跳过单字词', () => {
    const words = ['妈', '六四', '六四事件', '台独'];
    expect(maskByWords('我妈说六四事件和台独都不该聊', words, '***'))
      .toBe('我妈说***和***都不该聊');
  });

  it('英文不区分大小写', () => {
    expect(maskByWords('Fuck this', ['fuck'], '#')).toBe('# this');
  });

  it('单字词只在独立出现时屏蔽，不误伤正常词', () => {
    expect(maskByWords('操作和体操', ['操'], '***')).toBe('操作和体操');
    expect(maskByWords('操', ['操'], '***')).toBe('***');
    expect(maskByWords('小明：操！', ['操'], '***')).toBe('小明：***！');
  });

  it('日常口头禅和短缩写不处理', () => {
    const words = ['他妈', '他妈的', '你他妈', 'c', 'cnm', 'mb', 'tmd'];
    expect(maskByWords('你他妈在干嘛', words, '***')).toBe('你他妈在干嘛');
    expect(maskByWords('cnm mb c tmd', words, '***')).toBe('cnm mb c tmd');
    // 更长的词条仍然优先命中
    expect(maskByWords('他妈的政府', [...words, '他妈的政府'], '***')).toBe('***');
  });
});
