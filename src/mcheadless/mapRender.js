// ============================================================
// mapRender.js - 把附近地形画成俯视 PNG（零第三方依赖，自带 PNG 编码）
//
// 扫描已加载区块里每一列的最高实心方块，按方块类型上色、按高度做明暗，
// 玩家自己画红点、其他玩家画橙点。返回 { file, summary, ... }：
//   · file    PNG 落盘路径（默认放在状态文件同级的 maps/ 下，保留最近 20 张）
//   · summary 一段中文地形摘要，给 AI 直接读
// 控制口 /cmd 的 map 指令调用；不依赖 canvas、sharp 之类的原生模块。
// ============================================================
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { Vec3 } = require('vec3')

// ---------- 极简 PNG 编码（RGBA，无滤波） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0)
  return Buffer.concat([len, name, data, crc])
}

/** RGBA 像素 → PNG Buffer */
function encodePng (width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 方块 → 颜色 ----------
const COLORS = [
  [/lava/, [216, 74, 27]],
  [/water/, [47, 111, 208]],
  [/snow|powder_snow/, [235, 244, 255]],
  [/ice/, [169, 215, 239]],
  [/grass_block|moss_block|moss_carpet/, [88, 140, 60]],
  [/leaves/, [45, 105, 45]],
  [/log|wood|planks|fence|door|stairs/, [122, 86, 50]],
  [/sand/, [224, 208, 138]],
  [/gravel/, [150, 148, 142]],
  [/dirt|podzol|mud|farmland|dirt_path/, [116, 82, 56]],
  [/deepslate/, [70, 70, 80]],
  [/stone|andesite|diorite|granite|tuff|calcite/, [130, 130, 135]],
  [/cobble|brick|concrete|terracotta/, [115, 105, 100]],
  [/netherrack|nether_brick/, [122, 47, 47]],
  [/obsidian|bedrock/, [40, 40, 52]],
  [/clay/, [160, 166, 179]],
  [/ore/, [140, 120, 60]],
]
const DEFAULT_COLOR = [100, 100, 100]
const UNKNOWN_COLOR = [32, 32, 36]

function colorOf (name) {
  for (const [re, rgb] of COLORS) if (re.test(name)) return rgb
  return DEFAULT_COLOR
}

function mapDir () {
  const dir = process.env.MC_MAP_DIR
    ? path.resolve(process.env.MC_MAP_DIR)
    : path.join(
      process.env.MC_STATE_FILE ? path.dirname(path.resolve(process.env.MC_STATE_FILE)) : __dirname,
      'maps',
    )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 只保留最近 N 张地图，避免长期运行把磁盘塞满 */
function prune (dir, keep = 20) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^map-.*\.png$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const x of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, x.f)) } catch {}
    }
  } catch {}
}

function dimLabel (dim) {
  const d = String(dim || '').replace('minecraft:', '')
  if (d === 'overworld') return '主世界'
  if (d === 'the_nether') return '下界'
  if (d === 'the_end') return '末地'
  return d || '未知维度'
}

function stamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 扫描并画一张俯视地图。
 * @param {object} bot mineflayer 实例（必须已 spawned）
 * @param {{radius?:number, scale?:number}} [opt]
 */
