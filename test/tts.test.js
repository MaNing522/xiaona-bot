// tts.js / edgeDrm.js 的单测：Sec-MS-GEC 令牌格式与已知向量、SSML 转义（真实合成依赖网络，单测不覆盖）。
import { describe, it, expect } from 'vitest';
import { buildSsml, secMsGec } from '../tts.js';
import { generateSecMsGec } from '../edgeDrm.js';

describe('generateSecMsGec（Edge v2 令牌）', () => {
  it('格式为「16 位 CS64-64 位 SHA256」且均大写十六进制', () => {
    expect(generateSecMsGec(1792161067.7118862))
      .toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
  });

  it('与 edge-tts 已知向量逐字节一致', () => {
    expect(generateSecMsGec(1792161067.7118862))
      .toBe('2B6DDEEA76A1A33C-915F924AF53F46DA74F5441A1E184A160FE5187168130ED4D644B226E4D961BA');
    expect(generateSecMsGec(1734567890))
      .toBe('02294598C02B41ED-2395D36DBE30757EEE5C76DDF777BA51E939BA9B7C706AAA1A627C5206FF126E');
  });

  it('同一 5 分钟档内令牌稳定，跨档则变化', () => {
    expect(generateSecMsGec(1700000000)).toBe(generateSecMsGec(1700000050));
    expect(generateSecMsGec(1700000000)).not.toBe(generateSecMsGec(1700000100));
  });
});

describe('secMsGec', () => {
  it('返回 v2 格式的令牌', () => {
    expect(secMsGec()).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
  });
});

describe('buildSsml', () => {
  it('带上音色与语速', () => {
    const s = buildSsml('你好', 'zh-CN-XiaoxiaoNeural', '+8%');
    expect(s).toContain("name='zh-CN-XiaoxiaoNeural'");
    expect(s).toContain("rate='+8%'");
  });

  it('对文本里的 XML 特殊字符做转义', () => {
    const s = buildSsml('a < b & c > d', 'zh-CN-XiaoxiaoNeural', '+0%');
    expect(s).toContain('a &lt; b &amp; c &gt; d');
  });
});
