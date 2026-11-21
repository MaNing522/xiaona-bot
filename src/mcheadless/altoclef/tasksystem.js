// AltoClef 任务系统（Java → JS 直译）
// 对照源码：adris/altoclef/tasksystem/{Task,TaskChain,TaskRunner}.java
// 设计目标：类名、方法名与 altoclef 保持一致，方便以后对照原版补功能。
// 与原版的差异只在“环境层”：原版调 Baritone/原版客户端，这里调 mineflayer。
// 因此 Task 的 onTick 仍然保持同步（不返回 Promise），异步动作（挖方块/吃东西）
// 由 mod 适配层发起并轮询状态，和 Baritone 的 process 模型一致。

class Task {
  constructor () {
    this._oldDebugState = ''
    this._debugState = ''
    this._sub = null
    this._first = true
    this._stopped = false
    this._active = false
  }

  tick (mod, parentChain) {
    parentChain.addTaskToChain(this)
    if (this._first) {
      this._active = true
      this.onStart(mod)
      this._first = false
      this._stopped = false
    }
    if (this._stopped) return

    const newSub = this.onTick(mod)
    if (newSub != null) {
      if (!newSub.isEqual(this._sub)) {
        if (this.canBeInterrupted(mod, this._sub, newSub)) {
          // 子任务换了：旧子任务必须先停
          if (this._sub != null) this._sub.stop(mod, newSub)
          this._sub = newSub
        }
      }
      // 跑子任务（可能被上面的 canBeInterrupted 拒绝替换，那就继续跑旧子任务）
      if (this._sub != null) this._sub.tick(mod, parentChain)
    } else if (this._sub != null && this.canBeInterrupted(mod, this._sub, null)) {
      this._sub.stop(mod)
      this._sub = null
    }
  }

  reset () {
    this._first = true
    this._active = false
    this._stopped = false
  }

  stop (mod, interruptTask = null) {
    if (!this._active) return
    if (!this._first) this.onStop(mod, interruptTask)
    if (this._sub != null && !this._sub.stopped()) this._sub.stop(mod, interruptTask)
    this._first = true
    this._active = false
    this._stopped = true
  }

  // 暂停但不算结束（被更高优先级的链打断）
  interrupt (mod, interruptTask = null) {
    if (!this._active) return
    if (!this._first) this.onStop(mod, interruptTask)
    if (this._sub != null && !this._sub.stopped()) this._sub.interrupt(mod, interruptTask)
    this._first = true
  }

  setDebugState (state) {
    this._debugState = state == null ? '' : String(state)
  }

  isFinished (_mod) { return false }

  isActive () { return this._active }

  stopped () { return this._stopped }

  // 子类实现：start / tick / stop / equal / 调试名
  onStart (_mod) {}
  onTick (_mod) { return null }
  onStop (_mod, _interruptTask) {}
  isEqual (_other) { return false }
  toDebugString () { return this.constructor.name }

  toString () {
    return `<${this.toDebugString()}> ${this._debugState}`
  }

  thisOrChildSatisfies (pred) {
    let t = this
    while (t != null) {
      if (pred(t)) return true
      t = t._sub
    }
    return false
  }

  // ITaskCanForce：子任务声明“现在不能被打断”时，父任务不替换它
  canBeInterrupted (mod, subTask, toInterruptWith) {
    if (subTask == null) return true
    return subTask.thisOrChildSatisfies(task =>
      typeof task.shouldForce === 'function' ? !task.shouldForce(mod, toInterruptWith) : true)
  }
}

class TaskChain {
  constructor (runner) {
    this._cachedTaskChain = []
    runner.addTaskChain(this)
  }

  tick (mod) {
    this._cachedTaskChain = []
    this.onTick(mod)
  }

  stop (mod) {
    this._cachedTaskChain = []
    this.onStop(mod)
  }

  onStop (_mod) {}
  onInterrupt (_mod, _other) {}
  onTick (_mod) {}
  getPriority (_mod) { return Number.NEGATIVE_INFINITY }
  isActive () { return false }
  getName () { return this.constructor.name }

