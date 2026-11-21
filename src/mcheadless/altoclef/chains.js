// AltoClef 行为链（Java → JS 直译）
// 对照源码：adris/altoclef/chains/{UserTaskChain,SingleTaskChain,WorldSurvivalChain,FoodChain,MLGBucketFallChain}.java
// 行为决策和原版一致：链按优先级抢占，同一时刻只跑一条链里的任务；生存/坠落这类
// 高优先级链会暂时打断用户任务，等危险过去再让用户任务继续。

const { SingleTaskChain, Task } = require('./tasksystem')
const { goals } = require('mineflayer-pathfinder')
const {
  GetToBlockTask,
  TimeoutWanderTask,
} = require('./tasks')

// ---------- 食物数据（1.21，minecraft-data 不提供 foodPoints，只能内置一份） ----------
// [饥饿值, 饱和度]（与 Minecraft 原版一致）
const FOODS = {
  cooked_beef: [8, 12.8],
  cooked_porkchop: [8, 12.8],
  cooked_mutton: [6, 9.6],
  cooked_chicken: [6, 7.2],
  cooked_rabbit: [5, 6],
  cooked_salmon: [6, 9.6],
  cooked_cod: [5, 6],
  cooked_kelp: [1, 0.6],
  bread: [5, 6],
  baked_potato: [5, 6],
  golden_carrot: [6, 14.4],
  golden_apple: [4, 9.6],
  apple: [4, 2.4],
  carrot: [3, 3.6],
  melon_slice: [2, 1.2],
  sweet_berries: [2, 0.4],
  glow_berries: [2, 0.4],
  pumpkin_pie: [8, 4.8],
  cookie: [2, 0.4],
  honey_bottle: [6, 1.2],
  mushroom_stew: [6, 7.2],
  beetroot_soup: [6, 7.2],
  rabbit_stew: [10, 12],
  dried_kelp: [1, 0.6],
  beef: [3, 1.8],
  porkchop: [3, 1.8],
  mutton: [2, 1.2],
  chicken: [2, 1.2],
  rabbit: [3, 1.8],
  cod: [2, 0.4],
  salmon: [2, 0.4],
  tropical_fish: [1, 0.2],
  rotten_flesh: [4, 0.8],
  spider_eye: [2, 3.2],
  poisonous_potato: [2, 0.6],
  pufferfish: [1, 0.2],
}

function foodInfo (name) {
  return FOODS[name] || null
}

// 对照 FoodChain.calculateFood：返回 { units, best }
function calculateFood (inventory, hunger, saturation, health) {
  let units = 0
  let best = null
  let bestScore = Number.NEGATIVE_INFINITY
  const prioritizeSaturation = health < 8
  for (const it of inventory) {
    const info = foodInfo(it.name)
    if (!info || it.name === 'spider_eye') continue
    const [foodHunger, foodSat] = info
    units += foodHunger * it.count

    const hungerIfEaten = Math.min(hunger + foodHunger, 20)
    const satIfEaten = Math.min(hungerIfEaten, saturation + foodSat)
    const gainedSat = satIfEaten - saturation
    const gainedHunger = hungerIfEaten - hunger
    const hungerNotFilled = 20 - hungerIfEaten
    const satWasted = foodSat - gainedSat
    const hungerWasted = foodHunger - gainedHunger

    const satGood = prioritizeSaturation ? gainedSat * 8 : gainedSat
    const satPenalty = prioritizeSaturation ? 0 : satWasted * 1
    const hungerPenalty = hungerWasted * 2
    const notFilledPenalty = hungerNotFilled * 1
    let score = satGood - satPenalty - hungerPenalty - notFilledPenalty
    if (it.name === 'rotten_flesh') score -= 100
    if (score > bestScore) {
      bestScore = score
      best = { name: it.name, hunger: foodHunger, saturation: foodSat }
    }
  }
  return { units, best }
}

