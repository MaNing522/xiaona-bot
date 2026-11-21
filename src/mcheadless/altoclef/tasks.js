// AltoClef 任务实现（Java → JS 直译）
// 对照源码：adris/altoclef/tasks/**、chains/** 里被移植的部分
// 只保留 mineflayer 环境能直接实现的：赶路、挖方块、捡掉落、采矿/采集、吃东西、逃命。

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { Task, MovementProgressChecker } = require('./tasksystem')

function vecOf (pos) {
  return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
}

function isAirName (name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

// 对照 CustomBaritoneGoalTask.java：把一个 Goal 包装成任务，卡住就自己溜达
class CustomBaritoneGoalTask extends Task {
  constructor (wander = true) {
    super()
    this._wander = wander
    this._wanderTask = new TimeoutWanderTask(10)
    this._cachedGoal = null
    this._checker = new MovementProgressChecker(6, 0.1, 0.5, 0.001)
  }

  onStart (mod) {
    mod.stopPath()
    this._cachedGoal = null
    this._checker.reset()
  }

  onTick (mod) {
    if (this._cachedGoal == null) this._cachedGoal = this.newGoal(mod)

    if (this._wander) {
      if (this.isFinished(mod)) {
        this._checker.reset()
      } else {
        if (this._wanderTask.isActive() && !this._wanderTask.isFinished(mod)) {
          this.setDebugState('寻路卡住，先溜达')
          this._checker.reset()
          return this._wanderTask
        }
        if (!this._checker.check(mod)) {
          this.onWander(mod)
          return this._wanderTask
        }
      }
    }

    if (!mod.isPathing()) mod.setGoal(this._cachedGoal)
    this.setDebugState('赶路中')
    return null
  }

  isFinished (mod) {
    if (this._cachedGoal == null) this._cachedGoal = this.newGoal(mod)
    return this._cachedGoal != null && mod.inGoal(this._cachedGoal)
  }

  onStop (mod, _interruptTask) {
    if (mod.inGame()) mod.stopPath()
  }

  // 子类实现
  newGoal (_mod) { return null }
  onWander (_mod) {}
}

// 对照 tasks/movement/GetToBlockTask.java（Baritone GoalBlock）
class GetToBlockTask extends CustomBaritoneGoalTask {
  constructor (position) {
    super()
    this._position = vecOf(position)
  }

  newGoal (_mod) {
    return new goals.GoalBlock(this._position.x, this._position.y, this._position.z)
  }

  isEqual (other) {
    return other instanceof GetToBlockTask && other._position.equals(this._position)
  }

  toDebugString () {
    return `前往方块 ${this._position.x},${this._position.y},${this._position.z}`
  }
}

// 对照 tasks/movement/GetToXZTask.java
class GetToXZTask extends CustomBaritoneGoalTask {
  constructor (x, z) {
    super(true)
    this._x = Math.floor(x)
    this._z = Math.floor(z)
  }

  newGoal (_mod) {
    return new goals.GoalXZ(this._x, this._z)
  }

  isFinished (mod) {
    const p = mod.getPos()
    return Boolean(p && Math.floor(p.x) === this._x && Math.floor(p.z) === this._z)
  }

  isEqual (other) {
    return other instanceof GetToXZTask && other._x === this._x && other._z === this._z
  }

  toDebugString () {
    return `前往坐标 ${this._x},${this._z}`
  }
}

// 对照 tasks/movement/GetCloseToBlockTask.java
class GetCloseToBlockTask extends CustomBaritoneGoalTask {
  constructor (position, distance = 1) {
    super()
    this._position = vecOf(position)
    this._distance = distance
  }

  newGoal (_mod) {
    return new goals.GoalNear(this._position.x, this._position.y, this._position.z, this._distance)
  }

  isEqual (other) {
    return other instanceof GetCloseToBlockTask && other._position.equals(this._position)
  }

  toDebugString () {
    return `靠近方块 ${this._position.x},${this._position.y},${this._position.z}`
  }
}

// 对照 tasks/movement/IdleTask.java：站着不动
class IdleTask extends Task {
  onTick (_mod) { return null }
  isFinished (_mod) { return true }
  isEqual (other) { return other instanceof IdleTask }
  toDebugString () { return '原地待命' }
}

// 对照 tasks/movement/TimeoutWanderTask.java（简化：随机方向 GoalXZ + 卡住重选）
class TimeoutWanderTask extends Task {
  constructor (distanceToWander = Infinity, opts = {}) {
    super()
    this._distanceToWander = distanceToWander
    this._maxMs = opts.maxMs || 0
    this._origin = null
    this._goal = null
    this._nextGoalAt = 0
    this._failCounter = 0
    this._startedAt = 0
    this._checker = new MovementProgressChecker(3, 0.2)
  }

  resetWander () {
    this._goal = null
    this._nextGoalAt = 0
  }

  onStart (mod) {
    this._origin = mod.getPos() ? mod.getPos().clone() : null
    this._startedAt = Date.now()
    this._failCounter = 0
    this._goal = null
    this._checker.reset()
    this._setRandomGoal(mod)
  }

  onTick (mod) {
    if (!mod.isPathing() || Date.now() > this._nextGoalAt) this._setRandomGoal(mod)
    if (!this._checker.check(mod)) {
      this._checker.reset()
      this._failCounter++
      this._setRandomGoal(mod)
    }
    this.setDebugState(`四处探索（${this._failCounter} 次重新选路）`)
    return null
  }

  _setRandomGoal (mod) {
    const p = mod.getPos()
    if (!p) return
    const a = Math.random() * Math.PI * 2
    const r = 12 + Math.random() * 16
    this._goal = new goals.GoalXZ(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r)
    this._nextGoalAt = Date.now() + 6000
    mod.setGoal(this._goal)
  }

  isFinished (mod) {
    if (this._maxMs && Date.now() - this._startedAt > this._maxMs) return true
    if (this._failCounter > 10) return true
    if (!Number.isFinite(this._distanceToWander)) return false
    const p = mod.getPos()
    if (!p || !this._origin) return false
    return p.distanceTo(this._origin) > this._distanceToWander
  }

  isEqual (other) {
    if (!(other instanceof TimeoutWanderTask)) return false
    if (!Number.isFinite(other._distanceToWander) || !Number.isFinite(this._distanceToWander)) {
      return Number.isFinite(other._distanceToWander) === Number.isFinite(this._distanceToWander)
    }
    return Math.abs(other._distanceToWander - this._distanceToWander) < 0.5
  }

  toDebugString () {
    return `游荡 ${Number.isFinite(this._distanceToWander) ? this._distanceToWander : ''}`
  }
}

// 对照 tasks/movement/FollowPlayerTask.java（简化：GoalFollow 动态跟随）
class FollowPlayerTask extends Task {
  constructor (playerName, range = 3) {
    super()
    this._name = playerName
    this._range = range
  }

  onStart (mod) {
    mod.stopPath()
  }

  onTick (mod) {
    const target = mod.getPlayerByName(this._name)
    if (!target) {
      this.setDebugState('找不到目标玩家')
      return null
    }
    mod.setGoal(new goals.GoalFollow(target, this._range), true)
    this.setDebugState(`跟随 ${this._name}`)
    return null
  }

  isFinished (mod) {
    return !mod.getPlayerByName(this._name)
  }

  onStop (mod, _interruptTask) {
    if (mod.inGame()) mod.stopPath()
  }

  isEqual (other) {
    return other instanceof FollowPlayerTask && other._name === this._name
  }

  toDebugString () {
    return `跟随玩家 ${this._name}`
  }
}

// 对照 tasks/construction/DestroyBlockTask.java
class DestroyBlockTask extends Task {
  constructor (position) {
    super()
    this._pos = vecOf(position)
    this._checker = new MovementProgressChecker(6, 0.1, 4, 0.01)
    this._digStartedAt = 0
    this._lastBlockName = null
  }

  onStart (mod) {
    mod.stopPath()
    this._digStartedAt = 0
    this._checker.reset()
  }

  onTick (mod) {
    const block = mod.blockAt(this._pos)
    if (!block || isAirName(block.name)) return null

    if (this._lastBlockName !== block.name) {
      this._lastBlockName = block.name
      this._digStartedAt = 0
      this._checker.reset()
    }

    const p = mod.getPos()
    const dist = p.distanceTo(this._pos.offset(0.5, 0.5, 0.5))
    if (dist > 4.2) {
      this.setDebugState('走近方块')
      if (!mod.isPathing()) mod.setGoal(new goals.GoalNear(this._pos.x, this._pos.y, this._pos.z, 2))
      return null
    }

    // 已经在手够得着的范围：先停寻路（寻路会抢控制状态），再挖
    if (mod.isPathing()) mod.stopPath()
    if (!mod.isDigging()) {
      if (!this._digStartedAt) this._digStartedAt = Date.now()
      this.setDebugState(`挖 ${block.name}`)
      mod.dig(this._pos)
    } else {
      // 正在挖：位置本来就不动，别让“没位移”的进度检查误判成卡住
      this._checker.reset()
    }

    if (!this._checker.check(mod) || (this._digStartedAt && Date.now() - this._digStartedAt > 30000)) {
      mod.blacklistBlock(this._pos)
      this.setDebugState('挖不动，换个地方')
      return new TimeoutWanderTask(5)
    }
    return null
  }

  isFinished (mod) {
    const block = mod.blockAt(this._pos)
    return !block || isAirName(block.name)
  }

  isEqual (other) {
    return other instanceof DestroyBlockTask && other._pos.equals(this._pos)
  }

  toDebugString () {
    return `挖方块 ${this._pos.x},${this._pos.y},${this._pos.z}`
  }
}

// 对照 tasks/DoToClosestBlockTask.java：找最近的目标方块，对它做一件事
class DoToClosestBlockTask extends Task {
  constructor (getTargetTask, opts = {}) {
    super()
    this._getTargetTask = getTargetTask
    this._blocks = opts.blocks || []
    this._radius = opts.radius || 48
    this._isValid = opts.isValid || null
    this._giveUpMs = opts.giveUpMs || 0
    this._wander = new TimeoutWanderTask(Infinity)
    this._notFoundAt = 0
    this._gaveUp = false
  }

  onStart (mod) {
    mod.stopPath()
    this._notFoundAt = 0
    this._gaveUp = false
    this._wander = new TimeoutWanderTask(Infinity)
  }

  onTick (mod) {
    const pos = mod.findClosestBlock(this._blocks, this._radius, p =>
      this._isValid == null || this._isValid(mod, p))
    if (pos) {
      this._notFoundAt = 0
      this.setDebugState(`目标 ${pos.x},${pos.y},${pos.z}`)
      return this._getTargetTask(pos)
    }
    if (!this._notFoundAt) this._notFoundAt = Date.now()
    if (this._giveUpMs && Date.now() - this._notFoundAt > this._giveUpMs) {
      this._gaveUp = true
      this.setDebugState('附近找不到目标方块')
      return null
    }
    this.setDebugState('没看到目标，先四处找')
    return this._wander
  }

  isFinished (_mod) {
    return this._gaveUp
  }

  isEqual (other) {
    if (!(other instanceof DoToClosestBlockTask)) return false
    return other._blocks.length === this._blocks.length && other._blocks.every((b, i) => b === this._blocks[i])
  }

  toDebugString () {
    return `找最近的 ${this._blocks.join('/')}`
  }
}

// 对照 tasks/movement/PickupDroppedItemTask.java：把地上的掉落物走过去捡起来
class PickupDroppedItemTask extends Task {
  constructor (itemNames, targetCount) {
    super()
    this._itemNames = itemNames
    this._targetCount = targetCount
    this._emptySince = 0
    this._done = false
    this._checker = new MovementProgressChecker(6, 0.15)
    this._startedAt = 0
    this._lastDropKey = ''
  }

  onStart () {
    this._emptySince = 0
    this._done = false
    this._checker.reset()
    this._startedAt = Date.now()
    this._lastDropKey = ''
  }

  onTick (mod) {
    if (this.isFinished(mod)) return null
    const drop = mod.findClosestItemEntity(this._itemNames, 16)
    if (!drop) {
      if (!this._emptySince) this._emptySince = Date.now()
      // 掉落物可能还在飞/已被人捡走：4 秒还没有就结束
      if (Date.now() - this._emptySince > 4000) this._done = true
      this.setDebugState('等掉落物')
      return null
    }
    this._emptySince = 0
    const key = `${drop.id}:${Math.floor(drop.position.x)},${Math.floor(drop.position.z)}`
    if (key !== this._lastDropKey) {
      this._lastDropKey = key
      this._checker.reset()
    }
    // 走不过去的掉落物（被墙/领地挡住）别死追：超过 10 秒没靠近就放弃，回去挖
    if (!this._checker.check(mod) || Date.now() - this._startedAt > 15000) {
      this._done = true
      this.setDebugState('捡不到，放弃')
      return null
    }
    mod.setGoal(new goals.GoalFollow(drop, 1.2), true)
    this.setDebugState('捡掉落物')
    return null
  }

  isFinished (mod) {
    return this._done || mod.countItems(this._itemNames) >= this._targetCount
  }

  onStop (mod, _interruptTask) {
    if (mod.inGame()) mod.stopPath()
  }

  isEqual (other) {
    return other instanceof PickupDroppedItemTask &&
      other._targetCount === this._targetCount &&
      other._itemNames.join(',') === this._itemNames.join(',')
  }

  toDebugString () {
    return `捡 ${this._itemNames.join('/')}（目标 ${this._targetCount}）`
  }
}

// 对照 tasks/resources/MineAndCollectTask.java：地上有就先捡，没有就去挖，挖完再捡
class MineAndCollectTask extends Task {
  constructor (itemNames, blockNames, count, opts = {}) {
    super()
    this._itemNames = itemNames
    this._blockNames = blockNames
    this._count = count
    this._giveUpMs = opts.giveUpMs || 120000
    this._pickup = new PickupDroppedItemTask(itemNames, count)
    this._mine = null
  }

  onStart (mod) {
    mod.stopPath()
    this._gaveUp = false
    this._mine = new DoToClosestBlockTask(pos => new DestroyBlockTask(pos), {
      blocks: this._blockNames,
      radius: 48,
      giveUpMs: this._giveUpMs,
    })
  }

  onTick (mod) {
    if (this.isFinished(mod)) return null
    // 参照 ResourceTask：先看地上有没有目标掉落物
    if (mod.findClosestItemEntity(this._itemNames, 16)) {
      if (!this._pickup || this._pickup.isFinished(mod)) {
        this._pickup = new PickupDroppedItemTask(this._itemNames, this._count)
      }
      return this._pickup
    }
    if (this._mine.isFinished(mod)) {
      this._gaveUp = true
      return null
    }
    return this._mine
  }

  isFinished (mod) {
    return this._gaveUp || mod.countItems(this._itemNames) >= this._count
  }

  onStop (mod, _interruptTask) {
    if (mod.inGame()) mod.stopPath()
  }

  isEqual (other) {
    return other instanceof MineAndCollectTask &&
      other._count === this._count &&
      other._itemNames.join(',') === this._itemNames.join(',')
  }

  toDebugString () {
    return `采集 ${this._itemNames.join('/')} x${this._count}`
  }
}

// 对照 tasks/resources/CollectFoodTask.java（简化：打附近动物，捡肉/熟肉）
const FOOD_ANIMALS = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'cod', 'salmon', 'mooshroom']