function renderMap (bot, { radius = 32, scale = 3 } = {}) {
  const pos = bot.entity.position
  const cx = Math.floor(pos.x)
  const cz = Math.floor(pos.z)
  const r = Math.max(8, Math.min(Math.round(Number(radius) || 32), 64))
  const s = Math.max(1, Math.min(Math.round(Number(scale) || 3), 6))
  const n = r * 2 + 1
  const topY = Math.min(319, Math.floor(pos.y) + 40)
  const bottomY = Math.max(-64, Math.floor(pos.y) - 80)

  const probe = new Vec3(0, 0, 0)
  const cells = new Array(n * n)
  const counts = new Map()
  let minY = Infinity
  let maxY = -Infinity
  let water = 0
  let unknown = 0

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = cx - r + ix
      const z = cz - r + iz
      let hit = null
      probe.x = x
      probe.z = z
      for (let y = topY; y >= bottomY; y--) {
        probe.y = y
        const b = bot.blockAt(probe)
        if (!b) break // 区块没加载：当未知处理
        const nm = b.name
        if (!nm || nm.endsWith('air')) continue
        // 花草、雪片这类没有碰撞体积的装饰不当地表
        if (b.boundingBox !== 'block' && nm !== 'water' && nm !== 'lava') continue
        hit = { name: nm, y }
        break
      }
      const i = iz * n + ix
      if (!hit) {
        cells[i] = null
        unknown++
        continue
      }
      cells[i] = hit
      if (hit.y < minY) minY = hit.y
      if (hit.y > maxY) maxY = hit.y
      if (hit.name === 'water') water++
      counts.set(hit.name, (counts.get(hit.name) || 0) + 1)
    }
  }

  const total = n * n
  const known = total - unknown
  const range = Number.isFinite(minY) && maxY > minY ? maxY - minY : 1
  const width = n * s
  const height = n * s
  const rgba = Buffer.alloc(width * height * 4)

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const cell = cells[iz * n + ix]
      const [R, G, B] = cell ? colorOf(cell.name) : UNKNOWN_COLOR
      // 高度明暗：越低越暗，越高越亮（水面不加亮，避免整片反光看不清）
      const t = cell && cell.name !== 'water' ? (cell.y - minY) / range : 0.35
      const f = cell ? 0.62 + 0.55 * t : 1
      const px = [R * f, G * f, B * f].map((v) => Math.max(0, Math.min(255, Math.round(v))))
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const o = (((iz * s + dy) * width) + (ix * s + dx)) * 4
          rgba[o] = px[0]
          rgba[o + 1] = px[1]
          rgba[o + 2] = px[2]
          rgba[o + 3] = cell ? 255 : 90 // 未加载区块半透明
        }
      }
    }
  }

  // 玩家打点：自己红色、其他玩家橙色（只画在半径内）
  const markers = []
  try {
    for (const pl of Object.values(bot.players)) {
      if (!pl.entity || !pl.entity.position) continue
      const px = Math.floor(pl.entity.position.x)
      const pz = Math.floor(pl.entity.position.z)
      if (Math.abs(px - cx) > r || Math.abs(pz - cz) > r) continue
      markers.push({ name: pl.username, self: pl.username === bot.username, x: px, z: pz })
    }
  } catch {}
  for (const m of markers) {
    const ix = m.x - (cx - r)
    const iz = m.z - (cz - r)
    const [R, G, B] = m.self ? [255, 60, 60] : [255, 160, 40]
    for (let dy = 0; dy < s; dy++) {
      for (let dx = 0; dx < s; dx++) {
        const o = (((iz * s + dy) * width) + (ix * s + dx)) * 4
        rgba[o] = R
        rgba[o + 1] = G
        rgba[o + 2] = B
        rgba[o + 3] = 255
      }
    }
  }

  const dim = bot.game && bot.game.dimension
  const dir = mapDir()
  const file = path.join(dir, `map-${String(dim || 'dim').replace(/^minecraft:/, '')}-${cx}_${cz}-${stamp()}.png`)
  fs.writeFileSync(file, encodePng(width, height, rgba))
  prune(dir)

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([name, c]) => `${name} ${Math.round((c / Math.max(1, known)) * 100)}%`)
    .join('、')
  const others = markers.filter((m) => !m.self)
  const summary = [
    `${dimLabel(dim)} 俯视图：中心 (${cx}, ${cz})，半径 ${r} 格（${s} 像素/格）。`,
    `地表方块：${top || '无数据'}。`,
    Number.isFinite(minY) ? `海拔 ${minY}~${maxY}，水域约 ${Math.round((water / Math.max(1, known)) * 100)}%。` : '',
    unknown ? `有 ${Math.round((unknown / total) * 100)}% 的区域还没加载（显示为暗色）。` : '',
    others.length ? `附近玩家：${others.map((m) => `${m.name}（${m.x}, ${m.z}）`).join('、')}；红点是你自己。` : '附近没有其他玩家；红点是你自己。',
  ].filter(Boolean).join(' ')

  return { file, summary, center: { x: cx, z: cz }, radius: r, scale: s, dim: dimLabel(dim), at: Date.now() }
}

module.exports = { renderMap, encodePng }
