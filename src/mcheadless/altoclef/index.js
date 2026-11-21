// AltoClef 适配层：把 mineflayer 的 bot 包装成 altoclef 里的 `mod` 上下文，
// 再按原版结构装配 TaskRunner + 各条行为链。
//
// 对照源码：adris/altoclef/AltoClef.java（生命周期）+ TaskCatalogue.java（物品→资源任务）
// 这里只做“决策层”，具体动作（寻路、挖方块、吃东西）都落在 mineflayer 上。

const { goals } = require('mineflayer-pathfinder')
const { TaskRunner } = require('./tasksystem')
const {
  IdleTask,
  GetToBlockTask,
  GetToXZTask,
  DestroyBlockTask,
  MineAndCollectTask,
  CollectFoodTask,
} = require('./tasks')
const {
  FOODS,
  UserTaskChain,
  FoodChain,
  WorldSurvivalChain,
  MLGBucketFallChain,
} = require('./chains')

function isAirName (name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function posKey (p) {
  return `${p.x},${p.y},${p.z}`
}

// 方块 → 掉落物（原版 ItemHelper 里最常用的一部分）
const BLOCK_DROPS = {
  stone: ['cobblestone'],
  cobblestone: ['cobblestone'],
  deepslate: ['cobbled_deepslate'],
  coal_ore: ['coal'],
  deepslate_coal_ore: ['coal'],
  iron_ore: ['raw_iron'],
  deepslate_iron_ore: ['raw_iron'],
  copper_ore: ['raw_copper'],
  deepslate_copper_ore: ['raw_copper'],
  gold_ore: ['raw_gold'],
  deepslate_gold_ore: ['raw_gold'],
  diamond_ore: ['diamond'],
  deepslate_diamond_ore: ['diamond'],
  emerald_ore: ['emerald'],
  deepslate_emerald_ore: ['emerald'],
  lapis_ore: ['lapis_lazuli'],
  deepslate_lapis_ore: ['lapis_lazuli'],
  redstone_ore: ['redstone'],
  deepslate_redstone_ore: ['redstone'],
  nether_quartz_ore: ['quartz'],
  clay: ['clay_ball'],
  grass_block: ['dirt'],
  snow_block: ['snowball'],
  gravel: ['gravel'],
  sand: ['sand'],
  dirt: ['dirt'],
}

const LOG_BLOCKS = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'pale_oak_log', 'bamboo_block', 'crimson_stem', 'warped_stem',
]
const LOG_ITEMS = LOG_BLOCKS.map(n => n.replace(/^(bamboo)_block$/, '$1').replace(/_stem$/, '_stem'))

// 物品 → 去哪挖（对照 TaskCatalogue 里登记过的资源，只收常见的）
const ITEM_SOURCES = {
  cobblestone: { items: ['cobblestone'], blocks: ['stone', 'cobblestone'] },
  stone: { items: ['stone'], blocks: ['stone'] },
  coal: { items: ['coal'], blocks: ['coal_ore', 'deepslate_coal_ore'] },
  raw_iron: { items: ['raw_iron'], blocks: ['iron_ore', 'deepslate_iron_ore'] },
  raw_copper: { items: ['raw_copper'], blocks: ['copper_ore', 'deepslate_copper_ore'] },
  raw_gold: { items: ['raw_gold'], blocks: ['gold_ore', 'deepslate_gold_ore'] },
  diamond: { items: ['diamond'], blocks: ['diamond_ore', 'deepslate_diamond_ore'] },
  emerald: { items: ['emerald'], blocks: ['emerald_ore', 'deepslate_emerald_ore'] },
  lapis_lazuli: { items: ['lapis_lazuli'], blocks: ['lapis_ore', 'deepslate_lapis_ore'] },
  redstone: { items: ['redstone'], blocks: ['redstone_ore', 'deepslate_redstone_ore'] },
  quartz: { items: ['quartz'], blocks: ['nether_quartz_ore'] },
  dirt: { items: ['dirt'], blocks: ['dirt', 'grass_block'] },
  sand: { items: ['sand'], blocks: ['sand'] },
  gravel: { items: ['gravel'], blocks: ['gravel'] },
  clay_ball: { items: ['clay_ball'], blocks: ['clay'] },
  obsidian: { items: ['obsidian'], blocks: ['obsidian'] },
  netherrack: { items: ['netherrack'], blocks: ['netherrack'] },
  log: { items: LOG_ITEMS, blocks: LOG_BLOCKS },
  plank: { items: ['oak_planks'], blocks: [] },
  oak_log: { items: ['oak_log'], blocks: ['oak_log'] },
  spruce_log: { items: ['spruce_log'], blocks: ['spruce_log'] },
  birch_log: { items: ['birch_log'], blocks: ['birch_log'] },
  jungle_log: { items: ['jungle_log'], blocks: ['jungle_log'] },
  acacia_log: { items: ['acacia_log'], blocks: ['acacia_log'] },
  dark_oak_log: { items: ['dark_oak_log'], blocks: ['dark_oak_log'] },
}

