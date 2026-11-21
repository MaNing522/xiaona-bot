// Baritone 关键逻辑的 JavaScript 移植（只保留无头 bot 用得到的部分）
// 对照源码：cabaletta/baritone
//   baritone/process/MineProcess.java                     -> scanOres / prune / makeMineGoal / blacklist
//   baritone/pathing/goals/GoalBlock|GoalTwoBlocks|GoalThreeBlocks -> Goal* 类
//   baritone/pathing/movement/MovementHelper.java         -> plausibleToBreak / isNextToAir
//   baritone/pathing/movement/movements/MovementDownward.java -> 下挖只看下一格有落脚点（见 headless.js shaftDown）
// 寻路本身用 mineflayer-pathfinder：它本来就是 Baritone A* 的 JS 版，
// 缺的是 Baritone 的“矿石列表 -> 站位 goal -> 挖穿路径 -> 挖目标方块”流程，这里补上。

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const ORE_LOCATIONS_COUNT = 64

// GoalXZ.calculate：八方向距离（对角更便宜）
function distanceXZ (dx, dz) {
  const x = Math.abs(dx)
  const z = Math.abs(dz)
  return (x > z ? x - z : z - x) + Math.min(x, z) * Math.SQRT2
}

// 翻译自 GoalBlock
class GoalBlock extends goals.Goal {
  constructor (x, y, z) {
    super()
    this.x = Math.floor(x)
    this.y = Math.floor(y)
    this.z = Math.floor(z)
  }

  heuristic (node) {
    return distanceXZ(this.x - node.x, this.z - node.z) + Math.abs(this.y - node.y)
  }

  isEnd (node) {
    return node.x === this.x && node.y === this.y && node.z === this.z
  }
}

// 翻译自 GoalTwoBlocks：脚可以站在矿里（y）或矿下一格（y-1）
class GoalTwoBlocks extends GoalBlock {
  heuristic (node) {
    const dy = node.y - this.y
    return distanceXZ(this.x - node.x, this.z - node.z) + Math.abs(dy < 0 ? dy + 1 : dy)
  }

  isEnd (node) {
    return node.x === this.x && (node.y === this.y || node.y === this.y - 1) && node.z === this.z
  }
}

// 翻译自 MineProcess.GoalThreeBlocks：脚在矿下方两格也能挖到（头顶上方那格）
class GoalThreeBlocks extends GoalTwoBlocks {
  heuristic (node) {
    const dy = node.y - this.y
    return distanceXZ(this.x - node.x, this.z - node.z) + Math.abs(dy < -1 ? dy + 2 : dy === -1 ? 0 : dy)
  }

  isEnd (node) {
    return node.x === this.x && (node.y === this.y || node.y === this.y - 1 || node.y === this.y - 2) && node.z === this.z
  }
}

// 会往下掉的方块：上方是这些时不从正下方挖（Baritone 的 assumeVerticalShaftMine）
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'concrete_powder'])
for (const c of ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']) {
  FALLING.add(`${c}_concrete_powder`)
}

// 翻译自 MineProcess.isNextToAir（MovementHelper.isTransparent 的近似）
function isNextToAir (bot, pos, radius = 1) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > radius) continue
        const b = bot.blockAt(pos.offset(dx, dy, dz), false)
        if (b && b.boundingBox === 'empty') return true
      }
    }
  }
  return false
}

// 翻译自 MineProcess.plausibleToBreak：基岩包住、挖不动的都排除
function plausibleToBreak (bot, pos) {
  const b = bot.blockAt(pos, false)
  if (!b || b.boundingBox !== 'block') return false
  if (b.name === 'bedrock') return false
  if (typeof b.hardness === 'number' && b.hardness < 0) return false
  const up = bot.blockAt(pos.offset(0, 1, 0), false)
  const down = bot.blockAt(pos.offset(0, -1, 0), false)
  if (up && down && up.name === 'bedrock' && down.name === 'bedrock') return false
  return true
}

const posKey = p => `${p.x},${p.y},${p.z}`

// 翻译自 MineProcess.blacklist（不可达的矿点，过期后自动解除）
function blacklistPos (blacklist, pos, ms = 180000) {
  blacklist.set(posKey(pos), Date.now() + ms)
}

function isBlacklisted (blacklist, pos) {
  const at = blacklist.get(posKey(pos))
  if (!at) return false
  if (at < Date.now()) { blacklist.delete(posKey(pos)); return false }
  return true
}