// 对照 FoodChain.needsToEat
function needsToEat (foodLevel, health, onFire, hasWither, config = {}) {
  const cfg = {
    alwaysEatWhenWitherOrFireAndHealthBelow: 6,
    alwaysEatWhenBelowHunger: 10,
    alwaysEatWhenBelowHealth: 14,
    ...config,
  }
  if (foodLevel >= 20) return false
  if (onFire || hasWither || health < cfg.alwaysEatWhenWitherOrFireAndHealthBelow) return true
  if (foodLevel > cfg.alwaysEatWhenBelowHunger) {
    if (health < cfg.alwaysEatWhenBelowHealth) return true
  } else {
    return true
  }
  return false
}

// 对照 chains/UserTaskChain.java
class UserTaskChain extends SingleTaskChain {
  constructor (runner) {
    super(runner)
    this._runner = runner
    this._currentOnFinish = null
    this._taskStopwatch = 0
    this._runningIdleTask = false
  }

  getPriority (_mod) { return 50 }

  getName () { return 'User Tasks' }

  runTask (mod, task, onFinish = null) {
    this._currentOnFinish = onFinish
    this._taskStopwatch = Date.now()
    this._runner.enable()
    this.setTask(task)
    mod.logTask(`用户任务：${task.toString()}`)
  }

  cancel (mod) {
    if (this._mainTask != null && this._mainTask.isActive()) {
      this.onStop(mod)
      this.onTaskFinish(mod)
    }
  }

  onTaskFinish (mod) {
    const old = this._mainTask
    this._mainTask = null
    const seconds = this._taskStopwatch ? (Date.now() - this._taskStopwatch) / 1000 : 0
    const cb = this._currentOnFinish
    this._currentOnFinish = null
    if (cb) cb()
    if (this._mainTask == null) {
      mod.logTask(old ? `任务完成（${seconds.toFixed(1)} 秒）：${old.toString()}` : '任务结束')
    }
  }
}

// 对照 chains/FoodChain.java：饿了就吃背包里最合适的那份，不负责收集（原版默认也不收集）
class FoodChain extends SingleTaskChain {
  constructor (runner) {
    super(runner)
    this._isTryingToEat = false
    this._requestFillup = false
    this._cachedBest = null
    this._cachedUnits = 0
  }

  getPriority (mod) {
    if (!mod.inGame()) {
      this.stopEat(mod)
      return Number.NEGATIVE_INFINITY
    }
    // 原版：在岩浆里不吃饭（正忙着逃命）
    if (mod.isInLava()) {
      this.stopEat(mod)
      return Number.NEGATIVE_INFINITY
    }

    const inv = mod.inventoryItems()
    const calc = calculateFood(inv, mod.getFood(), mod.getFoodSaturation(), mod.getHealth())
    this._cachedUnits = calc.units
    this._cachedBest = calc.best
    const hasFood = calc.units > 0

    if (this._requestFillup && mod.getFood() >= 20) this._requestFillup = false
    if (!hasFood) this._requestFillup = false

    if (hasFood && (needsToEat(mod.getFood(), mod.getHealth(), mod.isOnFire(), false) || this._requestFillup)) {
      this.startEat(mod, calc.best)
    } else {
      this.stopEat(mod)
    }

    // 吃东西是异步的，链本身不占用任务
    return Number.NEGATIVE_INFINITY
  }

  startEat (mod, food) {
    if (this._isTryingToEat || !food) return
    this._isTryingToEat = true
    this._requestFillup = true
    mod.eat(food.name).catch(() => {}).finally(() => {
      this._isTryingToEat = false
      this._requestFillup = false
    })
  }

  stopEat (mod) {
    if (this._isTryingToEat) {
      this._isTryingToEat = false
      this._requestFillup = false
      // 和原版一样松手，别把“正在吃”带到下一个动作里
      if (mod && mod.inGame()) mod.stopUsingItem()
    }
  }