  getTasks () {
    return this._cachedTaskChain
  }

  addTaskToChain (task) {
    this._cachedTaskChain.push(task)
  }

  toString () {
    return this.getName()
  }
}

class TaskRunner {
  constructor (mod) {
    this._mod = mod
    this._chains = []
    this._active = false
    this._cachedCurrentTaskChain = null
  }

  tick () {
    if (!this._active) return
    let maxChain = null
    let maxPriority = Number.NEGATIVE_INFINITY
    for (const chain of this._chains) {
      if (!chain.isActive()) continue
      const priority = chain.getPriority(this._mod)
      if (priority > maxPriority) {
        maxPriority = priority
        maxChain = chain
      }
    }
    if (this._cachedCurrentTaskChain != null && maxChain !== this._cachedCurrentTaskChain) {
      this._cachedCurrentTaskChain.onInterrupt(this._mod, maxChain)
    }
    this._cachedCurrentTaskChain = maxChain
    if (maxChain != null) maxChain.tick(this._mod)
  }

  addTaskChain (chain) {
    this._chains.push(chain)
  }

  enable () {
    this._active = true
  }

  disable () {
    for (const chain of this._chains) chain.stop(this._mod)
    this._active = false
  }

  getCurrentTaskChain () {
    return this._cachedCurrentTaskChain
  }

  getMod () {
    return this._mod
  }
}

// 对照 SingleTaskChain.java
class SingleTaskChain extends TaskChain {
  constructor (runner) {
    super(runner)
    this._mainTask = null
    this._interrupted = false
    this._mod = runner.getMod()
  }

  onTick (mod) {
    if (!this.isActive()) return

    if (this._interrupted) {
      this._interrupted = false
      if (this._mainTask != null) this._mainTask.reset()
    }

    if (this._mainTask != null) {
      if (this._mainTask.isFinished(mod) || this._mainTask.stopped()) {
        this.onTaskFinish(mod)
      } else {
        this._mainTask.tick(mod, this)
      }
    }
  }

  onStop (mod) {
    if (this.isActive() && this._mainTask != null) {
      this._mainTask.stop(mod)
      this._mainTask = null
    }
  }

  setTask (task) {
    if (this._mainTask == null || (task != null && !this._mainTask.isEqual(task))) {
      if (this._mainTask != null) this._mainTask.stop(this._mod, task)
      this._mainTask = task
      if (task != null) task.reset()
    }
  }

  isActive () {
    return this._mainTask != null
  }

  onTaskFinish (_mod) {
    this._mainTask = null
  }

  onInterrupt (mod, _other) {
    this._interrupted = true
    if (this._mainTask != null && this._mainTask.isActive()) this._mainTask.interrupt(mod, null)
  }

  isCurrentlyRunning (mod) {
    return !this._interrupted && this._mainTask != null && !this._mainTask.isFinished(mod)
  }

  getCurrentTask () {
    return this._mainTask
  }
}

// 对照 MovementProgressChecker.java（简化：去掉“正在挖方块”的进度，改看位移+停留时间）
class MovementProgressChecker {
  constructor (distanceTimeout = 1, minDistance = 0.1, _mineTimeout = 0.5, _minMineProgress = 0.001) {
    this._distanceTimeoutMs = distanceTimeout * 1000
    this._minDistance = minDistance
    this._lastPos = null
    this._lastProgressAt = Date.now()
  }

  check (mod) {
    const p = mod.getPos()
    if (!p) { this.reset(); return true }
    if (!this._lastPos) {
      this._lastPos = p.clone()
      this._lastProgressAt = Date.now()
      return true
    }
    if (p.distanceTo(this._lastPos) >= this._minDistance) {
      this._lastPos = p.clone()
      this._lastProgressAt = Date.now()
      return true
    }
    if (Date.now() - this._lastProgressAt < this._distanceTimeoutMs) return true
    return false
  }

  reset () {
    this._lastPos = null
    this._lastProgressAt = Date.now()
  }
}

module.exports = { Task, TaskChain, TaskRunner, SingleTaskChain, MovementProgressChecker }
