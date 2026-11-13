// asrSherpa.js 的单测：WAV 解析（asr.js 上传的就是 wav）与 multipart 拆包。
import { describe, it, expect } from 'vitest';
import { decodeWav, parseMultipart } from '../src/asrSherpa.js';

/** 拼一个最小可用的 WAV：PCM 16bit / 指定声道数 / 指定采样率 / 每声道固定样本 */
function makeWav({ sampleRate = 8000, channels = 1, frames = 100, value = 16384 } = {}) {
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(value, i * 2);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);                 // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * 2, 16);
  fmt.writeUInt16LE(channels * 2, 20);
  fmt.writeUInt16LE(16, 22);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'ascii');
  dataHead.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dataHead, data]);
}

describe('decodeWav', () => {
  it('解析单声道 16bit PCM，样本归一化到 [-1,1]', () => {
    const w = decodeWav(makeWav({ frames: 128, value: 16384 }));
    expect(w).toBeTruthy();
    expect(w.sampleRate).toBe(8000);
    expect(w.samples.length).toBe(128);
    expect(w.samples[0]).toBeCloseTo(0.5, 5);
  });

  it('多声道会平均混成单声道', () => {
    const w = decodeWav(makeWav({ channels: 2, frames: 64 }));
    expect(w.channels).toBeUndefined();
    expect(w.samples.length).toBe(64);
    expect(w.samples[0]).toBeCloseTo(0.5, 5);
  });

  it('不是 wav 时返回 null', () => {
    expect(decodeWav(Buffer.from('not a wave file at all, definitely'))).toBeNull();
  });
});

describe('parseMultipart', () => {
  it('取出 file 字段的字节与文件名', () => {
    const boundary = '----testboundary';
    const audio = Buffer.from([1, 2, 3, 4, 5]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nparaformer\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      audio,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const parts = parseMultipart(body, boundary);
    const file = parts.find((p) => p.name === 'file');
    expect(file).toBeTruthy();
    expect(file.filename).toBe('audio.wav');
    expect(Buffer.compare(file.data, audio)).toBe(0);
    expect(parts.find((p) => p.name === 'model').data.toString()).toBe('paraformer');
  });
});
