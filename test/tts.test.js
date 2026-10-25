// tts.js / edgeDrm.js 的单测：Sec-MS-GEC 令牌格式与已知向量、SSML 转义、
// 小米 MiMo TTS 请求体与 emoji 清洗（真实合成依赖网络，单测只 mock fetch）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSsml, secMsGec, stripEmoji, buildXiaomiRequest, ttsProvider, textToSpeech } from '../src/tts.js';
import { generateSecMsGec } from '../src/edgeDrm.js';
import fs from 'fs';

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

  it('带上音量，不传时默认 +0%', () => {
    expect(buildSsml('你好', 'zh-CN-XiaoxiaoNeural', '+0%', '+100%')).toContain("volume='+100%'");
    expect(buildSsml('你好', 'zh-CN-XiaoxiaoNeural', '+0%')).toContain("volume='+0%'");
  });

  it('对文本里的 XML 特殊字符做转义', () => {
    const s = buildSsml('a < b & c > d', 'zh-CN-XiaoxiaoNeural', '+0%');
    expect(s).toContain('a &lt; b &amp; c &gt; d');
  });
});

describe('stripEmoji（语音里不带表情）', () => {
  it('去掉 emoji，保留文字与风格标签', () => {
    expect(stripEmoji('(俏皮)你好呀😊，今天天气不错🌤️！')).toBe('(俏皮)你好呀，今天天气不错！');
  });

  it('纯表情返回空串', () => {
    expect(stripEmoji('😂😂🎉')).toBe('');
  });

  it('不动普通标点和中文', () => {
    expect(stripEmoji('（唱歌）原谅我这一生不羁放纵爱自由，也会怕有一天会跌倒。'))
      .toBe('（唱歌）原谅我这一生不羁放纵爱自由，也会怕有一天会跌倒。');
  });
});

describe('buildXiaomiRequest（小米 MiMo TTS）', () => {
  it('目标文本放 assistant，音频格式 mp3，音色透传', () => {
    const req = buildXiaomiRequest('(唱歌)原谅我这一生不羁放纵爱自由', '冰糖');
    expect(req.model).toBe('mimo-v2.5-tts');
    expect(req.audio).toEqual({ format: 'mp3', voice: '冰糖' });
    expect(req.messages.at(-1)).toEqual({ role: 'assistant', content: '(唱歌)原谅我这一生不羁放纵爱自由' });
  });

  it('给了自然语言指令就放在 user 里（不会被读出来）', () => {
    const req = buildXiaomiRequest('你好', '冰糖', undefined, '用轻快的语气');
    expect(req.messages[0]).toEqual({ role: 'user', content: '用轻快的语气' });
    expect(req.messages.at(-1).role).toBe('assistant');
  });
});

describe('ttsProvider（后端选择）', () => {
  let saved;
  beforeEach(() => {
    saved = { p: process.env.TTS_PROVIDER, k: process.env.MIMO_API_KEY };
    delete process.env.TTS_PROVIDER;
    delete process.env.MIMO_API_KEY;
  });
  afterEach(() => {
    for (const [k, v] of [['TTS_PROVIDER', saved.p], ['MIMO_API_KEY', saved.k]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('没配任何东西时回退 Edge', () => {
    expect(ttsProvider()).toBe('edge');
  });

  it('有小米 key 默认用小米', () => {
    process.env.MIMO_API_KEY = 'sk-test';
    expect(ttsProvider()).toBe('xiaomi');
  });

  it('显式配 TTS_PROVIDER 时听配置的', () => {
    process.env.MIMO_API_KEY = 'sk-test';
    process.env.TTS_PROVIDER = 'edge';
    expect(ttsProvider()).toBe('edge');
  });
});

describe('textToSpeech（小米后端，mock fetch）', () => {
  let saved, file;
  beforeEach(() => {
    saved = { p: process.env.TTS_PROVIDER, k: process.env.MIMO_API_KEY, v: process.env.TTS_XIAOMI_VOICE };
    process.env.TTS_PROVIDER = 'xiaomi';
    process.env.MIMO_API_KEY = 'sk-test';
    delete process.env.TTS_XIAOMI_VOICE;
  });
  afterEach(() => {
    for (const [k, val] of [['TTS_PROVIDER', saved.p], ['MIMO_API_KEY', saved.k], ['TTS_XIAOMI_VOICE', saved.v]]) {
      if (val === undefined) delete process.env[k]; else process.env[k] = val;
    }
    if (file) { try { fs.unlinkSync(file); } catch { /* 可能已删 */ } }
    vi.unstubAllGlobals();
  });

  it('请求里去掉 emoji、音色用冰糖，返回 mp3 文件', async () => {
    const mp3 = Buffer.from('ID3\u0004\u0000\u0000\u0000');
    let body = null;
    vi.stubGlobal('fetch', vi.fn(async (_url, opt) => {
      body = JSON.parse(opt.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { audio: { data: mp3.toString('base64') } } }] }) };
    }));

    file = await textToSpeech('(俏皮)你好呀😊');
    expect(body.audio).toEqual({ format: 'mp3', voice: '冰糖' });
    expect(body.messages.at(-1).content).toBe('(俏皮)你好呀');
    expect(file.endsWith('.mp3')).toBe(true);
    expect(fs.readFileSync(file).equals(mp3)).toBe(true);
  });

  it('唱歌的风格指令放进 user，不污染 (唱歌) 标签', async () => {
    let body = null;
    vi.stubGlobal('fetch', vi.fn(async (_url, opt) => {
      body = JSON.parse(opt.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('x').toString('base64') } } }] }) };
    }));

    file = await textToSpeech('(唱歌)原谅我这一生', null, '用温柔的感觉唱');
    expect(body.messages[0]).toEqual({ role: 'user', content: '用温柔的感觉唱' });
    expect(body.messages.at(-1).content).toBe('(唱歌)原谅我这一生');
  });
});