  isTryingToEat () {
    return this._isTryingToEat
  }

  isActive () { return true }

  getName () { return 'Food' }

  onTaskFinish (_mod) {}

  onStop (mod) {
    this.stopEat(mod)
    super.onStop(mod)
  }
}

// 对照 tasks/movement/EscapeFromLavaTask.java（简化：找最近的岸边并跳上去）
class EscapeFromLavaTask extends Task {
  onStart (mod) {
    mod.stopPath()
    this._target = null
    this._triedAt = 0
  }

  onTick (mod) {
    if (!mod.isInLava() && !mod.isOnFire()) return null
    mod.setControl('jump', true)
    const p = mod.getPos()
    if (!this._target) this._target = mod.findSafeSpotNear(p, 8)
    if (this._target) {
      this.setDebugState('爬出岩浆')
      return new GetToBlockTask(this._target)
    }
    this.setDebugState('附近没有岸，往外游')
    if (Date.now() - this._triedAt > 1500) {
      this._triedAt = Date.now()
      const a = Math.random() * Math.PI * 2
      mod.setGoal(new goals.GoalXZ(p.x + Math.cos(a) * 12, p.z + Math.sin(a) * 12))
    }
    return null
  }

  isFinished (mod) {
    return !mod.isInLava() && !mod.isOnFire()
  }

  onStop (mod, _interruptTask) {
    if (mod.inGame()) {
      mod.setControl('jump', false)
      mod.stopPath()
    }
  }

  isEqual (other) { return other instanceof EscapeFromLavaTask }
  toDebugString () { return '逃离岩浆' }
}

// 对照 tasks/construction/PutOutFireTask.java（简化：用水桶浇灭身上的火）
class ExtinguishWithWaterTask extends Task {
  onStart (mod) {
    this._placedAt = 0
    this._collectAt = 0
    mod.stopPath()
  }

  onTick (mod) {
    if (!mod.isOnFire()) return null
    const p = mod.getPos()
    const below = mod.blockAt(p.offset(0, -1, 0))
    if (mod.countItem('water_bucket') > 0 && below && below.boundingBox === 'block' && Date.now() - this._placedAt > 1200) {
      this._placedAt = Date.now()
      this.setDebugState('放下水桶灭火')
      mod.mlgPlace()
      return null
    }
    if (mod.countItem('bucket') > 0 && mod.isInWater()) {
      this.setDebugState('把水收回来')
      return null
    }
    this.setDebugState('等火灭')
    return null
  }

  isFinished (mod) {
    return !mod.isOnFire()
  }

  onStop (mod, _interruptTask) {
    if (mod.inGame()) mod.stopPath()
  }

  isEqual (other) { return other instanceof ExtinguishWithWaterTask }
  toDebugString () { return '水桶灭火' }
}

// 对照 chains/WorldSurvivalChain.java：溺水、岩浆、着火
class WorldSurvivalChain extends SingleTaskChain {
  constructor (runner) {
    super(runner)
    this._avoidingDrowning = false
    this._waterPlacedAt = 0
  }

  getPriority (mod) {
    if (!mod.inGame()) return Number.NEGATIVE_INFINITY

    this.handleDrowning(mod)

    // 岩浆：最高优先级
    if (mod.isInLava()) {
      this.setTask(new EscapeFromLavaTask())
      return 100
    }

    // 着火：有水源就去、有水桶就浇
    if (mod.isOnFire()) {
      if (mod.countItem('water_bucket') > 0) {
        this.setTask(new ExtinguishWithWaterTask())
      } else {
        const water = mod.findClosestBlock(['water', 'flowing_water'], 24)
        this.setTask(water ? new GetToBlockTask(water) : new TimeoutWanderTask(8))
      }
      return 90
    }

    return Number.NEGATIVE_INFINITY
  }