/**
 * 把“要什么物品”解析成 { items, blocks }。解析不出来返回 null。
 * 兜底：物品名本身就是方块名（sand/dirt/wool 之类）时直接挖同名方块。
 */
function resolveItem (itemName, registry) {
  const name = String(itemName || '').trim().toLowerCase()
  if (!name) return null
  if (ITEM_SOURCES[name]) return ITEM_SOURCES[name]
  if (LOG_BLOCKS.includes(name)) return { items: [name], blocks: [name] }
  if (name.endsWith('_log') && LOG_BLOCKS.includes(name)) return { items: [name], blocks: [name] }
  if (registry && registry.blocksByName && registry.blocksByName[name]) {
    return { items: BLOCK_DROPS[name] || [name], blocks: [name] }
  }
  return null
}

function dropsOfBlock (blockName) {
  return BLOCK_DROPS[blockName] || [blockName]
}

/**
 * @param {() => any} getBot 每次现取全局 bot（重连会换实例）
 * @param {{log?: Function, onTaskLog?: Function}} hooks
 */
function createAltoClef (getBot, hooks = {}) {
  const log = hooks.log || (() => {})
  const blacklist = new Map() // posKey → 过期时间
  let scanCache = { key: '', at: 0, positions: [] }
  let eating = null

  const mod = {
    logTask (msg) {
      log(`[alto] ${msg}`)
      if (hooks.onTaskLog) hooks.onTaskLog(msg)
    },

    inGame () {
      const b = getBot()
      return Boolean(b && b.entity)
    },
    getPlayer () {
      return getBot() ? getBot().entity : null
    },
    getPos () {
      const b = getBot()
      return b && b.entity ? b.entity.position : null
    },
    getFood () {
      const b = getBot()
      return b && typeof b.food === 'number' ? b.food : 20
    },
    getFoodSaturation () {
      const b = getBot()
      return b && typeof b.foodSaturation === 'number' ? b.foodSaturation : 5
    },
    getHealth () {
      const b = getBot()
      return b && typeof b.health === 'number' ? b.health : 20
    },
    getOxygen () {
      const b = getBot()
      return b && typeof b.oxygenLevel === 'number' ? b.oxygenLevel : 20
    },

    // ---------- 寻路（Baritone 的替身是 mineflayer-pathfinder） ----------
    isPathing () {
      const b = getBot()
      return Boolean(b && b.pathfinder && b.pathfinder.goal)
    },
    setGoal (goal, dynamic = false) {
      const b = getBot()
      if (!b || !b.pathfinder) return
      this.stopWalk()
      try { b.pathfinder.setGoal(goal, dynamic) } catch (e) { log(`setGoal 失败：${e.message}`) }
    },
    stopPath () {
      const b = getBot()
      if (!b || !b.pathfinder) return
      try { b.pathfinder.setGoal(null) } catch {}
      this.stopWalk()
    },
    inGoal (goal) {
      const b = getBot()
      if (!b || !b.entity || !goal || typeof goal.isEnd !== 'function') return false
      try { return goal.isEnd(b.entity.position.floored()) } catch { return false }
    },

    // ---------- 世界查询 ----------
    blockAt (pos) {
      const b = getBot()
      if (!b) return null
      try { return b.blockAt(pos) } catch { return null }
    },
    isBlacklisted (pos) {
      const at = blacklist.get(posKey(pos))
      if (!at) return false
      if (at < Date.now()) { blacklist.delete(posKey(pos)); return false }
      return true
    },
    blacklistBlock (pos) {
      blacklist.set(posKey(pos), Date.now() + 60000)
    },
    // 对照 BlockTracker：在一堆候选方块里找最近的、还没拉黑的
    findClosestBlock (names, radius = 48, pred = null) {
      const b = getBot()
      if (!b || !b.entity || !names || !names.length) return null
      const key = `${names.slice().sort().join(',')}|${radius}`
      const now = Date.now()
      if (scanCache.key !== key || now - scanCache.at > 1500) {
        const ids = names.map(n => b.registry.blocksByName[n] && b.registry.blocksByName[n].id)
          .filter(n => typeof n === 'number')
        let positions = []
        if (ids.length) {
          try { positions = b.findBlocks({ matching: ids, maxDistance: radius, count: 96 }) } catch { positions = [] }
        }
        scanCache = { key, at: now, positions }
      }
      const p = b.entity.position
      let best = null
      let bestDist = Number.POSITIVE_INFINITY
      for (const pos of scanCache.positions) {
        const blk = b.blockAt(pos)
        if (!blk || !names.includes(blk.name)) continue
        if (this.isBlacklisted(pos)) continue
        if (pred && !pred(pos)) continue
        const d = p.distanceTo(pos)
        if (d > radius) continue
        if (d < bestDist) { bestDist = d; best = pos }
      }
      return best
    },
    findClosestItemEntity (names, radius = 24, excludeIds = null) {
      const b = getBot()
      if (!b || !b.entity) return null
      const p = b.entity.position
      let best = null
      let bestDist = radius
      for (const e of Object.values(b.entities)) {
        if (!e || !e.position || e === b.entity) continue
        if (excludeIds && excludeIds.has(e.id)) continue
        if (e.name !== 'item' && e.name !== 'Item' && e.name !== 'item_stack') continue
        let dropped = null
        try { dropped = e.getDroppedItem() } catch {}
        if (!dropped || !names.includes(dropped.name)) continue
        const d = p.distanceTo(e.position)
        if (d < bestDist) { bestDist = d; best = e }
      }
      return best
    },
    findClosestEntity (names, radius = 24) {
      const b = getBot()
      if (!b || !b.entity) return null
      const p = b.entity.position
      let best = null
      let bestDist = radius
      for (const e of Object.values(b.entities)) {
        if (!e || !e.position || e === b.entity) continue
        if (!names.includes(e.name)) continue
        const d = p.distanceTo(e.position)
        if (d < bestDist) { bestDist = d; best = e }
      }
      return best
    },
    isInLava () {
      const b = getBot()
      if (!b || !b.entity) return false
      const p = b.entity.position
      return [0, 0.5, 1].some(dy => {
        const blk = this.blockAt(p.offset(0, dy, 0))
        return blk && blk.name.includes('lava')
      })
    },
    isInWater () {
      const b = getBot()
      if (!b || !b.entity) return false
      const p = b.entity.position
      return [0, 1].some(dy => {
        const blk = this.blockAt(p.offset(0, dy, 0))
        return blk && (blk.name === 'water' || blk.name === 'flowing_water' || blk.name === 'bubble_column')
      })
    },
    isOnFire () {
      const b = getBot()
      if (!b || !b.entity) return false
      const p = b.entity.position.floored()
      const spots = [p, p.offset(0, 1, 0), p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1)]
      return spots.some(pos => {
        const blk = this.blockAt(pos)
        return blk && (blk.name === 'fire' || blk.name === 'soul_fire')
      })
    },
    // 往下找最高的可站立方块顶面 y（找不到就返回 maxDrop 处的 y）
    groundYBelow (maxDrop = 5) {
      const p = this.getPos()
      if (!p) return 0
      for (let dy = 1; dy <= maxDrop; dy++) {
        const blk = this.blockAt(p.offset(0, -dy, 0))
        if (blk && blk.boundingBox === 'block' && !blk.name.includes('lava')) return Math.floor(p.y) - dy + 1
      }
      return Math.floor(p.y) - maxDrop
    },
    // 在附近找一块能站人的陆地（逃岩浆用）
    findSafeSpotNear (p, radius = 6) {
      const base = p.floored()
      for (let r = 1; r <= radius; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue
            for (let dy = -2; dy <= 3; dy++) {
              const pos = base.offset(dx, dy, dz)
              const feet = this.blockAt(pos)
              const head = this.blockAt(pos.offset(0, 1, 0))
              const below = this.blockAt(pos.offset(0, -1, 0))
              if (!feet || !head || !below) continue
              if (isAirName(feet.name) && isAirName(head.name) &&
                  below.boundingBox === 'block' && !below.name.includes('lava')) {
                return pos
              }
            }
          }
        }
      }
      return null
    },

    // ---------- 背包 ----------
    inventoryItems () {
      const b = getBot()
      if (!b) return []
      try { return b.inventory.items() } catch { return [] }
    },
    countItem (name) {
      return this.inventoryItems().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
    },
    countItems (names) {
      return this.inventoryItems().filter(i => names.includes(i.name)).reduce((n, i) => n + i.count, 0)
    },
    countFoodUnits (names) {
      let units = 0
      for (const it of this.inventoryItems()) {
        if (names && !names.includes(it.name)) continue
        const info = FOODS[it.name]
        if (info) units += info[0] * it.count
      }
      return units
    },

    // ---------- 动作 ----------
    // 手动朝目标走（捡脚边掉落物用；寻路在 1~3 格这种短距离上经常“到了但没捡到”）
    walkToward (pos) {
      const b = getBot()
      if (!b || !b.entity) return
      const d = b.entity.position.distanceTo(pos)
      if (d < 1.1) { this.stopWalk(); return }
      try { b.lookAt(pos, true).catch(() => {}) } catch {}
      this.setControl('forward', true)
    },
    stopWalk () {
      this.setControl('forward', false)
      this.setControl('jump', false)
      this.setControl('sprint', false)
    },
    isDigging () {
      const b = getBot()
      return Boolean(b && b.targetDigBlock)
    },
    dig (pos) {
      const b = getBot()
      if (!b || !b.entity) return
      const blk = this.blockAt(pos)
      if (!blk || isAirName(blk.name)) return
      b.dig(blk, true).catch(e => { if (!/digging|aborted/i.test(e.message)) log(`挖方块失败：${e.message}`) })
    },
    attack (entity) {
      const b = getBot()
      if (!b || !entity) return
      try {
        b.lookAt(entity.position.offset(0, 1.2, 0), true).catch(() => {})
        b.attack(entity)
      } catch {}
    },
    setControl (key, on) {
      const b = getBot()
      if (!b) return
      try { b.setControlState(key, on) } catch {}
    },
    lookDown () {
      const b = getBot()
      if (!b || !b.entity) return
      try { b.look(b.entity.yaw, Math.PI / 2, true).catch(() => {}) } catch {}
    },
    lookAtBlock (pos) {
      const b = getBot()
      if (!b) return
      try { b.lookAt(pos.offset(0.5, 0.5, 0.5), true).catch(() => {}) } catch {}
    },
    equipItem (name) {
      const b = getBot()
      if (!b) return Promise.resolve()
      const item = this.inventoryItems().find(i => i.name === name)
      if (!item) return Promise.resolve()
      return b.equip(item, 'hand').catch(() => {})
    },
    activateItem () {
      const b = getBot()
      if (!b) return
      try { b.activateItem() } catch {}
    },
    stopUsingItem () {
      const b = getBot()
      if (!b) return
      try { if (typeof b.deactivateItem === 'function') b.deactivateItem() } catch {}
    },
    // 水桶落地：拿水桶 → 低头 → 右键
    mlgPlace () {
      return this.equipItem('water_bucket').then(() => {
        this.lookDown()
        this.activateItem()
      })
    },
    eat (name) {
      if (eating) return eating
      const b = getBot()
      if (!b) return Promise.resolve()
      if (typeof b.food === 'number' && b.food >= 20) return Promise.resolve()
      eating = (async () => {
        const item = this.inventoryItems().find(i => i.name === name)
        if (!item) throw new Error(`背包里没有 ${name}`)
        await b.equip(item, 'hand')
        await b.consume()
      })().finally(() => { eating = null })
      return eating
    },
    getPlayerByName (name) {
      const b = getBot()
      const p = b && b.players ? b.players[name] : null
      return p ? p.entity || null : null
    },
  }

  const runner = new TaskRunner(mod)
  const userChain = new UserTaskChain(runner)
  const survivalChain = new WorldSurvivalChain(runner)
  const mlgChain = new MLGBucketFallChain(runner)
  const foodChain = new FoodChain(runner)
  runner.enable()

  function tick () {
    if (!mod.inGame()) return
    runner.tick()
  }

  function run (task, label, onFinish = null) {
    userChain.runTask(mod, task, onFinish)
    if (task.isFinished && task.isFinished(mod)) mod.logTask(`任务无需执行：${label || task.toString()}`)
  }

  function cancel () {
    userChain.cancel(mod)
    mod.stopPath()
  }

  function status () {
    const chain = runner.getCurrentTaskChain()
    const task = userChain.getCurrentTask()
    return {
      chain: chain ? chain.getName() : null,
      task: task ? task.toString() : null,
      stack: chain ? chain.getTasks().map(t => t.toString()) : [],
      eating: foodChain.isTryingToEat(),
    }
  }

  // ---------- TaskCatalogue：物品 → 资源任务 ----------
  function taskForGet (itemName, count, opts = {}) {
    const b = getBot()
    const spec = resolveItem(itemName, b && b.registry)
    if (!spec) throw new Error(`不知道怎么获取 ${itemName}（试试直接写方块名，如 diamond_ore）`)
    const n = Math.max(1, Math.floor(Number(count) || 1))
    if (mod.countItems(spec.items) >= n) return new IdleTask()
    if (!spec.blocks || !spec.blocks.length) throw new Error(`${itemName} 不能直接挖到，需要合成（暂未移植合成链）`)
    return new MineAndCollectTask(spec.items, spec.blocks, n, { giveUpMs: opts.giveUpMs || 120000 })
  }

  function taskForMine (blockName, count, opts = {}) {
    const name = String(blockName || '').trim().toLowerCase()
    const b = getBot()
    if (!b || !b.registry.blocksByName[name]) throw new Error(`未知方块 ${blockName}`)
    const items = dropsOfBlock(name)
    const n = Math.max(1, Math.floor(Number(count) || 1))
    if (mod.countItems(items) >= n) return new IdleTask()
    return new MineAndCollectTask(items, [name], n, { giveUpMs: opts.giveUpMs || 120000 })
  }

  function taskForFood (units) {
    const n = Math.max(1, Math.floor(Number(units) || 1))
    return new CollectFoodTask(n, Object.keys(FOODS))
  }

  return {
    mod,
    runner,
    userChain,
    foodChain,
    survivalChain,
    mlgChain,
    tick,
    run,
    cancel,
    status,
    taskForGet,
    taskForMine,
    taskForFood,
    // 让 headless 也能直接构造
    tasks: { IdleTask, GetToBlockTask, GetToXZTask, DestroyBlockTask, MineAndCollectTask, CollectFoodTask, goals },
    resolveItem,
    dropsOfBlock,
  }
}

module.exports = { createAltoClef, resolveItem, dropsOfBlock, BLOCK_DROPS, ITEM_SOURCES, LOG_BLOCKS }
