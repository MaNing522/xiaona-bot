// asr.js 的单测：同音纠正表解析、识别结果纠正，以及上传给 FunASR 的请求参数。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseFixList, fixText, transcribe, wavDurationSec } from '../src/asr.js';
import { config } from '../src/config.js';

describe('parseFixList', () => {
  it('没写等号的项算作目标名的错写', () => {
    const m = parseFixList('小娜,小纳', '小钠');
    expect(m.get('小娜')).toBe('小钠');
    expect(m.get('小纳')).toBe('小钠');
  });

  it('写「错字=正确词」则精确映射', () => {
    const m = parseFixList('小娜=小钠,逮佬=大佬', '小钠');
    expect(m.get('小娜')).toBe('小钠');
    expect(m.get('逮佬')).toBe('大佬');
  });

  it('目标名本身不映射（本来就是对的不再改）', () => {
    const m = parseFixList('小钠,小娜', '小钠');
    expect(m.has('小钠')).toBe(false);
    expect(m.get('小娜')).toBe('小钠');
  });

  it('支持中文逗号/分号/换行分隔，忽略空白项', () => {
    const m = parseFixList('小娜，小纳; 小呐\n\n小那', '小钠');
    expect(m.size).toBe(4);
    expect(m.get('小那')).toBe('小钠');
  });

  it('没配目标名时只认精确映射', () => {
    const m = parseFixList('小娜,小纳=奶妈', '');
    expect(m.has('小娜')).toBe(false);
    expect(m.get('小纳')).toBe('奶妈');
  });
});

describe('fixText', () => {
  const cfg = { canonicalName: '小钠', homophones: '小娜,小纳,小呐' };

  it('把错字改回机器人名字', () => {
    expect(fixText('小娜你好呀', cfg)).toBe('小钠你好呀');
    expect(fixText('小纳在吗', cfg)).toBe('小钠在吗');
  });

  it('一句话里出现多次也全部替换', () => {
    expect(fixText('小娜小娜小娜', cfg)).toBe('小钠小钠小钠');
  });

  it('长词优先，避免长词被短词先替换成半截', () => {
    expect(fixText('小娜子', { canonicalName: '小钠', homophones: '小娜,小娜子' })).toBe('小钠');
  });

  it('空文本 / 空配置原样返回', () => {
    expect(fixText('', cfg)).toBe('');
    expect(fixText('小娜', { canonicalName: '', homophones: '' })).toBe('小娜');
    expect(fixText('小娜', { canonicalName: '小钠' })).toBe('小娜');   // 没列错字就不动
  });
});

describe('transcribe（上传给 FunASR 的请求）', () => {
  let savedModel, savedUrl, savedEnabled, savedKey, savedProvider, file;

  beforeEach(() => {
    savedModel = process.env.ASR_MODEL;
    savedUrl = process.env.ASR_URL;
    savedEnabled = process.env.ASR_ENABLED;
    savedKey = process.env.MIMO_API_KEY;
    savedProvider = config().asr.provider;
    delete process.env.ASR_MODEL;      // 用默认模型名
    delete process.env.ASR_URL;        // 走默认地址
    delete process.env.MIMO_API_KEY;   // 这组用例默认不用小米
    process.env.ASR_ENABLED = 'true';
    config().asr.provider = 'local';
    file = path.join(os.tmpdir(), `asr-test-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    fs.writeFileSync(file, Buffer.from('RIFF0000WAVEfmt '));
  });

  afterEach(() => {
    for (const [k, v] of [['ASR_MODEL', savedModel], ['ASR_URL', savedUrl], ['ASR_ENABLED', savedEnabled], ['MIMO_API_KEY', savedKey]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    config().asr.provider = savedProvider;
    try { fs.unlinkSync(file); } catch { /* 可能已删 */ }
    vi.unstubAllGlobals();
  });

  it('模型名用服务端认识的 sensevoice，识别结果做同音纠正', async () => {
    let sentModel = '';
    vi.stubGlobal('fetch', vi.fn(async (url, opt) => {
      sentModel = opt.body.get('model');
      return { ok: true, status: 200, json: async () => ({ text: '小娜你好' }) };
    }));

    const t = await transcribe({ path: file, format: 'wav' });
    expect(sentModel).toBe('sensevoice');
    expect(t).toBe('小钠你好');
  });

  it('服务端返回 400 时返回 null（不抛错，语音按 [语音] 占位）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"detail":"Unknown model \'iic/SenseVoiceSmall\'"}',
    })));

    const t = await transcribe({ path: file, format: 'wav' });
    expect(t).toBeNull();
  });

  it('provider=mimo：优先走小米 V2.5-ASR（input_audio），结果做同音纠正', async () => {
    config().asr.provider = 'mimo';
    process.env.MIMO_API_KEY = 'sk-test';
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opt) => {
      calls.push({ url: String(url), body: typeof opt.body === 'string' ? JSON.parse(opt.body) : null });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '小娜你好' } }] }) };
    }));

    const t = await transcribe({ path: file, format: 'wav' });
    expect(t).toBe('小钠你好');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('xiaomimimo.com');
    expect(calls[0].body.model).toBe('mimo-v2.5-asr');
    const part = calls[0].body.messages[0].content[0];
    expect(part.type).toBe('input_audio');
    expect(part.input_audio.data.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('provider=mimo：小米失败时自动降级到本地识别', async () => {
    config().asr.provider = 'mimo';
    process.env.MIMO_API_KEY = 'sk-test';
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).includes('xiaomimimo.com')) {
        return { ok: false, status: 500, text: async () => 'boom' };
      }
      return { ok: true, status: 200, json: async () => ({ text: '小娜在吗' }) };
    }));

    const t = await transcribe({ path: file, format: 'wav' });
    expect(t).toBe('小钠在吗');
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('127.0.0.1:8899');
  });
});

/** 造一个只有头和 payload 的假 wav：16kHz / 单声道 / 16bit，byteRate = 32000 */
function fakeWav(seconds) {
  const dataLen = Math.round(32000 * seconds);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

describe('wavDurationSec', () => {
  it('按 wav 头算出时长', () => {
    expect(wavDurationSec(fakeWav(12))).toBeCloseTo(12, 3);
    expect(wavDurationSec(fakeWav(45))).toBeCloseTo(45, 3);
  });

  it('不是 wav 返回 null', () => {
    expect(wavDurationSec(Buffer.from('not a wav file at all, just text'))).toBeNull();
    expect(wavDurationSec(null)).toBeNull();
  });
});