class CollectFoodTask extends Task {
  constructor (units, foodNames) {
    super()
    this._units = units
    this._foodNames = foodNames
    this._wander = new TimeoutWanderTask(Infinity)
    this._notFoundAt = 0
    this._attackAt = 0
    this._gaveUp = false
  }

  onStart (mod) {
    mod.stopPath()
    this._notFoundAt = 0
    this._attackAt = 0
    this._gaveUp = false
  }

  onTick (mod) {
    if (this.isFinished(mod)) return null
    const drop = mod.findClosestItemEntity(this._foodNames, 16)
    if (drop) {
      mod.setGoal(new goals.GoalFollow(drop, 1.2), true)
      this.setDebugState('捡食物')
      return null
    }
    const animal = mod.findClosestEntity(FOOD_ANIMALS, 32)
    if (!animal) {
      if (!this._notFoundAt) this._notFoundAt = Date.now()
      if (Date.now() - this._notFoundAt > 60000) {
        this._gaveUp = true
        this.setDebugState('附近没有可打的动物')
        return null
      }
      this.setDebugState('找动物')
      return this._wander
    }
    this._notFoundAt = 0
    const dist = mod.getPos().distanceTo(animal.position)
    if (dist > 3.2) {
      mod.setGoal(new goals.GoalFollow(animal, 2), true)
      this.setDebugState(`追 ${animal.name}`)
      return null
    }
    if (mod.isPathing()) mod.stopPath()
    if (Date.now() - this._attackAt > 700) {
      this._attackAt = Date.now()
      mod.attack(animal)
    }
    this.setDebugState(`打 ${animal.name}`)
    return null
  }

  isFinished (mod) {
    return this._gaveUp || mod.countFoodUnits(this._foodNames) >= this._units
  }

  onStop (mod, _interruptTask) {
    if (mod.inGame()) mod.stopPath()
  }

  isEqual (other) {
    return other instanceof CollectFoodTask && other._units === this._units
  }

  toDebugString () {
    return `收集食物 ${this._units} 单位`
  }
}

module.exports = {
  CustomBaritoneGoalTask,
  GetToBlockTask,
  GetToXZTask,
  GetCloseToBlockTask,
  IdleTask,
  TimeoutWanderTask,
  FollowPlayerTask,
  DestroyBlockTask,
  DoToClosestBlockTask,
  PickupDroppedItemTask,
  MineAndCollectTask,
  CollectFoodTask,
  vecOf,
  isAirName,
}