// 翻译自 MineProcess.prune：过滤 + 按距离排序 + 截断
function prune (bot, locs, opts = {}) {
  const { antiXray = false, blacklist = new Map(), max = ORE_LOCATIONS_COUNT, radius = 40 } = opts
  const p = bot.entity.position
  const seen = new Set()
  const out = []
  for (const pos of locs) {
    const k = posKey(pos)
    if (seen.has(k)) continue
    seen.add(k)
    const dx = pos.x - p.x
    const dz = pos.z - p.z
    if (dx * dx + dz * dz > radius * radius) continue
    if (isBlacklisted(blacklist, pos)) continue
    if (!plausibleToBreak(bot, pos)) continue
    // Baritone.allowOnlyExposedOres：有反矿透时只挖洞穴暴露面
    if (antiXray && !isNextToAir(bot, pos, 1)) continue
    out.push(pos)
  }
  out.sort((a, b) => p.distanceTo(a.offset(0.5, 0.5, 0.5)) - p.distanceTo(b.offset(0.5, 0.5, 0.5)))
  return out.slice(0, max)
}

// 翻译自 MineProcess.searchWorld / WorldScanner：读已加载区块里的矿石
// 直接遍历区块 section，比 bot.findBlocks 的 3D 球体扫描快很多，而且能一次看到脚下一整列
function scanOres (bot, blockDefs, opts = {}) {
  const p = bot.entity.position.floored()
  const radius = opts.radius ?? 40
  const yMin = opts.yMin ?? (bot.game?.minY ?? -64)
  const yMax = opts.yMax ?? Math.min(20, p.y + 8)
  const states = new Set()
  for (const d of blockDefs) {
    const lo = d.minStateId ?? d.defaultState
    const hi = d.maxStateId ?? d.defaultState
    for (let s = lo; s <= hi; s++) states.add(s)
  }

  const locs = []
  const world = bot.world
  if (!world?.getColumns) return prune(bot, [], opts)

  for (const c of world.getColumns()) {
    const cx = Number(c.chunkX)
    const cz = Number(c.chunkZ)
    const bx = cx * 16
    const bz = cz * 16
    // 整个区块都在半径外就跳过
    const nx = Math.max(bx - p.x, 0, p.x - (bx + 15))
    const nz = Math.max(bz - p.z, 0, p.z - (bz + 15))
    if (nx * nx + nz * nz > radius * radius) continue

    const col = c.column
    const minY = col.minY ?? -64
    const maxY = minY + (col.worldHeight ?? 384) - 1
    const y0 = Math.max(yMin, minY)
    const y1 = Math.min(yMax, maxY)
    if (y1 < y0) continue

    for (let y = y0; y <= y1; y++) {
      const sec = col.sections[(y - minY) >> 4]
      if (!sec) continue
      const ly = (y - minY) & 15
      const built = []
      for (let lx = 0; lx < 16; lx++) {
        const dx = bx + lx - p.x
        if (dx * dx > radius * radius) continue
        built[lx] = dx
      }
      for (let lz = 0; lz < 16; lz++) {
        const dz = bz + lz - p.z
        for (let lx = 0; lx < 16; lx++) {
          const dx = built[lx]
          if (dx === undefined) continue
          if (dx * dx + dz * dz > radius * radius) continue
          if (states.has(sec.get({ x: lx, y: ly, z: lz }))) {
            locs.push(new Vec3(bx + lx, y, bz + lz))
          }
        }
      }
    }
  }
  return prune(bot, locs, opts)
}

// 翻译自 MineProcess.coalesce（非 forceInternalMining 分支）
// 上方不是会掉落的方块 -> 可以站在矿下方往上挖（GoalThreeBlocks），否则用 GoalTwoBlocks
function makeMineGoal (bot, loc) {
  const up = bot.blockAt(loc.offset(0, 1, 0), false)
  const assumeVerticalShaftMine = !(up && FALLING.has(up.name))
  return assumeVerticalShaftMine
    ? new GoalThreeBlocks(loc.x, loc.y, loc.z)
    : new GoalTwoBlocks(loc.x, loc.y, loc.z)
}

// 翻译自 MineProcess.updateGoal：
//   Goal goal = new GoalComposite(locs2.stream().map(loc -> coalesce(loc, locs2, context)))
// pathfinder 的 GoalCompositeAny 与 Baritone 的 GoalComposite 语义一致
// （heuristic 取子目标最小值，isEnd 任一满足即算到达）。
// 这样 A* 会在所有候选矿里自己挑“代价最小”的那颗，而不是我们按直线距离赌一颗。
function makeMineGoalComposite (bot, locs) {
  return new goals.GoalCompositeAny(locs.map(loc => makeMineGoal(bot, loc)))
}

module.exports = {
  ORE_LOCATIONS_COUNT,
  GoalBlock,
  GoalTwoBlocks,
  GoalThreeBlocks,
  distanceXZ,
  isNextToAir,
  plausibleToBreak,
  scanOres,
  prune,
  makeMineGoal,
  makeMineGoalComposite,
  posKey,
  blacklistPos,
  isBlacklisted
}
