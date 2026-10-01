// ============================================================
// captcha.js - 四位数字图形验证码（零依赖，输出 PNG）
//
// 供 #绑定 做人机校验：5x7 位图字模 + 随机倾斜/抖动/笔画粗细 + 噪点与干扰线，
// PNG 用 zlib 手工编码（不引入 canvas / sharp 之类需要编译的依赖）。
// ============================================================
import zlib from 'zlib';

// 5x7 位图字模
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

// 数字用的深色系（随机取一个，保证与浅色背景对比足够）
const INK = [
  [192, 32, 32], [24, 80, 200], [16, 130, 64],
  [140, 40, 160], [190, 110, 10], [26, 26, 36],
];
// 干扰线用低对比灰蓝，避免把字糊掉
const NOISE_LINE = [[150, 170, 200], [190, 160, 150], [160, 200, 170], [200, 180, 200]];

const rnd = (n) => Math.floor(Math.random() * n);
const rndInt = (lo, hi) => lo + rnd(hi - lo + 1);

/** 极简 RGB 画布 */
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 3, 255);
  }
  set(x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b;
  }
  /** 铺满 */
  fill(r, g, b) {
    for (let i = 0; i < this.px.length; i += 3) { this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; }
  }
  /** Bresenham 直线（带粗细） */
  line(x0, y0, x1, y1, col, thick = 1) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    for (let guard = 0; guard < 5000; guard++) {
      for (let oy = 0; oy < thick; oy++) for (let ox = 0; ox < thick; ox++) this.set(x + ox, y + oy, col[0], col[1], col[2]);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }
}

/** 画一个字符：先按行做水平错切（看起来是斜体），再按随机抖动落点 */
function drawChar(c, rows, x0, y0, scale, col) {
  const dh = rows.length * scale;
  const skew = (Math.random() - 0.5) * 0.7;
  for (let fy = 0; fy < rows.length; fy++) {
    const shift = Math.round(skew * (fy * scale - dh / 2));
    for (let fx = 0; fx < rows[fy].length; fx++) {
      if (rows[fy][fx] !== '1') continue;
      const x = x0 + fx * scale + shift;
      const y = y0 + fy * scale;
      const extra = Math.random() < 0.3 ? 1 : 0; // 笔画粗细抖动
      for (let dy = 0; dy <= scale - 1 + extra; dy++) {
        for (let dx = 0; dx <= scale - 1 + extra; dx++) {
          c.set(x + dx, y + dy, col[0], col[1], col[2]);
        }
      }
    }
  }
}

/**
 * 生成验证码图片。
 * @param {string} text 要绘制的字符（只支持 0-9）
 * @returns {Buffer} PNG 数据
 */
export function renderCaptcha(text) {
  const W = 176, H = 64;
  const c = new Canvas(W, H);
  c.fill(248, 249, 252);

  // 背景噪点
  for (let i = 0; i < 700; i++) {
    const v = 205 + rnd(50);
    c.set(rnd(W), rnd(H), v, v, v);
  }

  // 数字
  const chars = String(text).split('');
  const scale = 6, dw = 5 * scale, dh = 7 * scale;
  const margin = 14;
  const gap = Math.max(2, Math.floor((W - margin * 2 - dw * chars.length) / Math.max(1, chars.length - 1)));
  const baseY = Math.round((H - dh) / 2);
  chars.forEach((ch, i) => {
    const rows = FONT[ch];
    if (!rows) return;
    drawChar(c, rows, margin + i * (dw + gap) + rndInt(-4, 4), baseY + rndInt(-7, 7), scale, INK[rnd(INK.length)]);
  });

  // 干扰线（细、低对比，只求干扰 OCR，不影响人眼）
  for (let i = 0; i < 3; i++) {
    const col = NOISE_LINE[rnd(NOISE_LINE.length)];
    c.line(rndInt(0, 20), rndInt(0, H - 1), rndInt(W - 20, W - 1), rndInt(0, H - 1), col, 1);
  }

  // 前景噪点
  for (let i = 0; i < 160; i++) {
    const col = INK[rnd(INK.length)];
    c.set(rnd(W), rnd(H), col[0], col[1], col[2]);
  }

  return encodePng(W, H, c.px);
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

/** RGB 像素缓冲 → PNG（8 位真彩、无隔行、每行 filter=0） */
export function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}