  handleDrowning (mod) {
    let avoided = false
    if (mod.isInWater() && mod.getOxygen() < 20) {
      mod.setControl('jump', true)
      avoided = true
      this._avoidingDrowning = true
    }
    if (this._avoidingDrowning && !avoided) {
      this._avoidingDrowning = false
      mod.setControl('jump', false)
    }
  }

  isActive () { return true }

  getName () { return 'Misc World Survival Chain' }

  onTaskFinish (_mod) {}

  onStop (mod) {
    if (this._avoidingDrowning) {
      this._avoidingDrowning = false
      if (mod.inGame()) mod.setControl('jump', false)
    }
    super.onStop(mod)
  }
}

// 对照 tasks/movement/MLGBucketTask.java + chains/MLGBucketFallChain.java
class MLGBucketTask extends Task {
  constructor () {
    super()
    this._startedAt = 0
    this._placed = null
    this._lastPlaceAt = 0
    this._collectAt = 0
  }

  onStart (mod) {
    this._startedAt = Date.now()
    this._placed = null
    this._lastPlaceAt = 0
    this._collectAt = 0
    mod.stopPath()
  }

  onTick (mod) {
    const player = mod.getPlayer()
    if (!player) return null

    // 已经落地：尝试把水收回来
    if (player.onGround) {
      if (!this._collectAt) this._collectAt = Date.now()
      if (mod.countItem('bucket') > 0 && Date.now() - this._collectAt > 300 && Date.now() - this._collectAt < 2500) {
        const water = mod.findClosestBlock(['water', 'flowing_water'], 4)
        if (water) {
          this.setDebugState('收回水')
          mod.equipItem('bucket')
          mod.lookAtBlock(water)
          mod.activateItem()
        }
      }
      return null
    }

    if (mod.countItem('water_bucket') <= 0) {
      this.setDebugState('水桶用掉了，滑翔/等落地')
      return null
    }

    // 离地 2~4 格才放水（太早水会流走，太晚摔死）
    const groundY = mod.groundYBelow(5)
    const p = mod.getPos()
    const height = p.y - groundY
    if (height >= 1.5 && height <= 4.5 && Date.now() - this._lastPlaceAt > 250) {
      this._lastPlaceAt = Date.now()
      this._placed = { x: Math.floor(p.x), y: Math.floor(groundY), z: Math.floor(p.z) }
      this.setDebugState('MLG 放水')
      mod.equipItem('water_bucket')
      mod.lookDown()
      mod.activateItem()
    } else {
      this.setDebugState(`下落中（离地 ${height.toFixed(1)}）`)
    }
    return null
  }

  isFinished (mod) {
    return !mod.inGame() || mod.getPlayer().onGround || Date.now() - this._startedAt > 20000
  }

  onStop (mod, _interruptTask) {
    if (mod.inGame()) mod.stopPath()
  }

  isEqual (other) { return other instanceof MLGBucketTask }
  toDebugString () { return 'MLG 落地水' }
}

class MLGBucketFallChain extends SingleTaskChain {
  getPriority (mod) {
    if (!mod.inGame()) return Number.NEGATIVE_INFINITY
    const player = mod.getPlayer()
    if (!player) return Number.NEGATIVE_INFINITY
    const falling = !player.onGround && player.velocity.y < -0.6
    if (falling && !player.elytraFlying && mod.getHealth() > 3 && mod.countItem('water_bucket') > 0) {
      this.setTask(new MLGBucketTask())
      return 100
    }
    return Number.NEGATIVE_INFINITY
  }

  isActive () { return true }

  getName () { return 'MLG Bucket Fall' }

  onTaskFinish (_mod) {}
}

module.exports = {
  FOODS,
  foodInfo,
  calculateFood,
  needsToEat,
  UserTaskChain,
  FoodChain,
  WorldSurvivalChain,
  MLGBucketFallChain,
  EscapeFromLavaTask,
  ExtinguishWithWaterTask,
  MLGBucketTask,
}
