// 无头 Minecraft 客户端：复杂寻路 + 鞘翅飞行（安全降落）
// 依赖：mineflayer, mineflayer-pathfinder
// 控制：GET http://127.0.0.1:2319/state ｜ /cmd?cmd=goto%20300%2064%2030 ｜ 或游戏内 !goto 300 64 30（owner）
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const baritone = require('./baritone')
const { renderMap, renderItemMap } = require('./mapRender')
const { Vec3 } = require('vec3')
const http = require('http')
const fs = require('fs')
const path = require('path')

// 敏感配置放 config.json（已在 .gitignore，不进仓库），env 优先级更高
const CONFIG_FILE = process.env.MC_CONFIG || path.join(__dirname, 'config.json')
let fileCfg = {}
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {} } catch {}

const CFG = {
  host: process.env.MC_HOST || fileCfg.host || '127.0.0.1',
  port: Number(process.env.MC_PORT || fileCfg.port || 25565),
  username: process.env.MC_USER || fileCfg.username || 'Bot',
  version: process.env.MC_VERSION || fileCfg.version || '1.21.11',
  // Server = 控制台 /msg；可用 MC_OWNERS=a,b 覆盖
  owners: (process.env.MC_OWNERS || (fileCfg.owners || ['zwzzxy', 'Server']).join(','))
    .split(',').map(s => s.trim()).filter(Boolean),
  // 沙箱只能通过 HTTP CONNECT 代理出网：MC_PROXY=http://127.0.0.1:18080
  proxy: process.env.MC_PROXY || fileCfg.proxy || ''
}

// 默认启动就连 config 里的服务器；MC_AUTOCONNECT=false 时先只开 HTTP 控制口，
// 等外部（小钠）用 cmd=join <host> [port] [version] 再进服
const AUTO_CONNECT = String(process.env.MC_AUTOCONNECT ?? fileCfg.autoConnect ?? 'true') !== 'false'

// 通过 HTTP CONNECT 打开 TCP 隧道，交给 mineflayer 当 socket 用
function proxyConnect (client) {
  const u = new URL(CFG.proxy)
  const req = http.request({
    host: u.hostname,
    port: Number(u.port || 80),
    method: 'CONNECT',
    path: `${CFG.host}:${CFG.port}`,
    headers: { Host: `${CFG.host}:${CFG.port}` }
  })
  req.once('connect', (res, socket, head) => {
    if (res.statusCode !== 200) {
      socket.destroy()
      client.emit('error', new Error(`proxy CONNECT ${res.statusCode}`))
      return
    }
    if (head && head.length) socket.unshift(head)
    log(`tunnel ready ${CFG.host}:${CFG.port} via ${u.host}`)
    client.setSocket(socket)
    setImmediate(() => client.emit('connect'))
  })
  req.once('error', err => client.emit('error', err))
  req.end()
}

let bot = null
let stopped = false
let wantConnect = AUTO_CONNECT   // false = 已退服/还没 join，断线不重连
let connGen = 0                  // 连接代际：join/leave 后旧实例的回调直接作废
let reconnectTimer = null
let reconnectDelay = 7000 // Sonar 默认 rejoin-delay 5s，重连不能太快
let flying = false
let flyAbort = false
let patrolTimer = null
let lastHealth = 20
// 最近一次生成的地图（控制口 /state 会带出去，供小钠读路径/摘要）
let lastMap = null
// 服务端下发的地图物品数据：地图编号 → { scale, pixels(128×128 颜色 id), hasData }
const mapDataById = new Map()
let lastMapPacketAt = 0
let lastMapId = 0
// 登录验证码（AuthMe map captcha）：检测到提示就自动把那张地图导出成图片，
// 由上层（小钠）交给视觉模型读数字；读不出来再把图发到 QQ 找人看。
let captcha = { pending: false, path: null, at: 0, error: '' }
// 保留最近 5 张验证码地图，人工要看时随时能取
const captchaImages = []
// 界面信息：最近聊天 / 屏幕标题 / 计分板 / Boss栏 —— 都交给上层 AI 按需取用
// （服务器提示、验证码要求、任务目标这些东西格式五花八门，不写死解析规则）
const chatLog = []
let lastTitle = { title: '', subtitle: '', actionBar: '', at: 0 }

/** 把聊天组件（字符串 / {text,extra} / 数组）拍平成纯文本 */
function flattenText (v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(flattenText).join('')
  if (typeof v === 'object') {
    let s = typeof v.text === 'string' ? v.text : ''
    if (Array.isArray(v.extra)) s += v.extra.map(flattenText).join('')
    if (!s && typeof v.value === 'string') s = v.value
    if (!s && typeof v.translate === 'string') s = v.translate
    return s
  }
  return String(v)
}

function pushChatLine (text) {
  const t = flattenText(text).replace(/\s+/g, ' ').trim()
  if (!t) return
  const last = chatLog[chatLog.length - 1]
  if (last && last.text === t && Date.now() - last.at < 1000) return
  chatLog.push({ at: Date.now(), text: t })
  if (chatLog.length > 60) chatLog.splice(0, chatLog.length - 60)
}

// 登录插件（AuthMe）状态
const AUTH_PASSWORD = process.env.MC_PASSWORD || fileCfg.password || ''
let authState = 'unknown' // unknown | pending | done
let authTries = 0
let authResponded = false
let authSeen = false      // 见过任何登录/注册提示：有登录插件，不能按“无插件”跳过
let regTries = 0          // 首次进服自动注册（/register 或 /reg，带不带确认密码）

// 持久化运行模式：agent 只下指令不维持状态，断线/重连/进程重启后按最后一次指令继续
// 默认放在项目目录下，换机器 / 换工作目录都不会写丢
const STATE_FILE = process.env.MC_STATE_FILE
  || (fileCfg.stateFile ? path.resolve(__dirname, fileCfg.stateFile) : path.join(__dirname, '.bot-state.json'))
let mode = { kind: 'patrol', updatedAt: 0 } // patrol | stopped | goto | fly | pvp | mace

function loadMode () {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (j && typeof j.kind === 'string') mode = j
  } catch {}
}

function saveMode (kind, extra = {}) {
  mode = { kind, ...extra, updatedAt: Date.now() }
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(mode)) } catch (e) { log('state save failed:', e.message) }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[bot]', ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function waitFor (fn, timeout = 5000, step = 50) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      let ok = false
      try { ok = fn() } catch { ok = false }
      if (ok) return resolve()
      if (Date.now() - t0 > timeout) return reject(new Error('timeout'))
      setTimeout(tick, step)
    }
    tick()
  })
}

function fmt (p) {
  return `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`
}

function createBot () {
  const myGen = ++connGen
  const mine = mineflayer.createBot({
    host: CFG.host,
    port: CFG.port,
    username: CFG.username,
    version: CFG.version,
    auth: 'offline',
    hideErrors: true,
    connect: CFG.proxy ? proxyConnect : undefined,
    checkTimeoutInterval: 60 * 1000
  })
  bot = mine
  mine.loadPlugin(pathfinder)

  // 适配原版 1.21.2+ 的客户端 tick 协议（Sonar 会校验）：
  // 1) 每个移动包之后必须紧跟 tick_end
  // 2) 位置未变化时不能重复发送 position（原版只发 tick_end）
  // 注意：这里必须捕获本次连接自己的 client —— 换服/重连会把全局 bot 置空或换成新实例，
  // 旧实例的物理 tick 仍可能回调，读全局 bot._client 会直接崩（2026-11-21 踩过）。
  const client = bot._client
  let lastMoveKey = null
  let lastPosLook = null
  let lastPosLookAt = 0
  let vehActive = false // Sonar 载具检查期间由我们接管移动包
  const rawWrite = client.write.bind(client)
  client.write = (name, params) => {
    const isMove = ['position', 'position_look', 'look', 'flying', 'vehicle_move'].includes(name)
    if (vehActive && isMove) return // 骑乘/下船阶段不发送 mineflayer 的普通移动包
    if (name === 'position' || name === 'position_look') {
      if (name === 'position_look') { lastPosLook = { ...params }; lastPosLookAt = Date.now() }
      const key = `${params.x},${params.y},${params.z}`
      if (name === 'position' && key === lastMoveKey) {
        if (client.state === 'play') rawWrite('tick_end', {})
        return
      }
      lastMoveKey = key
    }
    rawWrite(name, params)
    if (isMove && client.state === 'play') rawWrite('tick_end', {})
    if (process.env.DEBUG_MOVE) log('OUT', name, params?.y, params?.onGround)
  }
  client.on('login', () => { lastMoveKey = null; lastPosLook = null })
  let myEntityId = null
  client.on('login', p => { if (p && typeof p.entityId === 'number') myEntityId = p.entityId })

  // 原版在传送后会连续发送两次 position_look（第二次 dy=0），
  // Sonar 依靠这次“零位移旋转包”开启坠落检查，缺了会报 unexpected y motion。
  client.on('position', () => {
    // 延后到本轮事件处理完，确保拿到 mineflayer 刚发出的 position_look 参数
    setImmediate(() => {
      if (client.state !== 'play' || !lastPosLook) return
      if (Date.now() - lastPosLookAt > 1500) return // 复活/传送后的旧坐标不要再补发
      const dup = { ...lastPosLook, onGround: false }
      if (process.env.DEBUG_MOVE) log('OUT dup pos_look', dup.y)
      rawWrite('position_look', dup)
      rawWrite('tick_end', {})
    })
  })

  // Sonar 在 configuration 阶段就要求 client settings + client brand。
  // mineflayer 默认只在 play 阶段发 brand，且发了两次会导致 "sent duplicate client brand"，
  // 因此这里提前发一次 brand，并拦截掉后续 mineflayer 的重复发送。
  let brandSent = false
  const rawWriteChannel = client.writeChannel.bind(client)
  client.writeChannel = (channel, params) => {
    if (channel === 'minecraft:brand') {
      if (brandSent) return
      brandSent = true
    }
    return rawWriteChannel(channel, params)
  }
  client.on('success', () => {
    brandSent = false
    try { bot.setSettings({}) } catch (e) { log('settings send failed:', e.message) }
    try { client.writeChannel('minecraft:brand', 'vanilla') } catch (e) { log('brand send failed:', e.message) }
  })

  // ---------- Sonar 验证交互（hotbar / 挥手）----------
  // Sonar 先发非法槽位 -1（真实客户端应忽略），再发合法槽位并期待客户端回显。
  // mineflayer 自带的处理会对 -1 断言崩溃，必须在它的插件注入之后替换掉。
  const onHeldItemSlot = p => {
    if (typeof p.slot !== 'number' || p.slot < 0 || p.slot > 8) return
    try { client.write('held_item_slot', { slotId: p.slot }) } catch (e) { log('held item resp failed:', e.message) }
  }
  bot.once('inject_allowed', () => {
    client.removeAllListeners('held_item_slot')
    client.on('held_item_slot', onHeldItemSlot)
  })
  // Sonar 会让“自己”挥手并要求回包；普通服务器广播的挥手属于别人，不能回，否则会跟着挥手
  client.on('animation', p => {
    if (p.animation !== 0 || p.entityId !== myEntityId) return
    try { client.write('arm_animation', { hand: 0 }) } catch (e) { log('swing resp failed:', e.message) }
  })

  // 不倒图腾：只在“图腾被消耗”这一事件上补下一个（entity_status 35 或副手槽被清空），
  // 不做定时轮询；背包里没有备用图腾就什么都不做。
  client.on('entity_status', p => {
    if (!bot.entity || p.entityId !== bot.entity.id || p.entityStatus !== 35) return
    log('图腾已触发，立即补下一个')
    setImmediate(() => equipTotem().catch(() => {}))
  })
  bot.inventory?.on && bindTotemWatcher()

  // ---------- Sonar 验证交互（载具 / 船与矿车）----------
  // 服务端把玩家放进空中的船，要求客户端按原版顺序回 paddle / vehicle_move / look，
  // 下船后的第一个 position 包（y 更低且未落地）才会推进到下一阶段。
  const vehPositions = new Map()
  let vehTimers = []
  let vehLowestY = null
  let currentVehicleId = null
  let vehRounds = 0

  function stopVehicle () {
    vehTimers.forEach(clearTimeout)
    vehTimers = []
    vehActive = false
    currentVehicleId = null
  }

  function sendRaw (name, params) {
    rawWrite(name, params)
    if (name === 'vehicle_move' || name === 'look') rawWrite('tick_end', {})
  }

  function startVehicleTest (id, pos) {
    stopVehicle()
    vehActive = true
    currentVehicleId = id
    vehRounds++
    log(`sonar vehicle check ${vehRounds}: id=${id} y=${pos.y}`)
    // 同步玩家实体到载具位置，保证下船后的坐标在载具附近
    if (bot.entity) {
      bot.entity.position.set(pos.x, pos.y, pos.z)
      bot.entity.velocity.set(0, 0, 0)
      bot.entity.onGround = false
    }
    // 复现原版船的坠落轨迹：y 每 tick 减少 0.04（float 精度）
    let lastY = pos.y
    let motion = 0
    const ys = []
    for (let i = 0; i < 3; i++) {
      const nextY = lastY + (motion - Math.fround(0.04))
      motion = nextY - lastY
      lastY = nextY
      ys.push(nextY)
    }
    vehLowestY = ys[ys.length - 1]
    // 等 keep_alive 往返（服务端收到后才切换到 IN_BOAT）再发交互包
    ys.forEach((y, i) => {
      vehTimers.push(setTimeout(() => {
        if (!vehActive) return
        sendRaw('steer_boat', { leftPaddle: true, rightPaddle: true })
        sendRaw('vehicle_move', { x: pos.x, y, z: pos.z, yaw: 0, pitch: 0, onGround: false })
        sendRaw('look', { yaw: 0, pitch: 0, flags: { onGround: false, hasHorizontalCollision: undefined } })
        if (process.env.DEBUG_MOVE) log('OUT vehicle round', i, y)
      }, 300 + i * 120))
    })
  }

  client.on('spawn_entity', p => {
    vehPositions.set(p.entityId, { x: p.x, y: p.y, z: p.z })
  })
  client.on('set_passengers', p => {
    if (!Array.isArray(p.passengers) || !p.passengers.includes(myEntityId)) return
    const pos = vehPositions.get(p.entityId)
    if (!pos) return
    startVehicleTest(p.entityId, pos)
  })
  // 载具被移除后立刻补一个“仍在空中”的 position，Sonar 据此进入下一阶段
  client.on('entity_destroy', p => {
    if (!vehActive || !Array.isArray(p.entityIds) || !p.entityIds.includes(currentVehicleId)) return
    const y = (vehLowestY ?? 3000) - 1
    // 保持 vehActive，避免 mineflayer 的普通位置包抢先发出去
    vehTimers.forEach(clearTimeout)
    vehTimers = []
    currentVehicleId = null
    vehTimers = [setTimeout(() => {
      vehActive = false
      try {
        client.write('position', { x: 8, y, z: 8, flags: { onGround: false, hasHorizontalCollision: undefined } })
        log('sonar vehicle: sent dismount position', y)
      } catch (e) { log('dismount position failed:', e.message) }
    }, 100)]
  })

  // 登录插件消息（AuthMe 等）+ 界面信息收集
  bot.on('messagestr', msg => {
    if (process.env.DEBUG_MSG) log('MSG', msg)
    pushChatLine(msg)
    onAuthMessage(msg)
    maybeCaptcha(msg, myGen)
  })
  // 标题 / 动作栏（计分板和 Boss 栏直接读 mineflayer 的结构）
  client.on('packet', (data, meta) => {
    try {
      if (meta.name === 'set_title_text') lastTitle = { ...lastTitle, title: flattenText(data.text), at: Date.now() }
      else if (meta.name === 'set_title_subtitle') lastTitle = { ...lastTitle, subtitle: flattenText(data.text), at: Date.now() }
      else if (meta.name === 'set_action_bar_text') lastTitle = { ...lastTitle, actionBar: flattenText(data.text), at: Date.now() }
      else if (meta.name === 'clear_titles') lastTitle = { title: '', subtitle: '', actionBar: '', at: Date.now() }
    } catch {}
  })
  if (process.env.DEBUG_PACKETS) {
    client.on('packet', (data, meta) => {
      if (meta.name === 'show_dialog') log('IN', meta.name, JSON.stringify(data).slice(0, 800))
      else if (meta.name !== 'keep_alive' && meta.name !== 'registry_data') log('IN', meta.name)
    })
  }

  // 定期向服务端重发开翅，防止装备切换导致服务端漏判、按普通坠落累计伤害
  if (global.__elytraAssert) clearInterval(global.__elytraAssert)
  global.__elytraAssert = setInterval(() => {
    if (!bot || !bot.entity || bot.entity.onGround) return
    if (!flying && !bot.entity.elytraFlying) return // 普通跳跃/坠落不要误触鞘翅
    if (bot.inventory.slots[bot.getEquipmentDestSlot('torso')]?.name !== 'elytra') return
    try {
      bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 6, jumpBoost: 0 })
      bot.entity.elytraFlying = true
    } catch {}
  }, 500)

  bot.on('spawn', onSpawn)
  bot.on('chat', (username, message) => onCommand(username, message, false))
  bot.on('whisper', (username, message) => onCommand(username, message, true))
  bot.on('death', onDeath)
  bot.on('kicked', reason => {
    const s = typeof reason === 'string' ? reason : JSON.stringify(reason)
    log('kicked:', s)
    // 旧会话还没在服务端释放时不要高频重连，否则会一直撞“玩家已在线”
    if (s.includes('playerAlreadyOnline')) {
      reconnectDelay = 45000
    } else if (/not registered|please register|未注册|请注册|register/i.test(s)) {
      // 未注册被踢：重连后会自动走 /register
      log('auth: 因未注册被踢，重连后自动注册')
      reconnectDelay = 3000
    } else {
      reconnectDelay = 7000
    }
  })
  bot.on('error', err => log('error:', err.message))
  bot.on('end', reason => {
    log('disconnected:', reason)
    // 被 join/leave 换下来的旧实例：既不重连，也不碰新连接的状态
    if (myGen !== connGen) return
    if (patrolTimer) clearTimeout(patrolTimer)
    patrolTimer = null
    flying = false
    pvpName = null
    pvpRunning = false
    maceName = null
    maceRunning = false
    followCancelled = true
    followTarget = null
    followRunning = false
    collectJob = null
    collectRunning = false
    if (global.__elytraAssert) { clearInterval(global.__elytraAssert); global.__elytraAssert = null }
    if (!wantConnect) return // 已主动退服：不自动重连，等下一次 join
    reconnectTimer = setTimeout(createBot, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
  })

  bot.on('goal_reached', () => {
    if (!stopped && !flying) schedulePatrol(800 + Math.random() * 1200)
  })
  bot.on('path_update', r => {
    if (r.status === 'noPath' && !stopped && !flying) schedulePatrol(3000)
  })
  bot.on('health', () => {
    // leave() 会把全局 bot 置空，旧实例退出的最后一个 tick 仍可能回调到这里
    if (!bot || typeof bot.health !== 'number') return
    if (bot.health < lastHealth - 0.5) log(`health ${lastHealth.toFixed(1)} -> ${bot.health.toFixed(1)}`)
    lastHealth = bot.health
  })
  bot.on('physicsTick', () => {
    // 掉落保护：未开鞘翅且即将落地时，减速/转向只能靠寻路，这里仅记录
    // 退服瞬间旧实例还会再 tick 一次，此时 bot 已经是 null，必须挡掉
    if (!bot || !bot.entity) return
    const p = bot.entity
    if (!p) return
  })
  // 服务端下发的地图物品数据：按地图编号累积成 128×128 的颜色表（0 = 未探索）
  client.on('map', (p) => {
    if (!p || typeof p.itemDamage !== 'number' || p.itemDamage < 0) return
    const cur = mapDataById.get(p.itemDamage) || {
      id: p.itemDamage,
      scale: 0,
      pixels: new Uint8Array(128 * 128),
      hasData: false,
      at: 0,
    }
    cur.scale = Number(p.scale) || 0
    if (Array.isArray(p.icons)) cur.icons = p.icons
    if (p.columns && p.rows && p.data) {
      const ox = Number(p.x) || 0
      const oy = Number(p.y) || 0
      for (let rz = 0; rz < p.rows; rz++) {
        for (let rx = 0; rx < p.columns; rx++) {
          const x = ox + rx
          const y = oy + rz
          if (x < 0 || x > 127 || y < 0 || y > 127) continue
          const v = p.data[rz * p.columns + rx]
          cur.pixels[y * 128 + x] = (Number(v) || 0) & 0xff
        }
      }
      cur.hasData = true
    }
    cur.at = Date.now()
    mapDataById.set(p.itemDamage, cur)
    lastMapPacketAt = cur.at
    lastMapId = p.itemDamage
  })
}

function onSpawn () {
  reconnectDelay = 7000
  stopped = false
  lastHealth = bot.health
  setupMovements()
  log(`spawned at ${fmt(bot.entity.position)} gamemode=${bot.game.gameMode}`)

  // 复活/重生后清掉残留的按键状态，避免“卡着跳跃/疾跑”等动作异常
  try { bot.clearControlStates() } catch {}
  try { bindTotemWatcher() } catch {}
  setTimeout(() => equipTotem().catch(() => {}), 1500) // 仅登录后检查一次，不轮询
  if (bot.entity) {
    try { bot.entity.elytraFlying = false } catch {}
    try { bot.entity.velocity?.set(0, 0, 0) } catch {}
  }

  if (bot.game.gameMode !== 'survival') {
    log('WARN: 非生存模式，等待服务器强制切换或手动处理')
  }
  if (global.__gmTimer) clearInterval(global.__gmTimer)
  global.__gmTimer = setInterval(() => {
    if (bot.entity && bot.game.gameMode !== 'survival') {
      log(`WARN: 当前模式 ${bot.game.gameMode}，要求 survival`)
    }
  }, 5000)
  global.__gmTimer.unref()

  // 若在上一局飞行途中掉线，重连会在空中，先开翅避免摔落
  if (!bot.entity.onGround) {
    equipElytra().then(() => glideStart()).catch(() => {})
  }

  // 每次进入游戏都先走登录流程，未登录前不巡逻/不执行指令
  authState = 'pending'
  authTries = 0
  authResponded = false
  authSeen = false
  regTries = 0
  captcha = { pending: false, path: null, at: 0, error: '' }
  global.__regLastAt = 0
  if (patrolTimer) clearTimeout(patrolTimer)
  patrolTimer = null
  setTimeout(() => tryAuth(), 600)
}

// ---------- 登录插件（AuthMe）适配 ----------
function sendCmd (cmd) {
  try { bot.chat(cmd) } catch (e) { log('chat failed:', e.message) }
}

function tryAuth () {
  if (authState === 'done' || !bot.entity) return
  if (!AUTH_PASSWORD) { log('auth: 未配置密码（config.json 的 password 或 MC_PASSWORD）'); return }
  authState = 'pending'
  authTries++
  global.__lastAuthAt = Date.now()
  log(`auth attempt ${authTries}: /login`)
  sendCmd(`/login ${AUTH_PASSWORD}`)
  // 没收到任何插件提示才按“无登录插件”继续；见过提示说明是未注册/密码错误，不能跳过
  if (authTries >= 3 && !authResponded && !authSeen) {
    log('auth: 未收到登录插件响应，按无登录插件继续')
    markAuthed('no-auth-plugin')
  }
}

// 首次进服自动注册：不同登录插件的命令和参数个数不一样，逐个试
// AuthMe 默认 /register <密码> <确认密码>；部分配置只要一个密码，也有插件用 /reg
const REG_FORMS = [
  pw => `/register ${pw} ${pw}`,
  pw => `/register ${pw}`,
  pw => `/reg ${pw} ${pw}`,
  pw => `/reg ${pw}`
]

function tryRegister () {
  if (authState === 'done' || !bot.entity) return
  if (!AUTH_PASSWORD) { log('auth: 未注册，但没有配置密码（config.json 的 password 或 MC_PASSWORD），无法自动注册'); return }
  // 同一条提示可能连发两次，2.5s 内只发一条注册指令
  if (Date.now() - (global.__regLastAt || 0) < 2500) return
  if (regTries >= REG_FORMS.length) {
    log('auth: 注册已试 4 种写法仍失败，检查密码规则或服端注册提示')
    return
  }
  global.__regLastAt = Date.now()
  const cmd = REG_FORMS[regTries++](AUTH_PASSWORD)
  log(`auth: 未注册，自动注册（第 ${regTries} 种写法）`)
  sendCmd(cmd)
  // 有些服务端注册后不自动登录，4 秒后补一次 /login 验证
  setTimeout(() => { if (authState !== 'done') tryAuth() }, 4000)
}

function markAuthed (how) {
  if (authState === 'done') return
  authState = 'done'
  log(`auth ok (${how})`)
  recoverAfterSpawn()
  resumeMode()
}

// 死亡后会掉进出生点基岩井/海上出生点：先 /spawn 出来，再 /home 回工作区
function recoverAfterSpawn () {
  for (const d of [2500, 8000]) {
    setTimeout(() => {
      if (!bot || !bot.entity) return
      const empty = bot.inventory.items().length === 0
      if (stuckAtSpawn()) {
        log('[dev] 卡在出生点基岩井里，发 /spawn')
        try { bot.chat('/spawn') } catch {}
        setTimeout(() => { if (bot.entity) try { bot.chat('/home base') } catch {} }, 3500)
      } else if (empty) {
        // 死亡清空背包（keepInventory=false）：别在出生点刷怪区裸手站着，回工作区再发育
        log('[dev] 背包空了，/home 回工作区')
        try { bot.chat('/home base') } catch {}
      }
      setTimeout(() => { escapeWater().catch(() => {}) }, 1500)
    }, d)
  }
}

// 四向都是基岩 = 被困在出生点竖井
function stuckAtSpawn () {
  if (!bot || !bot.entity) return false
  if (bot.entity.position.y < 10) return true // 这个世界底部就是基岩出生井
  const p = bot.entity.position.floored()
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => {
    const b = bot.blockAt(p.offset(dx, 0, dz))
    return b && b.name === 'bedrock'
  })
}

// 登录完成后按持久化的模式继续执行，agent 不在线也不会停下
function resumeMode () {
  if (!bot || !bot.entity) return
  switch (mode.kind) {
    case 'stopped':
      stopped = true
      if (patrolTimer) clearTimeout(patrolTimer)
      patrolTimer = null
      try { bot.pathfinder.setGoal(null) } catch {}
      log('resume: 保持停止')
      break
    case 'goto':
      log(`resume: 继续前往 ${mode.x} ${mode.y} ${mode.z}`)
      dispatchCommand('agent', `goto ${mode.x} ${mode.y} ${mode.z}`).catch(() => {})
      break
    case 'pvp':
    case 'mace':
      if (mode.name && bot.players[mode.name]?.entity) {
        log(`resume: 继续 ${mode.kind} -> ${mode.name}`)
        dispatchCommand('agent', `${mode.kind} ${mode.name}`).catch(() => {})
      } else {
        saveMode('patrol')
        stopped = false
        schedulePatrol(1500)
      }
      break
    case 'follow': {
      const spec = { kind: mode.name ? 'player' : 'entity', name: mode.name, type: mode.type }
      if (spec.name || spec.type) {
        log(`resume: 继续跟随 ${followLabel(spec)}`)
        runFollow(spec)
      } else {
        saveMode('patrol')
        stopped = false
        schedulePatrol(1500)
      }
      break
    }
    case 'collect':
      if (mode.type) {
        log(`resume: 继续收集 ${mode.type} x${mode.count || 1}`)
        runCollect(mode.type, mode.count || 1)
      } else {
        saveMode('patrol')
        stopped = false
        schedulePatrol(1500)
      }
      break
    case 'develop':
      if (!DEV.running) {
        log('resume: 继续自主发育')
        develop().catch(() => {})
      }
      break
    default: // patrol / fly（落地后不重复起飞）
      saveMode('patrol')
      stopped = false
      schedulePatrol(1200)
  }
}

function onAuthMessage (msg) {
  const m = String(msg || '')
  const low = m.toLowerCase()

  // 已登录（含注册后自动登录）
  if (/successful(ly)? (login|logged in|registered)|registered successfully|you are now (logged in|authenticated)|already logged in|登录成功|注册成功|成功注册|认证成功/.test(low)) {
    authResponded = true
    authSeen = true
    captcha = { pending: false, path: null, at: 0, error: '' }
    markAuthed('plugin-confirmed')
    return
  }
  // 需要注册（/register、/reg 两种写法，中英文提示都覆盖）
  if (/isn'?t registered|not registered|please register|register using|\/reg(?:ister)?\b|你还没有注册|请注册|尚未注册|未注册|register an account|注册一个账号/.test(low)) {
    authResponded = true
    authSeen = true
    tryRegister()
    return
  }
  // 已经注册过了（注册指令重复发时）：转登录
  if (/already registered|已经注册|该账号已注册/.test(low)) {
    authResponded = true
    authSeen = true
    if (authState !== 'done' && Date.now() - (global.__lastAuthAt || 0) > 2000) setTimeout(() => tryAuth(), 600)
    return
  }
  // 需要登录
  if (/please,? login|login using|\/login|not logged in|未登录|请登录|请先登录/.test(low)) {
    authResponded = true
    authSeen = true
    if (authState !== 'done' && Date.now() - (global.__lastAuthAt || 0) > 2000) setTimeout(() => tryAuth(), 800)
    return
  }
  // 注册命令写法不对（参数个数不同）：立刻换下一种
  if (/usage:|unknown command|not a command|unknown or incomplete command/.test(low)) {
    if (authState !== 'done' && regTries > 0 && regTries < REG_FORMS.length) {
      global.__regLastAt = 0
      setTimeout(() => tryRegister(), 500)
    } else if (!authSeen) {
      markAuthed('no-auth-plugin')
    }
    return
  }
  // 密码规则 / 注册被拒
  if (/password (must|should|may|can)|incorrect password|wrong password|密码(长度|太短|太长|不能|必须|只能|错误)|注册失败|register failed/.test(low)) {
    log('auth: 注册/登录被拒:', m.slice(0, 120))
  }
}

// ---------- 复杂寻路 ----------
function setupMovements () {
  const m = new Movements(bot)
  m.canDig = true            // 遇到障碍可挖掘
  m.digCost = 1              // 与 Baritone 的挖掘代价同一量级；太高会逼着 A* 绕远路
  m.placeCost = 6
  m.allowParkour = true      // 跳跃跨越
  m.allow1by1towers = true   // 垫方块上/下
  m.allowSprinting = true
  m.allowFreeMotion = false
  m.canOpenDoors = true
  m.canEnterLadders = true
  m.maxDropDown = 3          // 别为了抄近路跳崖，3 格以内
  m.liquidCost = 30          // 尽量别走水路（之前反复淹死）

  const byName = bot.registry.itemsByName
  m.scafoldingBlocks = ['dirt', 'cobblestone', 'oak_planks', 'sand', 'netherrack', 'stone']
    .filter(n => byName[n])
    .map(n => byName[n].id)

  bot.pathfinder.setMovements(m)
  // 目标可能在 40 格外的矿层：放宽单次 A* 计算时间（超时会先走 partial path 再重算）
  bot.pathfinder.thinkTimeout = 10000
  bot.pathfinder.tickTimeout = 40
}

function schedulePatrol (delay) {
  if (patrolTimer) clearTimeout(patrolTimer)
  patrolTimer = setTimeout(() => {
    if (stopped || flying || !bot.entity) return
    if (authState !== 'done') { schedulePatrol(1000); return }
    const p = bot.entity.position
    const a = Math.random() * Math.PI * 2
    const r = 8 + Math.random() * 16
    const x = p.x + Math.cos(a) * r
    const z = p.z + Math.sin(a) * r
    bot.pathfinder.setGoal(new goals.GoalNear(x, p.y, z, 1))
  }, delay)
}

// 只走路不挖：避免寻路器自己到处乱挖（洞穴探索、靠近矿石时用）
async function gotoNoDig (x, y, z, timeout = 60000, range = 0) {
  const m = bot.pathfinder.movements
  const old = m.canDig
  m.canDig = false
  try { await goto(x, y, z, timeout, range) } finally { m.canDig = old }
}

function goto (x, y, z, timeout = 60000, range = 0) {
  return new Promise((resolve, reject) => {
    stopped = true
    let done = false
    let setAt = 0
    const finish = (err) => {
      if (done) return
      done = true
      // 退服后 bot 已经置空：清理动作全部跳过，只把 Promise 收尾
      if (bot) {
        bot.removeListener('goal_reached', onReach)
        bot.removeListener('path_update', onUpdate)
        bot.removeListener('path_stop', onStop)
      }
      clearTimeout(timer)
      try { bot.clearControlStates() } catch {} // 寻路结束立刻松手，避免残留移动把挖掘打断
      // 关键：超时/noPath 之后 pathfinder 的执行器还会继续挖/继续装备工具，
      // 会把我们接下来的 dig/place 打断（“Digging aborted”/“Server refused to place stone_pickaxe”）
      try { bot.pathfinder.stop() } catch {}
      if (err) reject(err); else resolve()
    }
    const onReach = () => finish()
    const onUpdate = r => { if (r.status === 'noPath') finish(new Error('noPath')) }
    const onStop = () => { if (Date.now() - setAt > 600) finish(new Error('goto stopped')) }
    const timer = setTimeout(() => finish(new Error('goto timeout')), timeout)
    bot.on('goal_reached', onReach)
    bot.on('path_update', onUpdate)
    bot.on('path_stop', onStop)
    setAt = Date.now()
    bot.pathfinder.setGoal(range > 0 ? new goals.GoalNear(x, y, z, range) : new goals.GoalBlock(x, y, z))
  })
}

// Baritone 风格：直接给一个 Goal 对象（GoalThreeBlocks / GoalTwoBlocks / GoalCompositeAny），
// A* 会带着“挖穿/下落”代价算出整条路线，而不是我们自己一格一格瞎挖。
//
// 对照 AbstractNodeCostSearch / PathExecutor：
//   - 算不出路（noPath）= calcFailed，交给上层拉黑最近的矿
//   - 算超时（timeout）= Baritone 也只是一条 partial path：先执行，边走边重算
//     这里用看门狗实现“重算”：路径走完但没到目标就重新 setGoal
function gotoGoal (goal, timeout = 90000) {
  return new Promise((resolve, reject) => {
    stopped = true
    let done = false
    let setAt = Date.now()
    let lastPlanAt = 0
    let replans = 0

    const finish = (err) => {
      if (done) return
      done = true
      clearInterval(planTimer)
      clearTimeout(timer)
      if (bot) {
        bot.removeListener('goal_reached', onReach)
        bot.removeListener('path_update', onUpdate)
        bot.removeListener('path_stop', onStop)
      }
      try { bot.clearControlStates() } catch {}
      // 寻路彻底停掉：不然 pathfinder 的执行器还在自己挖，和我们的 digBlock 抢方块
      try { bot.pathfinder.stop() } catch {}
      if (err) reject(err); else resolve()
    }
    const onReach = () => finish()
    const onUpdate = r => {
      if (r.status === 'noPath') finish(new Error('noPath'))
      else if (r.status === 'timeout') {
        log(`[dev] A* 超时（${Math.round(r.time)}ms / ${r.visitedNodes} 节点），先走部分路径`)
      }
    }
    // setGoal 会让上一条路发出 path_stop；刚开始 1.5 秒内的 stop 是旧路径的，忽略
    const onStop = () => { if (Date.now() - setAt > 1500) finish(new Error('goto stopped')) }
    const timer = setTimeout(() => finish(new Error('goto timeout')), timeout)

    // 重算看门狗：partial 路径走完（或 A* 超时后原地停住）时重新规划，
    // 等价于 Baritone 的持续重算，避免“partial path 执行完就永久静止”
    const planTimer = setInterval(() => {
      if (done || !bot || !bot.entity) return
      const feet = bot.entity.position.floored()
      let reached = false
      try { reached = goal.isEnd(feet) } catch {}
      if (reached) return finish()
      if (bot.pathfinder.isMoving() || bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) return
      if (Date.now() - lastPlanAt < 1200) return
      if (++replans > 40) return finish(new Error('replan too many'))
      lastPlanAt = Date.now()
      setAt = Date.now()
      try { bot.pathfinder.setGoal(goal) } catch (e) { finish(e) }
    }, 1000)

    bot.on('goal_reached', onReach)
    bot.on('path_update', onUpdate)
    bot.on('path_stop', onStop)
    try { bot.pathfinder.movements.canDig = true } catch {}
    setAt = Date.now()
    lastPlanAt = Date.now()
    bot.pathfinder.setGoal(goal)
  })
}

// ---------- 鞘翅 ----------
function findItem (name) {
  return bot.inventory.items().find(i => i.name === name)
}

// 1.21.11 (protocol 774) 中 start_elytra_flying 的 actionId 是 6，
// mineflayer 旧逻辑会发 8，导致服务器忽略、无法真正滑翔。
function glideStart () {
  bot._client.write('entity_action', {
    entityId: bot.entity.id,
    actionId: 6,
    jumpBoost: 0
  })
  bot.entity.elytraFlying = true
}

async function equipElytra () {
  const torsoSlot = bot.getEquipmentDestSlot('torso')
  if (bot.inventory.slots[torsoSlot]?.name === 'elytra') return
  const e = findItem('elytra') || bot.inventory.slots.find(s => s && s.name === 'elytra')
  if (!e) throw new Error('背包里没有鞘翅')
  await bot.equip(e, 'torso')
}

async function ensureRocketInHand () {
  if (bot.heldItem?.name === 'firework_rocket') return true
  const fw = findItem('firework_rocket')
  if (!fw) return false
  await bot.equip(fw, 'hand')
  return true
}

// mineflayer/prismarine-physics 的 pitch 约定：正值抬头，负值俯冲
// 空中点火。必须已经在滑翔且离地，否则推进会被物理层立刻清零。
async function boostOnce (pitch = 0.7) {
  if (!bot.entity || bot.entity.onGround || !bot.entity.elytraFlying) return false
  const fw = bot.heldItem?.name === 'firework_rocket' ? bot.heldItem : findItem('firework_rocket')
  if (!fw) return false
  if (bot.heldItem?.name !== 'firework_rocket') await bot.equip(fw, 'hand')
  await bot.look(bot.entity.yaw, pitch, true)
  bot.activateItem()
  await sleep(80)
  // 若服务端没回传烟花元数据，本地补齐推进时长（与真实烟花约 2 秒一致）
  if (bot.fireworkRocketDuration <= 0) bot.fireworkRocketDuration = 40
  return true
}

// 起飞：先拿烟花 -> 跳跃 -> 空中开翅 -> 空中点火爬升
async function takeOff () {
  await equipElytra()
  if (!(await ensureRocketInHand())) throw new Error('背包里没有烟花')

  for (let attempt = 1; attempt <= 5; attempt++) {
    const y0 = bot.entity.position.y

    if (!bot.entity.onGround) {
      // 已在空中（从边缘掉落等），直接开翅点火
      if (!bot.entity.elytraFlying) glideStart()
      if (await boostOnce(0.7)) {
        try {
          await waitFor(() => bot.entity.position.y > y0 + 1.2, 2500, 40)
          log(`已起飞 (attempt ${attempt})`)
          return
        } catch {}
      }
    } else {
      bot.setControlState('jump', true)
      try {
        // 起跳上升到速度仍向上时开翅
        await waitFor(() => !bot.entity.onGround && bot.entity.velocity.y > 0.05, 1500, 20)
        glideStart()
        await bot.look(bot.entity.yaw, 0.7, true)
        await boostOnce(0.7)
        await waitFor(() => bot.entity.position.y > y0 + 1.2, 2500, 40)
        bot.setControlState('jump', false)
        log(`已起飞 (attempt ${attempt})`)
        return
      } catch (e) {
        log(`起飞尝试 ${attempt} 失败: ${e.message}`)
        bot.setControlState('jump', false)
        if (!bot.entity.onGround) {
          // 已经在空中：保持滑翔，避免直接摔下去扣血
          try { if (!bot.entity.elytraFlying) glideStart() } catch {}
          await sleep(200)
          continue
        }
      }
      bot.setControlState('jump', false)
      bot.clearControlStates()
    }
    await sleep(250)
  }
  throw new Error('无法起飞（烟花不足或空间不足）')
}

// 目标 y 为降落高度；先爬升到巡航高度，水平接近后主动下降触地
async function flyTo (tx, ty, tz, timeout = 180000, opts = {}) {
  if (flying) throw new Error('正在飞行')
  if (patrolTimer) clearTimeout(patrolTimer)
  bot.pathfinder.setGoal(null)

  flying = true
  stopped = true
  flyAbort = false
  const healthBefore = bot.health
  const cruiseY = Math.max(ty + 25, bot.entity.position.y + 25)
  const t0 = Date.now()
  let tookOff = false
  let landedOk = false
  let lastBoostAt = 0
  let lastRetake = 0
  let lastLog = 0
  let lastWallLog = 0

  try {
    if ((bot.inventory.items().filter(i => i.name === 'firework_rocket')
      .reduce((n, i) => n + i.count, 0)) < 2) {
      throw new Error('烟花不足')
    }

    await takeOff()
    tookOff = true

    while (Date.now() - t0 < timeout) {
      if (!bot.entity) throw new Error('实体丢失')
      if (flyAbort) {
        log('飞行已取消，就地滑翔降落')
        break
      }
      const p = bot.entity.position
      const dx = tx - p.x
      const dz = tz - p.z
      const horiz = Math.hypot(dx, dz)

      // 已落地
      if (bot.entity.onGround) {
        if (horiz < 8 && Math.abs(p.y - ty) < 8) break
        if (Date.now() - lastRetake > 1500) {
          lastRetake = Date.now()
          await takeOff()
        }
        await sleep(80)
        continue
      }

      if (!bot.entity.elytraFlying) glideStart()

      const atCruise = p.y >= cruiseY - 4
      const tooHigh = p.y > cruiseY + 10
      // 接近目标后进入下降进场；低于目标高度时必须继续爬升，否则会反复贴地起飞
      const alt = p.y - ty
      const descend = horiz < 18 && alt >= -2

      let pitch
      if (descend) {
        // 进场下降：烟花还在推进时保持浅角，等推力结束再缓慢下压，避免高速砸地
        if (bot.fireworkRocketDuration > 0) pitch = 0.15
        else pitch = -Math.min(0.55, 0.15 + Math.max(0, alt) * 0.02)
      } else if (!atCruise) pitch = 0.55
      else if (tooHigh) pitch = -0.2
      else pitch = 0.08

      // 下坠速度过快就抬头拉平（撞墙/砸地的动能伤害都来自这里）
      if (bot.entity.velocity.y < -0.55) pitch = Math.max(pitch, 0.35)

      // 离地面已经很近时提前拉平，别贴地俯冲
      let groundY = null
      for (let dy = 1; dy <= 10; dy++) {
        const gb = bot.blockAt(p.offset(0, -dy, 0))
        if (gb && gb.boundingBox === 'block') { groundY = p.y - dy + 1; break }
      }
      if (groundY !== null && p.y - groundY < 3) pitch = Math.max(pitch, 0.4)

      const yaw = Math.atan2(-dx, -dz)

      // 前方有实体方块就抬头爬升，避免鞘翅撞墙以“动能”判定暴毙
      if (horiz > 0.1) {
        const ux = dx / horiz
        const uz = dz / horiz
        let blocked = 0
        for (const [d, oy] of [[1.4, 1.4], [1.4, 0.5], [2.6, 1.4], [2.6, 0.5], [3.8, 1.0]]) {
          const b = bot.blockAt(p.offset(ux * d, oy, uz * d))
          if (b && b.boundingBox === 'block') { blocked = d; break }
        }
        if (blocked) {
          pitch = Math.max(pitch, 1.0)
          // 贴得很近时用烟花快速拉起
          if (blocked <= 2.6 && Date.now() - lastBoostAt > 1000 && bot.fireworkRocketDuration <= 0) {
            lastBoostAt = Date.now()
            try { await boostOnce(0.9) } catch {}
          }
          if (Date.now() - lastWallLog > 1000) {
            lastWallLog = Date.now()
            log(`前方 ${blocked} 格有障碍，抬升规避`)
          }
        }
      }

      // 血量太低先放弃飞行滑翔落地，别把自己摔死
      if (bot.health <= 6) {
        log('血量过低，放弃飞行')
        break
      }

      // 卡进方块（撞穿/贴墙）时先把自己身体和头部的方块挖掉
      for (const oy of [0.5, 1.6]) {
        const stuck = bot.blockAt(p.offset(0, oy, 0))
        if (stuck && stuck.boundingBox === 'block' && stuck.name !== 'bedrock') {
          try { log('卡在方块中，挖开', stuck.name); await bot.dig(stuck) } catch {}
          break
        }
      }

      await bot.look(yaw, pitch, true)

      // 爬升阶段点火，当前烟花耗尽后再补一颗
      if (!atCruise && !descend && bot.entity.elytraFlying &&
          bot.fireworkRocketDuration <= 0 && Date.now() - lastBoostAt > 300) {
        lastBoostAt = Date.now()
        if (!(await boostOnce(0.7))) {
          log('没有烟花了，改为滑翔降落')
          break
        }
      }

      if (Date.now() - lastLog > 1000) {
        lastLog = Date.now()
        log(`fly y=${p.y.toFixed(1)} horiz=${horiz.toFixed(1)} vy=${bot.entity.velocity.y.toFixed(2)} ground=${bot.entity.onGround} ely=${Boolean(bot.entity.elytraFlying)} fw=${bot.fireworkRocketDuration}`)
      }

      await sleep(60)
    }

    // 收尾：贴着目标下降，保持滑翔直到触地
    if (!bot.entity.onGround) {
      for (let i = 0; i < 200 && !bot.entity.onGround; i++) {
        const p = bot.entity.position
        const yaw = Math.atan2(-(tx - p.x), -(tz - p.z))
        const horiz = Math.hypot(tx - p.x, tz - p.z)
        if (!bot.entity.elytraFlying) glideStart()
        // 距地面很近时抬头拉平，避免带着下坠速度砸地扣血
        let groundY = null
        for (let dy = 1; dy <= 12; dy++) {
          const b = bot.blockAt(p.offset(0, -dy, 0))
          if (b && b.boundingBox === 'block') { groundY = p.y - dy + 1; break }
        }
        const altG = groundY === null ? 99 : p.y - groundY
        const landingPitch = altG < 2.5 ? 0.45 : (altG < 5 ? 0.15 : (horiz > 3 ? -0.2 : -0.3))
        await bot.look(yaw, landingPitch, true)
        await sleep(60)
      }
    }
    if (!bot.entity.onGround) throw new Error('未能安全着陆')
    log(`安全降落于 ${fmt(bot.entity.position)}`)

    // 落地后若偏离目标不远，用寻路走完最后一段
    // 跟随模式（walk:false）下由跟随循环的 GoalFollow 接管，避免两套寻路互相覆盖
    const p2 = bot.entity.position
    const rest = Math.hypot(tx - p2.x, tz - p2.z)
    if (opts.walk !== false && rest > 3 && rest < 48) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, Math.min(60000, rest * 1500))
        bot.once('goal_reached', () => { clearTimeout(timer); resolve() })
        bot.pathfinder.setGoal(new goals.GoalNear(tx, ty, tz, 2))
      })
      bot.pathfinder.setGoal(null)
    }
    landedOk = true
  } finally {
    flying = false
    flyAbort = false
    stopped = false
    lastHealth = bot.health
    if (landedOk && opts.patrol !== false) schedulePatrol(2000)
    if (tookOff) {
      const lost = healthBefore - bot.health
      if (lost > 0.5) {
        log(`WARN: 降落损失 ${lost.toFixed(1)} 生命`)
        await eatIfNeeded()
      } else {
        log('landing without damage')
      }
    }
  }
}

async function eatIfNeeded () {
  if (!bot.food || bot.food >= 20) return
  const food = bot.inventory.items().find(i => bot.registry.foodsByName && bot.registry.foodsByName[i.name])
  if (!food) return
  try {
    await bot.equip(food, 'hand')
    bot.activateItem()
    await sleep(1600)
    bot.deactivateItem()
  } catch {}
}

// ---------- 简单 PvP ----------
let pvpName = null
let pvpRunning = false
let lastAttackAt = 0

function bestWeapon () {
  for (const tier of ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']) {
    const w = findItem(`${tier}_sword`) || findItem(`${tier}_axe`)
    if (w) return w
  }
  return null
}

async function equipWeapon () {
  const w = bestWeapon()
  if (w && bot.heldItem?.name !== w.name) {
    try { await bot.equip(w, 'hand') } catch {}
  }
}

const HOSTILES = ['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime',
  'magma_cube', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'evoker', 'phantom', 'blaze',
  'hoglin', 'zoglin', 'wither_skeleton', 'warden', 'ravager']
const MUST_FLEE = ['creeper', 'warden', 'ravager', 'evoker', 'witch']

// 有怪就打，血少/危险怪就躲
async function handleThreats () {
  if (!bot.entity) return false
  const me = bot.entity.position
  const threats = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.name && HOSTILES.includes(e.name) && e.position.distanceTo(me) < 12)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
  if (!threats.length) return false
  const t = threats[0]
  if (t.position.distanceTo(me) > 9) return false
  // 没武器/没护甲的时候近战就是送死：赤手空拳打不死僵尸/北极熊，先跑
  const armed = bot.inventory.items().some(i => /_(sword|axe)$/.test(i.name))
  const armored = bot.inventory.items().some(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name))
  if (bot.health <= 8 || MUST_FLEE.includes(t.name) || (!armed && !armored)) {
    log(`[dev] 躲怪 ${t.name}（hp ${bot.health}${!armed && !armored ? '，裸装' : ''}）`)
    const dx = me.x - t.position.x
    const dz = me.z - t.position.z
    const n = Math.hypot(dx, dz) || 1
    try { await goto(me.x + (dx / n) * 18, me.y, me.z + (dz / n) * 18, 12000, 2) } catch {}
    return true
  }
  log(`[dev] 反击 ${t.name}（hp ${bot.health}）`)
  try { await equipWeapon() } catch {}
  for (let i = 0; i < 60; i++) {
    if (!t.isValid || !bot.entity) break
    if (bot.health <= 7) await eatDevFood()
    if (t.position.distanceTo(bot.entity.position) > 3) {
      try { await goto(t.position.x, t.position.y, t.position.z, 4000, 2) } catch {}
    }
    try { await bot.lookAt(t.position.offset(0, Math.min(1.2, t.height * 0.8), 0), true) } catch {}
    try { await bot.attack(t) } catch {}
    await sleep(500)
  }
  return true
}

async function equipArmor () {
  const pieces = [['helmet', 'head'], ['chestplate', 'torso'], ['leggings', 'legs'], ['boots', 'feet']]
  for (const [piece, slot] of pieces) {
    let item = null
    for (const tier of ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']) {
      item = findItem(`${tier}_${piece}`)
      if (item) break
    }
    if (item) { try { await bot.equip(item, slot) } catch {} }
  }
}

// 副手图腾：只在图腾被消耗后立刻补下一个；背包没有就不管
let totemPending = false
async function equipTotem () {
  if (totemPending || !bot || !bot.entity) return
  totemPending = true
  try {
    if (bot.inventory.slots[45]?.name === 'totem_of_undying') return
    const totem = findItem('totem_of_undying')
    if (!totem) return
    const t0 = Date.now()
    await bot.equip(totem, 'off-hand')
    log(`补图腾完成，用时 ${Date.now() - t0}ms`)
  } catch (e) { log('equip totem failed:', e.message) } finally { totemPending = false }
}

// 监听背包变化：图腾进背包就装上副手；副手图腾被消耗就补下一个（事件驱动，不轮询）
let totemWatcherWindow = null
function bindTotemWatcher () {
  const inv = bot && bot.inventory
  if (!inv || totemWatcherWindow === inv) return
  totemWatcherWindow = inv
  inv.on('updateSlot', (slot, oldItem, newItem) => {
    const wasTotem = oldItem?.name === 'totem_of_undying'
    const isTotem = newItem?.name === 'totem_of_undying'
    if ((slot === 45 && wasTotem && !isTotem) || (slot !== 45 && isTotem)) {
      setImmediate(() => equipTotem().catch(() => {}))
    }
  })
}

function stopPvp (reason) {
  const active = pvpName !== null || pvpRunning
  pvpName = null
  pvpRunning = false
  if (patrolTimer) clearTimeout(patrolTimer)
  patrolTimer = null
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.setControlState('sprint', false)
  if (active && reason) { bot.chat(reason); log(reason) }
  return active
}

async function runPvp (name) {
  pvpName = name
  pvpRunning = true
  stopped = true
  clearTimeout(patrolTimer)
  patrolTimer = null
  await equipArmor()
  await equipWeapon()
  bot.chat(`PvP 目标 ${name}`)
  log(`pvp start -> ${name}`)
  let chasing = false
  try {
    while (pvpName === name) {
      const target = bot.players[name]?.entity
      if (!target) {
        stopPvp(`目标 ${name} 不在视野内，PvP 结束`)
        break
      }
      const dist = bot.entity.position.distanceTo(target.position)
      if (dist > 3.4) {
        if (!chasing) {
          bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.8), true)
          bot.setControlState('sprint', true)
          chasing = true
        }
      } else {
        if (chasing) {
          bot.pathfinder.setGoal(null)
          bot.setControlState('sprint', false)
          chasing = false
        }
        await bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true)
        if (Date.now() - lastAttackAt > 620) { // 剑的满蓄力间隔
          lastAttackAt = Date.now()
          bot.attack(target)
        }
      }
      await sleep(80)
    }
  } catch (e) {
    stopPvp(`PvP 出错: ${e.message}`)
  } finally {
    pvpRunning = false
  }
}

// ---------- 鞘翅烟花重锤 ----------
let maceName = null
let maceRunning = false
let maceCancelled = false

function stopMace (reason) {
  const active = maceName !== null || maceRunning
  if (active) maceCancelled = true
  maceName = null
  if (active && reason) { bot.chat(reason); log(reason) }
  return active
}

// 保持当前视线方向使用烟花（不改变俯冲角度）
async function useFirework () {
  if (!bot.entity || bot.entity.onGround || !bot.entity.elytraFlying) return false
  const fw = bot.heldItem?.name === 'firework_rocket' ? bot.heldItem : findItem('firework_rocket')
  if (!fw) return false
  if (bot.heldItem?.name !== 'firework_rocket') await bot.equip(fw, 'hand')
  bot.activateItem()
  await sleep(60)
  if (bot.fireworkRocketDuration <= 0) bot.fireworkRocketDuration = 40
  return true
}

async function equipMace () {
  const m = findItem('mace')
  if (m && bot.heldItem?.name !== 'mace') {
    try { await bot.equip(m, 'hand') } catch {}
  }
}

// 切到胸甲（没有胸甲就脱掉鞘翅），取消滑翔开始累计坠落距离
async function swapOffElytra () {
  const cp = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']
    .map(t => findItem(`${t}_chestplate`)).find(Boolean)
  try {
    if (cp) await bot.equip(cp, 'torso')
    else await bot.unequip('torso')
  } catch {}
}

// 反复确认重新开翅，并用烟花稳住高度，避免风暴弹起后摔落
async function recoverElytra (maxMs = 1800) {
  const t0 = Date.now()
  let tries = 0
  while (Date.now() - t0 < maxMs && tries < 3) {
    if (!bot.entity || bot.entity.onGround) return
    try { await equipElytra() } catch {}
    glideStart() // 每轮重发，避免服务端因装备包顺序忽略首次开翅
    await sleep(120)
    if (bot.fireworkRocketDuration <= 0) await useFirework()
    tries++
  }
}

// 爬到目标上方指定高度
async function maceClimbTo (tx, ty, tz, timeout = 25000) {
  const t0 = Date.now()
  let lastUse = 0
  while (Date.now() - t0 < timeout) {
    if (!bot.entity) return false
    if (bot.entity.onGround) await takeOff()
    if (!bot.entity.elytraFlying) glideStart()
    const p = bot.entity.position
    const dx = tx - p.x
    const dz = tz - p.z
    const dy = ty - p.y
    const horiz = Math.hypot(dx, dz)
    if (horiz < 4 && Math.abs(dy) < 4) return true
    await bot.look(Math.atan2(-dx, -dz), dy > 1 ? 0.6 : dy < -2 ? -0.25 : 0.05, true)
    if (dy > 1 && bot.fireworkRocketDuration <= 0 && Date.now() - lastUse > 350) {
      lastUse = Date.now()
      if (!(await useFirework())) return false
    }
    await sleep(60)
  }
  return false
}

// 连招结束后从空中安全降落（滑翔俯冲，落地不扣血）
async function landSafely (timeout = 45000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (!bot.entity || bot.entity.onGround) {
      log('landed after mace')
      return true
    }
    try { await equipElytra() } catch {}
    if (!bot.entity.elytraFlying) glideStart()
    await bot.look(bot.entity.yaw, -1.2, true)
    await sleep(200)
  }
  log('landSafely timeout')
  return false
}

// 俯冲 -> 切甲/脱鞘翅 -> 重锤 -> 被风暴弹起后重新开翅
async function maceDiveAndStrike (name) {
  const t0 = Date.now()
  let lastUse = 0

  // 1) 俯冲：远处用烟花加速，接近目标上空后交还给滑翔
  while (Date.now() - t0 < 15000) {
    const target = bot.players[name]?.entity
    if (!target) return false
    const tp = target.position
    const p = bot.entity.position
    if (bot.entity.onGround) return false

    const horiz = Math.hypot(tp.x - p.x, tp.z - p.z)
    const above = p.y - tp.y
    if (above <= 10 && horiz <= 2.0) break

    await bot.lookAt(tp.offset(0, target.height * 0.8, 0), true)
    if (p.distanceTo(tp) > 25 && bot.entity.elytraFlying &&
        bot.fireworkRocketDuration <= 0 && Date.now() - lastUse > 700) {
      lastUse = Date.now()
      await useFirework()
    }
    await sleep(40)
  }

  // 2) 打击：切甲 + 重锤，在坠落过程中反复尝试直到风暴触发或落地
  await equipMace()
  await swapOffElytra()
  bot.entity.elytraFlying = false
  await sleep(90)
  let hit = false
  let burst = false
  for (let i = 0; i < 60; i++) {
    const target = bot.players[name]?.entity
    if (!target || bot.entity.onGround) break
    const tp = target.position
    const aim = tp.offset(0, target.height * 0.8, 0)
    await bot.lookAt(aim, true)
    const dist = bot.entity.position.distanceTo(tp)
    const above = bot.entity.position.y - tp.y
    const horiz = Math.hypot(tp.x - bot.entity.position.x, tp.z - bot.entity.position.z)
    // 服务器攻击判定距离 3.0，且必须处于坠落状态（fallDistance>0）才会触发风暴
    if (dist <= 2.9 && bot.entity.velocity.y < -0.05) {
      bot.attack(target)
      hit = true
      log(`mace hit ${name} dist=${dist.toFixed(1)} above=${above.toFixed(1)} vy=${bot.entity.velocity.y.toFixed(2)}`)
      await sleep(70)
      if (bot.entity.velocity.y > 0.2) { burst = true; break } // 风暴已触发
    } else if ((above < 2 && bot.entity.velocity.y < -0.5) ||
               (above < 3.5 && horiz > 2.5 && bot.entity.velocity.y < -0.8)) {
      // 离目标太远又濒临触地：立刻恢复滑翔，避免摔落伤害（开翅会清空坠落距离）
      log('mace strike aborted near ground, re-glide')
      await recoverElytra(500)
      break
    }
    await sleep(30)
  }
  if (!hit) log('mace strike missed')
  if (burst) log('wind burst triggered')
  log(`after strike vy=${bot.entity.velocity.y.toFixed(2)}`)

  // 3) 被风暴弹起后（或坠地前）立刻恢复鞘翅
  await sleep(80)
  await recoverElytra()
  return true
}

async function runMace (name) {
  maceName = name
  maceRunning = true
  stopped = true
  stopPvp()
  clearTimeout(patrolTimer)
  patrolTimer = null
  await equipArmor()
  await equipElytra()
  bot.chat(`鞘翅重锤 目标 ${name}`)
  log(`mace start -> ${name}`)
  let cycles = 0
  try {
    while (maceName === name) {
      const target = bot.players[name]?.entity
      if (!target) {
        maceName = null
        bot.chat(`目标 ${name} 不在视野内，结束`)
        break
      }
      if (bot.health <= 6) {
        maceName = null
        bot.chat('血量过低，结束')
        break
      }
      const tp = target.position
      const up = await maceClimbTo(tp.x, tp.y + 28, tp.z)
      if (!up) {
        maceName = null
        bot.chat('无法到达攻击高度（烟花不足？），结束')
        break
      }
      await maceDiveAndStrike(name)
      cycles++
      log(`mace cycle ${cycles} complete`)
      if (bot.health < 14) await eatIfNeeded()
    }
  } catch (e) {
    log('mace error:', e.message)
  } finally {
    maceRunning = false
    if (bot.entity && !bot.entity.onGround) {
      await recoverElytra()
      await landSafely()
    }
    if (maceName !== null) maceName = null
    if (maceCancelled) {
      maceCancelled = false
      stopped = true
    } else {
      stopped = false
      schedulePatrol(2000)
    }
  }
}

// ---------- 跟随实体 / 收集资源 ----------
const ENTITY_ALIASES = {
  牛: 'cow', 猪: 'pig', 羊: 'sheep', 鸡: 'chicken', 僵尸: 'zombie', 骷髅: 'skeleton',
  苦力怕: 'creeper', 爬行者: 'creeper', 末影人: 'enderman', 村民: 'villager', 蜘蛛: 'spider',
  女巫: 'witch', 狼: 'wolf', 猫: 'cat', 兔子: 'rabbit', 马: 'horse', 船: 'boat', 矿车: 'minecart'
}

const BLOCK_ALIASES = {
  木头: 'oak_log', 原木: 'oak_log', 橡木: 'oak_log', 云杉: 'spruce_log', 白桦: 'birch_log',
  丛林木: 'jungle_log', 石头: 'stone', 圆石: 'cobblestone', 煤: 'coal_ore', 铁: 'iron_ore',
  金: 'gold_ore', 钻石: 'diamond_ore', 红石: 'redstone_ore', 青金石: 'lapis_ore',
  沙子: 'sand', 泥土: 'dirt', 草方块: 'grass_block', 小麦: 'wheat', 胡萝卜: 'carrots',
  土豆: 'potatoes', 甘蔗: 'sugar_cane', 南瓜: 'pumpkin', 西瓜: 'melon'
}

// 方块被破坏后掉落的物品名（和方块名不同的情况）
const DROP_ALIASES = {
  coal_ore: 'coal', iron_ore: 'raw_iron', gold_ore: 'raw_gold', diamond_ore: 'diamond',
  redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli', emerald_ore: 'emerald',
  copper_ore: 'raw_copper', carrots: 'carrot', potatoes: 'potato', wheat: 'wheat'
}

let followTarget = null // { kind: 'player', name } | { kind: 'entity', type }
let followRunning = false
let followCancelled = false

let collectJob = null // { type, total, done }
let collectRunning = false

function nearestEntityOfType (type) {
  const def = bot.registry.entitiesByName[type]
  if (!def || !bot.entity) return null
  return Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.name === def.name && e.position)
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0] || null
}

function resolveFollowTarget (args) {
  let arg = args[0]
  if (arg === '玩家' || arg === 'player') arg = args[1]
  if (!arg) throw new Error('用法 follow <玩家|实体>')
  if (bot.players[arg]?.entity) return { kind: 'player', name: arg }
  const type = ENTITY_ALIASES[arg] || arg.toLowerCase()
  if (bot.registry.entitiesByName[type]) return { kind: 'entity', type }
  if (bot.players[arg]) return { kind: 'player', name: arg }
  throw new Error(`找不到目标 ${arg}`)
}

function followLabel (spec) {
  return spec.kind === 'player' ? spec.name : (spec.type)
}

function stopFollow (reason) {
  const active = followRunning || followTarget
  followCancelled = true
  followTarget = null
  followRunning = false
  if (flying) flyAbort = true // 飞行途中取消：就地滑翔降落
  if (patrolTimer) clearTimeout(patrolTimer)
  patrolTimer = null
  try { bot.pathfinder.stop() } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  if (active && reason) { bot.chat(reason); log(reason) }
  return Boolean(active)
}

// 跟随时超过这个距离（或目标明显在上方/空中）且有鞘翅+烟花，就飞过去，否则走路
const FOLLOW_AIR_DIST = 24
let airCooldownUntil = 0

function countItem (name) {
  try { return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0) } catch { return 0 }
}

function hasElytra () {
  const torso = bot.inventory.slots[bot.getEquipmentDestSlot('torso')]
  return torso?.name === 'elytra' || Boolean(findItem('elytra'))
}

// 供 /state 观察跟随是否满足飞行条件
function followAirInfo () {
  if (!bot || !bot.entity || !followTarget) return null
  const target = followTarget.kind === 'player'
    ? bot.players[followTarget.name]?.entity
    : nearestEntityOfType(followTarget.type)
  if (!target) return { target: false }
  const p = bot.entity.position
  const tp = target.position
  return {
    target: true,
    horiz: Number(Math.hypot(tp.x - p.x, tp.z - p.z).toFixed(1)),
    dy: Number((tp.y - p.y).toFixed(1)),
    elytra: hasElytra(),
    rockets: countItem('firework_rocket'),
    cooldown: Math.max(0, Math.round((airCooldownUntil - Date.now()) / 1000))
  }
}

async function runFollow (spec) {
  if (followRunning) stopFollow()
  followTarget = spec
  followRunning = true
  followCancelled = false
  stopped = true
  if (patrolTimer) clearTimeout(patrolTimer)
  patrolTimer = null
  log(`follow -> ${followLabel(spec)}`)
  try {
    while (!followCancelled && followTarget && mode.kind === 'follow') {
      if (!bot.entity) { await sleep(1000); continue }
      const target = spec.kind === 'player'
        ? bot.players[spec.name]?.entity
        : nearestEntityOfType(spec.type)
      if (!target) { await sleep(1000); continue }

      const p = bot.entity.position
      const tp = target.position
      const horiz = Math.hypot(tp.x - p.x, tp.z - p.z)
      const canFly = hasElytra() && countItem('firework_rocket') >= 2
      // 只在水平距离远时起飞：目标就在头顶时起飞容易撞天花板/悬空方块
      if (!flying && canFly && horiz > FOLLOW_AIR_DIST && Date.now() > airCooldownUntil) {
        log(`follow: 距离 ${horiz.toFixed(0)}，用鞘翅追`)
        try {
          await flyTo(tp.x, tp.y, tp.z, 60000, { patrol: false, walk: false })
          airCooldownUntil = Date.now() + 3000
          await sleep(500) // 落地先站稳，再让跟随循环接管
        } catch (e) {
          log('follow: 飞行失败，改为步行:', e.message)
          airCooldownUntil = Date.now() + 60000
        }
        continue
      }

      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      await sleep(500)
    }
  } catch (e) {
    log('follow error:', e.message)
  } finally {
    followRunning = false
  }
}

function stopCollect (reason) {
  const active = collectRunning || collectJob
  collectJob = null
  collectRunning = false
  if (patrolTimer) clearTimeout(patrolTimer)
  patrolTimer = null
  try { bot.pathfinder.stop() } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  if (active && reason) { bot.chat(reason); log(reason) }
  return Boolean(active)
}

async function wanderOnce (timeout = 12000) {
  const p = bot.entity.position
  const a = Math.random() * Math.PI * 2
  const x = p.x + Math.cos(a) * 16
  const z = p.z + Math.sin(a) * 16
  // 先纯走路，走不通再允许挖（避免寻路自己到处乱挖）
  try { await gotoNoDig(x, p.y, z, Math.min(timeout, 8000)) } catch {
    try { await goto(x, p.y, z, timeout) } catch {}
  }
}

async function runCollect (type, total) {
  const def = bot.registry.blocksByName[type]
  if (!def) {
    reply(`未知资源 ${type}`)
    if (mode.kind === 'collect') saveMode('patrol')
    return
  }
  if (collectRunning) stopCollect()
  const itemName = DROP_ALIASES[type] || type
  const countItem = () => {
    try { return bot.inventory.items().filter(i => i.name === itemName).reduce((s, i) => s + i.count, 0) } catch { return 0 }
  }
  const base = countItem()
  collectJob = { type, total, done: 0, item: itemName }
  collectRunning = true
  stopped = true
  log(`collect ${type} x${total} (item=${itemName}, base=${base})`)
  try {
    while (collectJob && collectJob.done < total && mode.kind === 'collect') {
      if (!bot.entity) { await sleep(1000); continue }
      if (bot.entity.elytraFlying) { await sleep(300); continue }
      // 用背包增量统计（寻路自身挖的方块有时也会算进去）
      collectJob.done = Math.max(0, countItem() - base)
      if (collectJob.done >= total) break
      const positions = bot.findBlocks({ matching: def.id, maxDistance: 32, count: 8 })
      if (!positions.length) {
        reply(`附近没有 ${type}，移动寻找`)
        await wanderOnce()
        continue
      }
      // 不要挖脚下那块，否则会把自己埋进坑里
      const feet = bot.entity.position.floored()
      const candidates = positions.filter(pos =>
        !(pos.x === feet.x && pos.z === feet.z && pos.y === feet.y - 1))
      let mined = false
      for (const pos of (candidates.length ? candidates : positions)) {
        if (!collectJob || mode.kind !== 'collect') break
        const b = bot.blockAt(pos)
        if (!b || b.type !== def.id) continue
        try {
          if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 4) {
            await goto(pos.x, pos.y, pos.z, 15000, 2) // 站到方块附近，而不是站在方块里
          }
          const b2 = bot.blockAt(pos)
          if (b2 && b2.type === def.id && bot.canDigBlock(b2)) {
            try { await bot.dig(b2) } catch (e) { log('collect: 挖掘失败', e.message) }
            collectJob.done = Math.max(0, countItem() - base)
            reply(`已收集 ${type} ${collectJob.done}/${total}`)
            mined = true
            break
          }
        } catch (e) {
          log('collect: 前往方块失败', e.message)
        }
      }
      if (!mined) await wanderOnce()
    }
  } catch (e) {
    log('collect error:', e.message)
    reply(`收集失败: ${e.message}`)
  } finally {
    const done = collectJob ? collectJob.done : total
    collectRunning = false
    collectJob = null
    if (mode.kind === 'collect') {
      saveMode('patrol')
      reply(`收集完成 ${type} ${done}/${total}`)
    }
    stopped = false
    schedulePatrol(1500)
  }
}

// ---------- 自主发育：木头 → 石镐 → 铁镐 → 钻石套 ----------
const DEV = { running: false, cancelled: false, dir: null, steps: 0, tries: 0, axis: null, tgtKey: null, noMove: 0, mineFail: null, caveDir: null }
let lastRtpAt = 0 // /rtp 冷却，别刷指令
let homeSet = false // 工作区 home 是否已设
const LOG_BLOCKS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log']
const DEV_PLANKS = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks', 'pale_oak_planks']
const DEV_FOODS = ['cooked_beef', 'beef', 'cooked_porkchop', 'porkchop', 'cooked_mutton', 'mutton', 'cooked_chicken', 'chicken', 'bread', 'baked_potato']

const solid = b => Boolean(b && b.boundingBox === 'block')
const fluid = b => Boolean(b && (b.name.includes('water') || b.name.includes('lava')))
const countLogs = () => LOG_BLOCKS.reduce((s, n) => s + countItem(n), 0)
const countPlanks = () => DEV_PLANKS.reduce((s, n) => s + countItem(n), 0)
const devCheck = () => {
  if (!bot.entity) throw new Error('未进服')
  if (DEV.cancelled || mode.kind !== 'develop') throw new Error('发育已停止')
  if (DEV.dead) throw new Error('死亡重启')
}
// quiet：只发关键节点（默认）；log：每步一条；silent：不发
let devSayLast = ''
let devSayAt = 0
function devSay (m, milestone = false) {
  log('[dev]', m)
  if (outputMode === 'silent') return
  const now = Date.now()
  if (outputMode !== 'log') {
    const important = milestone || /卡住|中断|失败|完成|做好了/.test(m)
    if (!important) return
    if (m === devSayLast && now - devSayAt < 120000) return
    if (now - devSayAt < 30000) return
  }
  devSayLast = m
  devSayAt = now
  try { reply(m) } catch {}
}

function bestItemOf (kind) {
  for (const tier of ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden']) {
    const it = findItem(`${tier}_${kind}`)
    if (it) return it
  }
  return null
}
async function equipKind (kind) {
  const it = bestItemOf(kind)
  if (it && bot.heldItem?.name !== it.name) { try { await equipSafe(it, 'hand') } catch {} }
  return it
}

// 装备/切换物品可能因丢包永远不返回，加超时
async function equipSafe (item, dest = 'hand', timeout = 4000) {
  const ok = await Promise.race([
    bot.equip(item, dest).then(() => true).catch(() => false),
    sleep(timeout).then(() => false)
  ])
  if (!ok) throw new Error('equip timeout')
}

async function safeLookAt (pos) {
  await Promise.race([bot.lookAt(pos, false).catch(() => {}), sleep(2000)])
}

async function craftItem (name, times = 1, table = null) {
  const def = bot.registry.itemsByName[name]
  if (!def) throw new Error(`未知物品 ${name}`)
  // 工作台引用可能已经失效（被挖掉/被别的方块顶替），失效就当没有
  if (table) {
    const tb = bot.blockAt(table.position)
    if (!tb || tb.name !== 'crafting_table') table = null
  }
  let recipes = bot.recipesFor(def.id, null, 1, table)
  if (!recipes.length && name !== 'crafting_table') {
    // 只有必须工作台的配方才去重新找/放一个，别为 2x2 配方瞎折腾
    const needsTable = bot.recipesAll(def.id, null, false).length === 0
    if (needsTable) {
      table = await ensureTable()
      recipes = bot.recipesFor(def.id, null, 1, table)
    }
  }
  if (!recipes.length) throw new Error(`暂时做不了 ${name}`)
  if (table) {
    const d = bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5))
    if (d > 3) {
      // 允许挖穿：工作台可能在半砖/墙后，gotoNoDig 会直接放弃
      try { await goto(table.position.x, table.position.y, table.position.z, 15000, 2) } catch {}
      await sleep(150)
    }
    const now = bot.blockAt(table.position)
    if (!now || now.name !== 'crafting_table') throw new Error('工作台没了')
    const d2 = bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5))
    // 实在走不到也别中断整个发育：直接按工作台配方试一次，服务端拒绝再说
    if (d2 > 4.5) log(`[dev] 工作台有点远（${d2.toFixed(1)}），直接尝试合成`)
  }
  // 之前开过的容器窗口没关干净会导致 craft 写进废弃窗口（背包窗口除外）
  if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
    try { await bot.closeWindow(bot.currentWindow) } catch {}
    await sleep(200)
  }
  await bot.craft(recipes[0], times, table)
  await sleep(300)
  log(`[dev] craft ${name} x${times}`)
}

async function placeBlockItem (name) {
  const item = findItem(name)
  if (!item) { log('[dev] 背包里没有', name); return null }
  // 等 pathfinder 执行器彻底停下：它会在挖方块前自己 equip 镐子，
  // 和我们“拿工作台”的手持物冲突，服务端就会报 "Server refused to place stone_pickaxe"
  for (let i = 0; i < 60 && (bot.pathfinder?.isMining?.() || bot.targetDigBlock); i++) await sleep(50)
  if (bot.targetDigBlock) { try { bot.stopDigging() } catch {}; await sleep(150) }
  // equip 是异步的，必须确认手上真的切过去了再放，否则会把镐子当方块放（服务端报 stone_pickaxe）
  let held = null
  for (let i = 0; i < 3; i++) {
    try { await bot.equip(item, 'hand') } catch (e) { log('[dev] equip fail', name, e.message) }
    await sleep(150)
    held = bot.heldItem
    if (held && held.name === name) break
  }
  if (!held || held.name !== name) {
    log('[dev] 手上不是', name, '，而是', held?.name || '空')
    return null
  }
  for (let round = 0; round < 2; round++) {
    const p = bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const base = bot.blockAt(p.offset(dx, -1, dz))
      const a1 = bot.blockAt(p.offset(dx, 0, dz))
      const a2 = bot.blockAt(p.offset(dx, 1, dz))
      if (!solid(base)) continue
      if (a1 && a1.boundingBox !== 'empty') continue
      if (a2 && a2.boundingBox !== 'empty') continue
      // 放置前先看向要放的那个格子（对应面），别凭空放
      try { await safeLookAt(p.offset(dx, 0, dz).offset(0.5, 0.5, 0.5)) } catch {}
      await sleep(80)
      try {
        await bot.placeBlock(base, new Vec3(0, 1, 0))
        await sleep(300)
        const t = bot.blockAt(p.offset(dx, 0, dz))
        if (t && t.name === name) return t
        log('[dev] place 没生效', name, 'base=' + (base?.name || '?'), '→', t?.name || 'null')
      } catch (e) { log('[dev] place fail', name, 'base=' + (base?.name || '?'), e.message) }
    }
    // 出生点保护区会拒绝放置：走到保护区外再试一轮
    if (!(await leaveSpawnArea())) break
    await sleep(300)
  }
  return null
}

async function findTableNearby () {
  const id = bot.registry.blocksByName.crafting_table.id
  const pos = bot.findBlocks({ matching: id, maxDistance: 32, count: 1 })
  if (!pos.length) return null
  const b = bot.blockAt(pos[0])
  if (!b) return null
  if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 3) {
    // 用允许挖穿的 goto：工作台可能在地下/墙后，gotoNoDig 会直接 noPath
    try { await goto(b.position.x, b.position.y, b.position.z, 30000, 2) } catch {}
  }
  // 走不过去（在别人房子里/墙后）就当没有，别让上层一直“工作台够不到”
  if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 4.5) {
    log('[dev] 附近的工作台够不到，自己放一个新的', fmt(b.position))
    return null
  }
  return bot.blockAt(pos[0])
}

async function ensureTable () {
  const near = await findTableNearby()
  if (near) return near
  if (!findItem('crafting_table')) {
    while (countPlanks() < 4) await craftPlanks(4)
    await craftItem('crafting_table', 1)
  }
  let t = await placeBlockItem('crafting_table')
  // 出生点保护/地形不合适时，走远一点再放
  for (let i = 0; i < 4 && !t; i++) {
    log('[dev] 工作台放不下，离开出生点保护区再试')
    await leaveSpawnArea()
    await wanderOnce(5000)
    t = await placeBlockItem('crafting_table')
  }
  if (!t) throw new Error('放不下工作台')
  return t
}

// 出生点周围有方块放置保护，放不下东西就往远离原点方向走
const SPAWN = { x: 596, z: 601 } // 这个服 /spawn 的落点；出生点保护区中心（半径约 128）
const SPAWN_SAFE = 170 // 离出生点这么远才能放方块/设家
let homeSafe = false

function distSpawn (p = bot.entity.position) {
  return Math.hypot(p.x - SPAWN.x, p.z - SPAWN.z)
}

async function leaveSpawnArea () {
  const p = bot.entity.position
  if (distSpawn(p) >= SPAWN_SAFE) return false
  // 地下靠走会一直 noPath，直接 /rtp 传到远处，别再和保护区死磕
  if (Date.now() - lastRtpAt > 120000) {
    lastRtpAt = Date.now()
    log(`[dev] 出生点保护区内（${Math.round(distSpawn(p))} 格），/rtp 换地方`)
    try { bot.chat('/rtp') } catch {}
    await sleep(7000)
    if (distSpawn() >= SPAWN_SAFE) {
      homeSafe = true
      try { bot.chat('/sethome base') } catch {}
      return true
    }
  }
  const dx = p.x - SPAWN.x
  const dz = p.z - SPAWN.z
  const len = Math.hypot(dx, dz) || 1
  const tx = p.x + (dx / len) * (SPAWN_SAFE - distSpawn(p) + 24)
  const tz = p.z + (dz / len) * (SPAWN_SAFE - distSpawn(p) + 24)
  try { await goto(tx, p.y, tz, 60000) } catch (e) { log('[dev] 往外走失败', e.message) }
  if (distSpawn() > 190 && !homeSafe) {
    homeSafe = true
    try { bot.chat('/sethome base') } catch {}
  }
  return true
}

async function craftPlanks (n) {
  let guard = 0
  while (countPlanks() < n) {
    devCheck()
    if (++guard > 20) throw new Error('木板做不出来')
    const type = DEV_PLANKS.find(p => bot.recipesFor(bot.registry.itemsByName[p].id, null, 1, null).length)
    if (!type) throw new Error('没有原木可以做木板')
    const before = countPlanks()
    await craftItem(type, 1)
    if (countPlanks() <= before) await sleep(400) // 等服务器刷新背包
  }
}

// 所有挖掘串行化：并发的 bot.dig 会互相取消，报 “Digging aborted”
let digQueue = Promise.resolve()
function queuedDig (block) {
  const run = () => new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { bot.stopDigging() } catch {}
      reject(new Error('dig timeout'))
    }, 20000)
    bot.dig(block).then(
      v => { if (done) return; done = true; clearTimeout(timer); resolve(v) },
      e => { if (done) return; done = true; clearTimeout(timer); reject(e) }
    )
  })
  const next = digQueue.then(run, run)
  digQueue = next.catch(() => {})
  return next
}

// 根据方块 harvestTools 判断需要的工具（没有合适工具就别挖，挖了也不掉东西）
function toolInfoFor (block) {
  const ht = block.harvestTools
  if (!ht) return { allowed: null }
  const names = Object.keys(ht).map(Number).map(id => bot.registry.items[id]?.name).filter(Boolean)
  return { allowed: names }
}

async function ensureToolFor (block) {
  const { allowed } = toolInfoFor(block)
  if (!allowed) {
    const t = bestItemOf('shovel') || bestItemOf('pickaxe')
    if (t) { try { await equipSafe(t, 'hand') } catch {} }
    return true
  }
  if (allowed.includes(bot.heldItem?.name)) return true
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
  const inv = bot.inventory.items()
    .filter(i => allowed.includes(i.name))
    .sort((a, b) => order.findIndex(t => b.name.startsWith(t)) - order.findIndex(t => a.name.startsWith(t)))
  if (!inv.length) return false
  try { await equipSafe(inv[0], 'hand'); return true } catch { return false }
}

// 捡地上的掉落物（挖矿后掉落经常留在原地）
let lastPickup = 0
const invTotal = () => bot.inventory.items().reduce((s, i) => s + i.count, 0)
async function pickupDrops (radius = 4) {
  if (Date.now() - lastPickup < 2500) return
  const items = Object.values(bot.entities)
    .filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  if (!items.length) return
  lastPickup = Date.now()
  const before = invTotal()
  for (const it of items.slice(0, 6)) {
    // 掉落物可能掉在树下/叶子里，允许挖穿过去捡（gotoNoDig 会走不到）
    try { await goto(it.position.x, it.position.y, it.position.z, 6000, 1) } catch {}
    await sleep(120)
  }
  const got = invTotal() - before
  if (got > 0) log(`[dev] 拾取掉落物 ${got} 个`)
}

// 丢垃圾：背包快满时清掉不值的方块
const JUNK_ITEMS = new Set([
  'cobblestone', 'deepslate', 'cobbled_deepslate', 'tuff', 'dirt', 'gravel', 'stone',
  'andesite', 'diorite', 'granite', 'flint', 'calcite', 'pointed_dripstone',
  'dripstone_block', 'sand', 'red_sand', 'sandstone', 'raw_copper'
])
async function dropJunk (keepCobble = 32) {
  let dropped = 0
  for (const it of bot.inventory.items()) {
    if (!JUNK_ITEMS.has(it.name)) continue
    const keep = (it.name === 'cobblestone' || it.name === 'cobbled_deepslate') ? keepCobble : 0
    const n = it.count - keep
    if (n <= 0) continue
    try { await bot.toss(it.type, null, n); dropped += n } catch (e) { log('[dev] toss fail', it.name, e.message) }
  }
  if (dropped) log(`[dev] 丢弃垃圾 ${dropped} 个`)
  return dropped
}

function nearLava (b) {
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 2, 0], [0, 0, 1], [0, 0, -1], [0, -2, 0]]
  return faces.some(([dx, dy, dz]) => {
    const n = bot.blockAt(b.position.offset(dx, dy, dz))
    return n && (n.name === 'lava' || n.name === 'flowing_lava' || n.name === 'fire' || n.name === 'soul_fire')
  })
}

// 溺水自救：头泡在水里就直接上浮换气
let lastBreathAt = 0
async function breathe () {
  if (!bot.entity) return false
  if (Date.now() - lastBreathAt < 700) return false
  const headB = bot.blockAt(bot.entity.position.offset(0, 1.7, 0))
  // 只有头真的泡在水里（或氧气见底）才需要上浮；脚踩浅水不算，否则会一直跳
  const headInWater = headB && (headB.name === 'water' || headB.name === 'flowing_water' || headB.name === 'bubble_column')
  const lowOxygen = Number.isFinite(bot.oxygenLevel) && bot.oxygenLevel < 18
  if (!headInWater && !lowOxygen) return false
  lastBreathAt = Date.now()
  log('[dev] 在水里，上浮换气')
  for (let i = 0; i < 60; i++) {
    if (!bot.entity) break
    const head = bot.blockAt(bot.entity.position.offset(0, 1.7, 0))
    if (head && head.name !== 'water') break
    // 头上被方块堵住就挖开再上浮
    if (i > 0 && i % 6 === 0) {
      const up = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0))
      if (up && up.boundingBox === 'block' && up.name !== 'bedrock' && !fluid(up) && !nearLava(up)) {
        try { await queuedDig(up) } catch {}
      }
    }
    try { await safeLookAt(bot.entity.position.offset(0, 3, 0)) } catch {}
    bot.setControlState('jump', true)
    await sleep(220)
  }
  bot.setControlState('jump', false)
  await sleep(150)
  // 还是没浮出来（深水/被压在水下）：直接朝最近的岸边游
  const head2 = bot.blockAt(bot.entity.position.offset(0, 1.7, 0))
  if (head2 && (head2.name === 'water' || head2.name === 'flowing_water')) await escapeWater()
  return true
}

// 掉进水里：找最近的干地，游/走过去（之前在水坑里反复淹死）
async function escapeWater () {
  if (!bot?.entity) return false
  const head = bot.blockAt(bot.entity.position.offset(0, 1.7, 0))
  if (!head || (head.name !== 'water' && head.name !== 'flowing_water' && head.name !== 'bubble_column')) return false
  const ids = ['grass_block', 'dirt', 'sand', 'stone', 'gravel', 'cobblestone', 'coarse_dirt', 'podzol', 'andesite', 'diorite', 'granite', 'snow_block']
    .map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  if (!ids.length) return false
  const p = bot.entity.position
  const spots = bot.findBlocks({ matching: ids, maxDistance: 24, count: 48 })
  const wet = n => !n || n.name === 'water' || n.name === 'flowing_water' || n.name === 'bubble_column'
  const land = spots
    .filter(q => {
      const top = bot.blockAt(q)
      const a = bot.blockAt(q.offset(0, 1, 0))
      const b = bot.blockAt(q.offset(0, 2, 0))
      // 必须是干地：上方两格不是水（水下沙底 boundingBox 也是 empty，不能当岸边）
      return top && top.boundingBox === 'block' && !wet(top) &&
        a && a.boundingBox === 'empty' && !wet(a) &&
        (!b || (b.boundingBox === 'empty' && !wet(b)))
    })
    .sort((a, b) => a.distanceTo(p) - b.distanceTo(p))[0]
  if (!land) return false
  log('[dev] 在水里，往岸边游', fmt(land))
  try { await gotoNoDig(land.x, land.y + 1, land.z, 12000, 1) } catch {}
  const h1 = bot.blockAt(bot.entity.position.offset(0, 1.7, 0))
  if (!h1 || (h1.name !== 'water' && h1.name !== 'flowing_water')) return true
  // 寻路不游就手动游：抬头 + 一直跳 + 朝岸边前进
  try { await safeLookAt(land.offset(0.5, 1, 0.5)) } catch {}
  bot.setControlState('jump', true)
  bot.setControlState('forward', true)
  for (let i = 0; i < 120; i++) {
    await sleep(100)
    if (!bot.entity) break
    const h = bot.blockAt(bot.entity.position.offset(0, 1.7, 0))
    if (!h || (h.name !== 'water' && h.name !== 'flowing_water')) break
  }
  bot.setControlState('forward', false)
  bot.setControlState('jump', false)
  return true
}

// 视线检测：中间不能隔着实心方块
function canSeeBlock (b) {
  if (!bot.entity || !bot.world?.raycast) return true
  try {
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const center = b.position.offset(0.5, 0.5, 0.5)
    const d = center.minus(eye)
    const dist = d.norm()
    if (dist < 1.8) return true
    const hit = bot.world.raycast(eye, d.scaled(1 / dist), dist,
      bl => bl.position.equals(b.position) || (solid(bl) && !bl.transparent && !bl.name.includes('leaves')))
    return Boolean(hit) && hit.position.equals(b.position)
  } catch { return true }
}

// 走到能看见这个方块的位置
async function stepToSee (b) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
    const pos = b.position.offset(dx, dy, dz)
    const nb = bot.blockAt(pos)
    const nb2 = bot.blockAt(pos.offset(0, 1, 0))
    if (!nb || solid(nb) || fluid(nb)) continue
    if (!nb2 || solid(nb2) || fluid(nb2)) continue
    try { await goto(pos.x, pos.y, pos.z, 9000, 1) } catch {}
    if (canSeeBlock(b)) return true
  }
  return false
}

async function digBlock (b, reach = 4) {
  if (!solid(b) || b.name === 'bedrock' || fluid(b)) return false
  if (await breathe()) return false // 先换气，别在水下憋死
  if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > reach) {
    try { await gotoNoDig(b.position.x, b.position.y, b.position.z, 12000, 2) } catch { return false }
    await sleep(120)
  }
  const b2 = bot.blockAt(b.position)
  if (!solid(b2) || b2.name === 'bedrock' || fluid(b2)) return false
  // 和 pathfinder 的执行器串行化：并发 bot.dig 会互相取消（“Digging aborted”）
  for (let i = 0; i < 60 && (bot.pathfinder?.isMining?.() || bot.targetDigBlock); i++) await sleep(50)
  if (bot.targetDigBlock) { try { bot.stopDigging() } catch {}; await sleep(120) }
  // 岩浆/火旁边不挖，防止挖穿后岩浆灌进来（之前就是这么死的）
  if (nearLava(b2)) { log('[dev] 旁边是岩浆，跳过', b2.name); return false }
  if (!bot.canDigBlock(b2)) return false
  if (!(await ensureToolFor(b2))) return false // 缺工具就不碰，交给上层重做
  if (!canSeeBlock(b2)) return false // 隔墙不挖，等走近/挖穿前面那块再看
  try { await safeLookAt(b2.position.offset(0.5, 0.5, 0.5)) } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await queuedDig(b2)
      await sleep(150)
      await pickupDrops(4)
      if (bot.inventory.emptySlotCount() <= 3) await dropJunk(32)
      return true
    } catch (e) {
      if (attempt === 0 && /aborted/i.test(e.message)) { await sleep(250); continue } // 被打断就再来一次
      log('[dev] dig fail', b2.name, e.message)
      return false
    }
  }
  return false
}

// 从洞里往上走：随机找周围的“地表最高点”，让寻路自己找路上去
async function goUp () {
  devSay('去地表')
  const p = bot.entity.position
  const cols = [[p.x, p.z]]
  for (let i = 0; i < 12; i++) {
    const ang = Math.random() * Math.PI * 2
    const r = 8 + Math.random() * 14
    cols.push([Math.round(p.x + Math.cos(ang) * r), Math.round(p.z + Math.sin(ang) * r)])
  }
  for (const [tx, tz] of cols) {
    devCheck()
    if (bot.entity.position.y >= 55) return true
    let top = null
    for (let ty = 110; ty > -63; ty--) {
      const b = bot.blockAt(new Vec3(tx, ty, tz))
      if (b && b.boundingBox === 'block') { top = ty; break }
    }
    if (top === null || top < 55) continue
    try { await goto(tx, top + 1, tz, 40000, 2); if (bot.entity.position.y >= 55) return true } catch {}
  }
  log('[dev] 找不到上去的路')
  return false
}

async function gatherWood (need) {
  devSay(`去找木头 x${need}`)
  await equipKind('axe')
  const ids = LOG_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  // 别去砍泡在水里的树（红树），那会一直憋气淹死
  // 也别去砍离自己十几格高的/地的“残桩”（多半是上次砍剩的树干），A* 会一路挖穿 30 格石头
  const dryTrees = (radius, count) => bot.findBlocks({ matching: ids, maxDistance: radius, count }).filter(pos => {
    const b = bot.blockAt(pos)
    if (!b) return false
    if (Math.abs(pos.y - bot.entity.position.y) > 12) return false
    return ![[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      .some(([dx, dy, dz]) => {
        const n = bot.blockAt(b.position.offset(dx, dy, dz))
        return n && (n.name === 'water' || n.name === 'flowing_water' || n.name === 'bubble_column')
      })
  })
  const base = countLogs()
  let guard = 0
  // 之前挖矿会把 bot 留在地下隧道里，树在地表：先回地表再砍
  if (bot.entity.position.y < 55) {
    devSay('先回地表再找木头')
    if (Date.now() - lastRtpAt > 60000) {
      lastRtpAt = Date.now()
      try { bot.chat('/rtp') } catch {} // 直接传送到地表，别在矿洞里和寻路死磕
      await sleep(7000)
    }
    if (bot.entity.position.y < 55 && homeSet) {
      try { bot.chat('/home base') } catch {}
      await sleep(5000)
    }
    if (bot.entity.position.y < 55) await goUp()
  }
  while (countLogs() - base < need) {
    devCheck()
    if (await handleThreats()) continue
    if (++guard > 16) throw new Error('附近找不到树')
    const positions = dryTrees(96, 10)
    if (!positions.length) {
      // 附近没有能安全砍的树：换一片野外，别在原地打转
      if (Date.now() - lastRtpAt > 180000 && !dryTrees(160, 1).length) {
        lastRtpAt = Date.now()
        devSay('附近没林子，随机传送找资源')
        try { bot.chat('/rtp') } catch {}
        await sleep(6000)
        continue
      }
      if (guard % 5 === 0) await goUp()
      await wanderOnce(10000)
      continue
    }
    let got = false
    log(`[dev] 砍树：候选 ${positions.length}，最近 ${fmt(positions[0])}`)
    for (const pos of positions.slice(0, 3)) {
      const b = bot.blockAt(pos)
      if (b && await reachAndDig(b.position, 12000)) { got = true; await pickupDrops(6); log(`[dev] 砍到 ${b.name}`); break }
    }
    if (!got) await wanderOnce(8000)
  }
}

// 方块本身/紧邻有水就别挖（在池塘底挖石头会一直溺水，A* 也会因为 water cost 绕晕）
function nearWaterBlock (pos) {
  const wet = n => n && (n.name === 'water' || n.name === 'flowing_water' || n.name === 'bubble_column')
  if (wet(bot.blockAt(pos))) return true
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    if (wet(bot.blockAt(pos.offset(dx, dy, dz)))) return true
  }
  return false
}

async function mineBlocks (names, need, itemName = null) {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  const base = itemName ? countItem(itemName) : 0
  let mined = 0
  let guard = 0
  while ((itemName ? countItem(itemName) - base : mined) < need) {
    devCheck()
    if (++guard > 12) throw new Error(`挖 ${names[0]} 失败`)
    const positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 12 })
    if (!positions.length) { await wanderOnce(8000); continue }
    let ok = false
    for (const pos of positions) {
      const b = bot.blockAt(pos)
      if (!b) continue
      // 不挖自己脚下
      const p = bot.entity.position.floored()
      if (pos.x === p.x && pos.z === p.z && pos.y <= p.y) continue
      if (nearWaterBlock(pos)) continue
      const before = countItem(itemName)
      await digToward(pos) // 朝目标挖过去，方向锁定，不乱挖
      await sleep(250)
      await pickupDrops(6)
      if (countItem(itemName) > before) { mined++; ok = true; break }
    }
    if (!ok) await wanderOnce(6000)
  }
}

async function mineOres (blockNames, itemName, need) {
  const ids = blockNames.map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  let guard = 0
  while (countItem(itemName) < need) {
    devCheck()
    if (++guard > 120) throw new Error(`找不到 ${itemName}`)
    const positions = bot.findBlocks({ matching: ids, maxDistance: 48, count: 16 })
    if (!positions.length) { await wanderOnce(10000); continue }
    let ok = false
    for (const pos of positions) {
      const b = bot.blockAt(pos)
      if (!b) continue
      if (nearWaterBlock(pos)) continue
      const before = countItem(itemName)
      await digToward(pos)
      await sleep(250)
      await pickupDrops(6)
      if (countItem(itemName) > before) { ok = true; break }
    }
    if (!ok) await wanderOnce(8000)
  }
}

async function ensurePickaxe () {
  let have = bestItemOf('pickaxe')
  if (!have) {
    if (countLogs() < 4) await gatherWood(4)
    await craftPlanks(11)
    await craftItem('stick', 2)
    const table = await ensureTable()
    await craftItem('wooden_pickaxe', 1, table)
    have = bestItemOf('pickaxe')
    if (!have) throw new Error('木镐没做出来')
    await equipKind('pickaxe')
    // 这里基本是有树有资源的正常区域，记成工作区，死后 /home 回来
    // 必须离出生点保护区够远，否则家里也放不下熔炉/工作台
    if (!homeSafe && distSpawn() > 190 && bot.entity.position.y > 50 && !stuckAtSpawn()) {
      homeSet = true
      homeSafe = true
      try { bot.chat('/sethome base') } catch {}
      log('[dev] 设置工作区 home（离出生点足够远）')
    }
    devSay('木镐好了，挖石头做石镐')
  }
  if (have.name.startsWith('wooden')) {
    const table = await ensureTable()
    if (countItem('cobblestone') < 3) await mineBlocks(['stone', 'cobblestone'], 3, 'cobblestone')
    if (!bestItemOf('pickaxe')) throw new Error('镐子挖坏了，重新做')
    await craftItem('stone_pickaxe', 1, table)
    await equipKind('pickaxe')
    devSay('石镐好了')
  }
  return bestItemOf('pickaxe')
}

// 至少保证有一把剑：没有就做石剑（2 圆石 + 1 木棍）
async function ensureSword () {
  if (bestWeapon()) return bestWeapon()
  if (countItem('cobblestone') < 2) {
    try { await mineBlocks(['stone', 'cobblestone', 'deepslate'], 2, 'cobblestone') } catch {}
  }
  if (countItem('stick') < 1) {
    try { await craftPlanks(1); await craftItem('stick', 1, await ensureTable()) } catch {}
  }
  if (countItem('cobblestone') >= 2) {
    try { await craftItem('stone_sword', 1, await ensureTable()) } catch (e) { log('[dev] 做剑失败:', e.message) }
  }
  const w = bestWeapon()
  if (w) { await equipKind('sword'); log('[dev] 武器就绪', w.name) }
  return w
}

async function findFurnaceNearby () {
  const id = bot.registry.blocksByName.furnace.id
  const pos = bot.findBlocks({ matching: id, maxDistance: 16, count: 1 })
  if (!pos.length) return null
  const b = bot.blockAt(pos[0])
  if (!b) return null
  if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 3) {
    try { await gotoNoDig(b.position.x, b.position.y, b.position.z, 12000, 2) } catch {}
  }
  return bot.blockAt(pos[0])
}

// 打开熔炉先看输出/输入/燃料，烧好的直接拿
async function inspectFurnaces () {
  const ids = ['furnace', 'blast_furnace', 'smoker']
    .map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  const positions = bot.findBlocks({ matching: ids, maxDistance: 24, count: 6 })
  let grabbed = 0
  for (const pos of positions) {
    devCheck()
    const b = bot.blockAt(pos)
    if (!b) continue
    if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 3.5) {
      try { await gotoNoDig(b.position.x, b.position.y, b.position.z, 10000, 2) } catch { continue }
    }
    let f
    try { f = await bot.openFurnace(b) } catch { continue }
    try {
      const out = f.slots[2]
      const inp = f.slots[0]
      const fuel = f.slots[1]
      log(`[dev] 熔炉 ${fmt(b.position)}: 烧好=${out ? `${out.name}x${out.count}` : '无'} 原料=${inp ? `${inp.name}x${inp.count}` : '无'} 燃料=${fuel ? `${fuel.name}x${fuel.count}` : '无'}`)
      if (out) { grabbed += out.count; await f.takeOutput() }
    } finally {
      try { await f.close() } catch {}
    }
  }
  if (grabbed) log(`[dev] 从熔炉取出 ${grabbed} 个成品`)
  return grabbed
}

async function smelt (inputName, count) {
  if (!findItem('furnace')) {
    if (!bestItemOf('pickaxe') && countItem('cobblestone') < 8) throw new Error('得先有镐子才能凑圆石做熔炉')
    for (let i = 0; i < 3 && countItem('cobblestone') < 8; i++) {
      try { await mineBlocks(['stone', 'cobblestone', 'deepslate'], 8, 'cobblestone') } catch (e) { log('[dev] 挖石头失败:', e.message) }
      if (countItem('cobblestone') < 8) await wanderOnce(8000)
    }
    if (countItem('cobblestone') < 8) throw new Error(`没凑够圆石（${countItem('cobblestone')}/8）`)
    await craftItem('furnace', 1, await ensureTable())
  }
  let fBlock = await findFurnaceNearby()
  for (let i = 0; i < 3 && !fBlock; i++) {
    fBlock = await placeBlockItem('furnace')
    if (!fBlock) { await leaveSpawnArea(); await wanderOnce(6000) }
  }
  if (!fBlock) throw new Error('放不下熔炉')
  const input = bot.registry.itemsByName[inputName]
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const furnace = await bot.openFurnace(fBlock)
    try {
      if (furnace.slots[2]) await furnace.takeOutput()
      const existing = furnace.slots[0] && furnace.slots[0].name === inputName ? furnace.slots[0].count : 0
      const put = Math.max(0, count - existing)
      if (put > 0) { await furnace.putInput(input.id, null, put); await sleep(200) }
      if (!furnace.slots[1]) {
        const coal = findItem('coal') || findItem('charcoal')
        let fuelId, fuelN
        if (coal) { fuelId = coal.type; fuelN = coal.count } else {
          const needFuel = Math.ceil((existing + put) / 1.5) + 1
          if (countPlanks() < needFuel) await craftPlanks(needFuel)
          const plank = DEV_PLANKS.find(n => countItem(n) > 0)
          if (!plank) throw new Error('没有燃料')
          fuelId = bot.registry.itemsByName[plank].id
          fuelN = Math.min(countItem(plank), needFuel)
        }
        await furnace.putFuel(fuelId, null, fuelN)
      }
      for (let i = 0; i < 120; i++) {
        devCheck()
        touchDevStall() // 烧东西时站着不动，别被当成卡死
        await sleep(1000)
        const out = furnace.outputItem && furnace.outputItem()
        if (out && out.count >= count) break
      }
      const out = furnace.slots[2]
      if (out) { log(`[dev] 烧好 ${out.name}x${out.count}`); await furnace.takeOutput() } else log('[dev] 熔炉没有产出')
      return
    } catch (e) {
      lastErr = e
      await sleep(300)
    } finally {
      try { await furnace.close() } catch {}
    }
  }
  throw lastErr
}

async function ensureIronPickaxe () {
  if (findItem('iron_pickaxe') || findItem('diamond_pickaxe') || findItem('netherite_pickaxe')) return
  const pk = bestItemOf('pickaxe')
  if (!pk || pk.name.startsWith('wooden')) await ensurePickaxe()
  // 先看看附近熔炉里有没有烧好的铁锭/正在烧的原料
  const near = await findFurnaceNearby()
  if (near) {
    try {
      const f = await bot.openFurnace(near)
      const out = f.slots[2]
      const inp = f.slots[0]
      log(`[dev] 熔炉现存: 烧好=${out ? out.name + 'x' + out.count : '无'} 原料=${inp ? inp.name + 'x' + inp.count : '无'}`)
      if (out) await f.takeOutput()
      await f.close()
    } catch {}
  }
  let ingots = countItem('iron_ingot')
  if (ingots < 3) {
    const need = 3 - ingots
    const raw = countItem('raw_iron')
    if (raw < need) {
      devSay(`找铁矿石（还差 ${need - raw} 块）`)
      await mineOres(['iron_ore', 'deepslate_iron_ore'], 'raw_iron', need)
    }
    devSay('熔炼铁锭')
    await smelt('raw_iron', 3)
    ingots = countItem('iron_ingot')
  }
  if (ingots < 3) throw new Error(`铁锭只有 ${ingots} 个`)
  await craftItem('iron_pickaxe', 1, await ensureTable())
  await equipKind('pickaxe')
  devSay('铁镐好了')
}

async function shiftShaft () {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5)
  for (const [dx, dz] of dirs) {
    const p = bot.entity.position.floored()
    const a = bot.blockAt(p.offset(dx, 0, dz))
    const h = bot.blockAt(p.offset(dx, 1, dz))
    if (fluid(a) || fluid(h)) continue
    if (solid(a)) await digBlock(a)
    if (solid(h)) await digBlock(h)
    try { await goto(p.x + dx + 0.5, p.y, p.z + dz + 0.5, 8000, 1) } catch {}
    return
  }
  await wanderOnce(6000)
}

async function takeTable () {
  // 下矿前把工作台收进背包，避免深处没有木板再造一个
  try {
    const t = await findTableNearby()
    if (t) await digBlock(t, 6)
  } catch {}
}

async function goDownTo (targetY) {
  devSay(`垂直下挖到 y=${targetY}`)
  let guard = 0
  while (bot.entity.position.y > targetY + 1) {
    devCheck()
    if (++guard > 260) throw new Error('下挖超时')
    const p = bot.entity.position.floored()
    let blocked = false
    for (let d = 1; d <= 6; d++) {
      const b = bot.blockAt(p.offset(0, -d, 0))
      if (!b || fluid(b)) { blocked = true; break }
    }
    if (blocked) { await shiftShaft(); continue }
    const below = bot.blockAt(p.offset(0, -1, 0))
    if (!below) { await sleep(300); continue }
    const y0 = bot.entity.position.y
    if (!(await digBlock(below))) { await shiftShaft(); continue }
    for (let i = 0; i < 40 && bot.entity.position.y > y0 - 0.9; i++) await sleep(50)
  }
}

async function stepForward (sx, sz) {
  const p = bot.entity.position
  await bot.look(Math.atan2(-sx, -sz), 0, true)
  bot.setControlState('forward', true)
  await sleep(420)
  bot.setControlState('forward', false)
  for (let i = 0; i < 16; i++) {
    if (bot.entity.position.distanceTo(p) > 0.5) return true
    await sleep(50)
  }
  // 没走动：先把卡住自己的方块挖开，再挖前方
  await freeSelf(2)
  const f = bot.entity.position.floored()
  for (const [dx, dy, dz] of [[sx, 0, sz], [sx, 1, sz]]) {
    const b = bot.blockAt(f.offset(dx, dy, dz))
    if (solid(b) && !fluid(b)) await digBlock(b, 5)
  }
  return false
}

// 防止 AABB 卡进方块：脚/头所在格有实体方块就挖开
async function freeSelf (tries = 6) {
  for (let i = 0; i < tries; i++) {
    if (!bot.entity) return false
    const p = bot.entity.position.floored()
    const inLava = [p, p.offset(0, 1, 0)].map(b => bot.blockAt(b))
      .some(b => b && (b.name === 'lava' || b.name === 'flowing_lava'))
    if (inLava) {
      log('[dev] 掉进岩浆，往岸上跑')
      bot.setControlState('jump', true)
      bot.setControlState('forward', true)
      await sleep(500)
      bot.setControlState('jump', false)
      bot.setControlState('forward', false)
      await sleep(300)
      continue
    }
    const stuck = [p, p.offset(0, 1, 0)].map(b => bot.blockAt(b)).filter(b => solid(b))
    if (!stuck.length) return true
    for (const b of stuck) await digBlock(b, 5)
    await sleep(180)
  }
  return false
}

// 走到“能看见这个方块”的站位再挖（Baritone 的 reachable rotation 思路）
// 砍树/挖石头用这个：不会隔墙挖，也不会站在原地看着砍不着干等
async function reachAndDig (pos, timeout = 30000) {
  let b = bot.blockAt(pos)
  if (!b || b.boundingBox !== 'block') return true
  if (canSeeBlock(b) && bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= 4.2) {
    return digBlock(b)
  }
  try {
    await gotoGoal(new goals.GoalLookAtBlock(pos, bot.world, { reach: 4.5 }), timeout)
  } catch (e) {
    log('[dev] 走不到可挖位置', e.message, fmt(pos))
    return false
  }
  b = bot.blockAt(pos)
  if (!b || b.boundingBox !== 'block') return true
  return digBlock(b)
}

// 到达一个方块旁边并挖掉它。
// 移植 Baritone MineProcess + PathExecutor 的流程：
//   1) 已经看得见且在 4.2 格内 -> 直接挖（相当于 reachable rotation + 左键）
//   2) 否则用 GoalThreeBlocks/GoalTwoBlocks 让 A* 算一条带“挖穿代价”的路线，
//      整条隧道由 A* 决定，不会像贪心算法那样东挖一下西挖一下
//   3) 到位后再对准目标方块挖
async function digToward (target) {
  const key = `${target.x},${target.y},${target.z}`
  if (DEV.tgtKey !== key) { DEV.tgtKey = key; DEV.axis = null; DEV.noMove = 0 }
  DEV.mineFail = null
  devCheck()
  let b = bot.blockAt(target)
  if (!b || b.boundingBox !== 'block') return true
  if (await breathe()) return false
  if (await handleThreats()) { DEV.mineFail = 'threat'; return false }
  await freeSelf(1)

  if (canSeeBlock(b) &&
      bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= 4.2) {
    const ok = await digBlock(b, 5)
    const b2 = bot.blockAt(target)
    return ok || !b2 || b2.boundingBox !== 'block'
  }

  if (!bestItemOf('pickaxe')) {
    try { await ensurePickaxe() } catch { DEV.mineFail = 'tool'; return false }
  }
  const goal = baritone.makeMineGoal(bot, target)
  try {
    await gotoGoal(goal, 90000)
  } catch (e) {
    log('[dev] 挖矿寻路失败', e.message, fmt(target))
    DEV.mineFail = 'path'
    return false
  }
  b = bot.blockAt(target)
  if (!b || b.boundingBox !== 'block') return true // A* 路上已经把它挖穿了
  if (await handleThreats()) { DEV.mineFail = 'threat'; return false }
  const ok = await digBlock(b, 5)
  const b3 = bot.blockAt(target)
  return ok || !b3 || b3.boundingBox !== 'block'
}

// 翻译自 MovementDownward：只在“下一格有落脚点”时往下挖，避免直接掉进深坑/岩浆
async function shaftDown (steps = 6) {
  let moved = 0
  for (let i = 0; i < steps; i++) {
    devCheck()
    if (await handleThreats()) break
    const p = bot.entity.position.floored()
    const below = bot.blockAt(p.offset(0, -1, 0))
    const below2 = bot.blockAt(p.offset(0, -2, 0))
    if (!below || below.name === 'bedrock') break
    if (fluid(below) || nearLava(below)) break
    if (!below2 || !solid(below2) || fluid(below2) || nearLava(below2)) break
    const y0 = bot.entity.position.y
    if (!(await digBlock(below, 5))) break
    for (let k = 0; k < 30 && bot.entity.position.y > y0 - 0.9; k++) await sleep(60)
    moved++
  }
  if (moved) log(`[dev] 竖井下挖 ${moved} 格 → y=${Math.round(bot.entity.position.y)}`)
  else {
    // 脚下不能挖（岩浆/深坑）：横移一格换位置，方向固定
    const p = bot.entity.position.floored()
    const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dz]) => {
      const a = bot.blockAt(p.offset(dx, 0, dz))
      return a && !solid(a) && !fluid(a)
    })
    if (dir) await stepForward(dir[0], dir[1])
  }
  return moved > 0
}

// 找不到矿时：先往下开竖井，再沿锁定方向开直巷道（Baritone 的 explore / excavate 思路）
async function baritoneExplore () {
  const p = bot.entity.position.floored()
  if (p.y > -50 && await shaftDown(8)) return
  if (!DEV.caveDir) DEV.caveDir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)]
  let [dx, dz] = DEV.caveDir
  try {
    await goto(p.x + dx * 16, p.y, p.z + dz * 16, 45000)
  } catch {
    // 方向被堵死才换方向（左转），不来回横跳
    DEV.caveDir = [-dz, dx]
    ;[dx, dz] = DEV.caveDir
    try { await goto(p.x + dx * 16, p.y, p.z + dz * 16, 30000) } catch {}
  }
}

async function tunnelStep () {
  if (!DEV.dir) DEV.dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)]
  let [sx, sz] = DEV.dir
  DEV.steps++
  if (DEV.steps % 48 === 0) {
    // 定期拐弯，形成网格状巷道
    DEV.dir = Math.random() < 0.5 ? [sz, -sx] : [-sz, sx]
    ;[sx, sz] = DEV.dir
  }
  const p = bot.entity.position.floored()
  for (const oy of [0, 1]) {
    const cell = bot.blockAt(p.offset(sx, oy, sz))
    if (fluid(cell)) { DEV.dir = [-sx, -sz]; return }
    if (solid(cell)) await digBlock(cell, 5)
  }
  await stepForward(sx, sz)
}

// 反矿透判定：null=未判定 | true=有（只能挖洞穴暴露面）| false=无（直接穿透挖）
let antiXray = null
// 反矿透结论持久化，避免每次重启都重新探一遍（探测本身要乱挖几处）
const XRAY_FILE = STATE_FILE + '.xray'
try { const j = JSON.parse(fs.readFileSync(XRAY_FILE, 'utf8')); if (typeof j.antiXray === 'boolean') antiXray = j.antiXray } catch {}
function setAntiXray (v) {
  antiXray = v
  try { fs.writeFileSync(XRAY_FILE, JSON.stringify({ antiXray: v })) } catch {}
}

function isExposed (b) {
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  return faces.some(([dx, dy, dz]) => {
    const n = bot.blockAt(b.position.offset(dx, dy, dz))
    return n && n.boundingBox === 'empty'
  })
}

// 用多种矿石做掉落测试：挖开墙内矿块，有掉落=真矿，连续无掉落=假矿（反矿透）
const PROBE_ORES = [
  ['diamond_ore', 'diamond'], ['deepslate_diamond_ore', 'diamond'],
  ['gold_ore', 'raw_gold'], ['deepslate_gold_ore', 'raw_gold'],
  ['iron_ore', 'raw_iron'], ['deepslate_iron_ore', 'raw_iron'],
  ['redstone_ore', 'redstone'], ['deepslate_redstone_ore', 'redstone'],
  ['lapis_ore', 'lapis_lazuli'], ['deepslate_lapis_ore', 'lapis_lazuli'],
  ['coal_ore', 'coal'], ['deepslate_coal_ore', 'coal'],
  ['copper_ore', 'raw_copper'], ['deepslate_copper_ore', 'raw_copper'],
  ['emerald_ore', 'emerald'], ['deepslate_emerald_ore', 'emerald']
]

async function probeAntiXray () {
  let tested = 0
  for (const [blockName, itemName] of PROBE_ORES) {
    const def = bot.registry.blocksByName[blockName]
    if (!def) continue
    const positions = bot.findBlocks({ matching: def.id, maxDistance: 10, count: 3 })
    for (const p of positions) {
      devCheck()
      const b = bot.blockAt(p)
      if (!b || isExposed(b)) continue
      const before = countItem(itemName)
      await digToward(p)
      await sleep(1000)
      const now = bot.blockAt(p)
      const dug = !now || now.boundingBox === 'empty' || now.name !== blockName
      if (!dug) continue
      tested++
      if (countItem(itemName) > before) {
        setAntiXray(false)
        log(`[dev] 反矿透检测：${blockName} 有掉落，第 ${tested} 次采样 → 无假矿`)
        return
      }
      log(`[dev] 反矿透检测：${blockName} 无掉落（${tested}/3）`)
      if (tested >= 3) { setAntiXray(true); log('[dev] 连续无掉落 → 判定有反矿透，只挖暴露面'); return }
    }
  }
  // 一个样本都拿不到：大概率是混淆型反矿透（真矿根本不下发），按有反矿透处理
  setAntiXray(true)
  log(`[dev] 反矿透检测：无可用样本（tested=${tested}）→ 按有反矿透处理`)
}

async function exploreCave () {
  // 沿一个方向走一段，走不通才换方向；不挖墙（反矿透只走洞穴）
  if (!DEV.caveDir) DEV.caveDir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)]
  const [dx, dz] = DEV.caveDir
  const p = bot.entity.position
  const dist = 16 + Math.random() * 10
  try {
    await gotoNoDig(p.x + dx * dist, p.y, p.z + dz * dist, 20000, 2)
  } catch {
    DEV.caveDir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)]
    await wanderOnce(6000)
  }
}

// 翻译自 MineProcess.onTick 的 shaft 分支：
//   同列、脚以上（含脚下）的已知矿，站着抬头就能挖，不用寻路
async function mineShaftOre (defs) {
  const p = bot.entity.position.floored()
  const ids = new Set()
  for (const d of defs) {
    const lo = d.minStateId ?? d.defaultState
    const hi = d.maxStateId ?? d.defaultState
    for (let s = lo; s <= hi; s++) ids.add(s)
  }
  for (let dy = 3; dy >= 0; dy--) {
    const b = bot.blockAt(new Vec3(p.x, p.y + dy, p.z), false)
    if (!b || !ids.has(b.stateId)) continue
    if (!canSeeBlock(b)) continue
    const ok = await digBlock(b, 5)
    if (ok) { await pickupDrops(6); return true }
  }
  return false
}

async function branchMine (need) {
  devSay(`找钻石，需要 ${need} 颗`)
  const defs = ['diamond_ore', 'deepslate_diamond_ore']
    .map(n => bot.registry.blocksByName[n]).filter(Boolean)
  if (antiXray === null) {
    await Promise.race([probeAntiXray(), sleep(90000)])
    if (antiXray === null) { setAntiXray(true); log('[dev] 反矿透检测超时 → 按有反矿透处理') }
  }
  if (antiXray === true) devSay('检测到反矿透：只挖洞穴暴露面', true)
  else devSay('未检测到假矿：按矿透直接穿透挖', true)

  // 移植 MineProcess：knownOreLocations + blacklist + 定时 rescan
  let targets = []
  const blacklist = new Map() // 到不了的矿点
  let lastScan = 0
  let lastReport = Date.now()
  let lastGot = countItem('diamond')
  let lastProgress = Date.now()
  let lastPos = bot.entity.position.clone()
  let lastMoveAt = Date.now()

  while (countItem('diamond') < need) {
    devCheck()
    if (!bestItemOf('pickaxe')) { devSay('镐子用坏了，重做一把'); await ensurePickaxe() }
    if (await handleThreats()) { await sleep(400); continue }

    const pnow = bot.entity.position
    const got = countItem('diamond')
    if (got > lastGot) { lastGot = got; lastProgress = Date.now() }
    if (pnow.distanceTo(lastPos) > 0.4) { lastPos = pnow.clone(); lastMoveAt = Date.now() }
    // 只按真实时间/真实进度判定失败，绝不用循环次数（之前就是循环空转直接抛“钻石没挖够”）
    if (Date.now() - lastProgress > 300000) throw new Error('钻石没挖够')
    if (Date.now() - lastMoveAt > 150000) {
      log('[dev] 挖矿 150 秒没有任何位移，重新找路')
      lastMoveAt = Date.now()
      try { bot.pathfinder.stop() } catch {}
      await shaftDown(4)
    }

    // MineProcess 的同列矿捷径：已经在矿柱子里的矿，直接挖，别绕路
    if (bot.entity.onGround && await mineShaftOre(defs)) { lastProgress = Date.now(); continue }

    // rescan：读已加载区块里所有钻石矿（含脚下整列），不做固定 y 层
    if (Date.now() - lastScan > 6000 || !targets.length) {
      targets = baritone.scanOres(bot, defs, {
        radius: 40,
        yMin: -64,
        yMax: Math.min(20, pnow.y + 8),
        antiXray: antiXray === true,
        blacklist,
        max: 64
      })
      lastScan = Date.now()
      log(`[dev] 扫描到 ${targets.length} 处钻石（y=${Math.round(pnow.y)}，反矿透=${antiXray}）`)
    }

    if (!targets.length) {
      // 附近没有已知矿：Baritone 的做法是继续探索（这里=竖井下挖/锁定方向直巷道）
      if (antiXray === true) await exploreCave()
      else await baritoneExplore()
      continue
    }

    // MineProcess.updateGoal：所有候选矿 -> 复合 goal，交给 A* 自己挑代价最小的那颗。
    // 不再自己判断“太深就先竖井”，A* 的 MovementDownward 会挖着下去。
    const composite = baritone.makeMineGoalComposite(bot, targets)
    log(`[dev] A* 选矿：候选 ${targets.length} 个，最近 ${baritone.posKey(targets[0])}`)
    try {
      await gotoGoal(composite, 180000)
    } catch (e) {
      // Baritone calcFailed：拉黑“最近的已知矿”，然后继续找下一颗
      log('[dev] 去矿点失败:', e.message, '→ 拉黑', baritone.posKey(targets[0]))
      baritone.blacklistPos(blacklist, targets[0], 180000)
      targets = targets.filter(t => !t.equals(targets[0]))
      continue
    }

    // 到达后：找出到底走到了哪颗矿的站位（GoalCompositeAny 的任一子目标命中）
    const feet = bot.entity.position.floored()
    let mine = null
    for (const g of composite.goals) {
      if (g.isEnd(feet)) {
        const cand = new Vec3(g.x, g.y, g.z)
        const blk = bot.blockAt(cand)
        if (blk && blk.name.includes('diamond')) mine = mine || cand
        else if (!mine) mine = cand
      }
    }
    if (!mine) {
      // 站位到了但没找到对应矿：下一轮重扫（可能是路径上顺手挖掉了）
      await pickupDrops(6)
      continue
    }
    await digToward(mine)
    await pickupDrops(8)
    const st = bot.blockAt(mine)
    const gone = !st || st.boundingBox !== 'block' || !st.name.includes('diamond')
    if (!gone && DEV.mineFail === 'path') baritone.blacklistPos(blacklist, mine, 180000)
    targets = targets.filter(t => !t.equals(mine))

    if (Date.now() - lastReport > 30000) {
      lastReport = Date.now()
      const got2 = countItem('diamond')
      devSay(`挖矿中：钻石 ${got2}/${need}，y=${Math.round(bot.entity.position.y)}`, got2 > 0 && got2 % 8 === 0)
    }
    if (bot.food < 8) await eatDevFood()
  }
}

async function eatDevFood () {
  const f = bot.inventory.items().find(i => DEV_FOODS.includes(i.name))
  if (!f) return false
  try {
    await bot.equip(f, 'hand')
    bot.activateItem()
    await sleep(1700)
    bot.deactivateItem()
    return true
  } catch { return false }
}

async function huntOnce () {
  const names = ['cow', 'pig', 'sheep', 'chicken', 'rabbit']
  const animals = Object.values(bot.entities)
    .filter(e => e.name && names.includes(e.name) && e.position.distanceTo(bot.entity.position) < 48)
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  if (!animals.length) { await wanderOnce(10000); return false }
  await equipWeapon()
  const target = animals[0]
  try { await goto(target.position.x, target.position.y, target.position.z, 20000, 2) } catch {}
  for (let i = 0; i < 80; i++) {
    if (!target || !target.isValid) break
    devCheck()
    const d = bot.entity.position.distanceTo(target.position)
    if (d > 3.5) {
      try { await goto(target.position.x, target.position.y, target.position.z, 8000, 2) } catch {}
    }
    try { await bot.lookAt(target.position.offset(0, 1, 0), true) } catch {}
    try { await bot.attack(target) } catch {}
    await sleep(600)
  }
  await sleep(800)
  return true
}

const RAW_MEATS = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit']
const cookedCount = () => DEV_FOODS.filter(n => n.startsWith('cooked_') || n === 'bread').reduce((s, n) => s + countItem(n), 0)
const rawCount = () => RAW_MEATS.reduce((s, n) => s + countItem(n), 0)

async function cookRawMeat () {
  for (const name of RAW_MEATS) {
    const n = countItem(name)
    if (!n) continue
    try { await smelt(name, n) } catch (e) { log('[dev] 烧肉失败:', e.message); return }
  }
}

// 下矿前：打够生肉并全部烧成熟食
async function prepareFood (minCooked = 8) {
  await cookRawMeat()
  let misses = 0
  for (let i = 0; i < 8 && cookedCount() < minCooked; i++) {
    devCheck()
    const before = cookedCount() + rawCount()
    const found = await huntOnce()
    await cookRawMeat()
    if (cookedCount() + rawCount() <= before) await wanderOnce(8000)
    if (!found && ++misses >= 2) { log('[dev] 附近没有动物'); break }
  }
  const n = cookedCount()
  if (n < minCooked) devSay(`熟食只有 ${n} 个，先下矿`, true)
  log('[dev] 熟食', n)
}

async function ensureFood () {
  if (!Number.isFinite(bot.food)) await waitFor(() => Number.isFinite(bot.food), 3000).catch(() => {})
  if (bot.food >= 18) return
  if (await eatDevFood()) { await sleep(500); if (bot.food >= 18) return }
  for (let attempt = 0; attempt < 3; attempt++) {
    devCheck()
    devSay(`饿了（${bot.food}），先打猎补食物`)
    await huntOnce()
    await eatDevFood()
    if (bot.food >= 18) return
  }
  log('[dev] 食物补不满，继续（食物', bot.food, '）')
}

async function craftDiamondArmor (table) {
  const pieces = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
  for (const p of pieces) {
    devCheck()
    try {
      await craftItem(p, 1, table)
      devSay(`${p} 完成`)
    } catch (e) { log('[dev] armor craft fail', p, e.message) }
  }
  await equipArmor()
}

async function develop () {
  if (DEV.running) return
  DEV.running = true
  DEV.cancelled = false
  DEV.dead = false
  stopped = true
  if (patrolTimer) clearTimeout(patrolTimer)
  patrolTimer = null
  try { bot.pathfinder.setGoal(null) } catch {}
  try {
    devSay('开始自主发育（目标钻石套）', true)
    log('[dev] >>> 阶段 1/7 食物')
    await ensureFood()
    // 先做镐子：烧肉要用熔炉，熔炉要圆石，圆石要镐子
    log('[dev] >>> 阶段 2/7 木镐/石镐')
    await ensurePickaxe()
    log('[dev] >>> 阶段 3/7 备熟食')
    await prepareFood(8)
    while (bot.food < 20 && (await eatDevFood())) await sleep(400)
    log('[dev] >>> 阶段 4/7 铁镐')
    if (!findItem('iron_pickaxe') && !findItem('diamond_pickaxe') && !findItem('netherite_pickaxe')) {
      await ensureIronPickaxe()
    }
    log('[dev] >>> 阶段 5/7 武器')
    await ensureSword()
    log('[dev] >>> 阶段 6/7 再补食物')
    await ensureFood()
    log('[dev] >>> 阶段 7/7 挖钻石')
    await branchMine(24)
    devSay('钻石够了，做盔甲', true)
    await craftDiamondArmor(await ensureTable())
    devSay('钻石套完成，已穿上')
    DEV.tries = 0
    saveMode('patrol')
    schedulePatrol(1500)
  } catch (e) {
    log('[dev] 中断:', e.message)
    if (DEV.cancelled || mode.kind !== 'develop') {
      devSay('已停止发育')
    } else if (/未进服|死亡重启|reading 'position'/.test(e.message)) {
      // 死亡/重连导致的瞬时错误：静默快速重试，不刷屏
      DEV.nextTry = Date.now() + 6000
      setTimeout(() => { if (mode.kind === 'develop') develop().catch(() => {}) }, 6000)
    } else {
      DEV.tries++
      DEV.nextTry = Date.now() + 30000
      devSay(`卡住了（${e.message}），30 秒后重试`)
      setTimeout(() => { if (mode.kind === 'develop') develop().catch(() => {}) }, 30000)
    }
  } finally {
    DEV.running = false
    stopped = false
  }
}

function stopDevelop (reason) {
  DEV.cancelled = true
  if (mode.kind === 'develop') saveMode('patrol')
  if (reason) { try { reply(reason) } catch {} }
}

// ---------- 指令 ----------
let lastReply = ''
let lastError = null
// 输出模式：quiet=只发关键节点（默认，避免刷屏）；log=按规划每一步发一条；silent=不回答、不发任何消息
let outputMode = 'quiet'
// 当前指令的回复目标：null=公屏；用户名=私聊回复（owner 用 /msg 下指令时）
let replyTarget = null

function reply (text) {
  lastReply = String(text)
  if (outputMode === 'silent') { log('[silent]', lastReply); return }
  if (!bot || !bot.entity) { log('[chat skipped]', lastReply); return } // 还没进服，不能发聊天
  try {
    if (replyTarget) bot.whisper(replyTarget, lastReply)
    else bot.chat(lastReply)
  } catch (e) { log('chat failed:', e.message) }
}

async function onCommand (username, message, isWhisper = false) {
  if (!CFG.owners.includes(username)) return
  const msg = String(message).trim()
  // 公屏必须带 ！/!；私聊是 1v1，直接说指令就行（带前缀也兼容）
  if (!isWhisper && !/^[!！]/.test(msg)) return
  const text = msg.replace(/^[!！]+/, '').trim()
  if (!text) return
  log(`command <${username}>${isWhisper ? ' [私聊]' : ''} ${msg}`)
  // 从私聊来的指令，回复也走私聊；代发/说 仍然用 bot.chat 发公屏
  replyTarget = isWhisper ? username : null
  try {
    await dispatchCommand(username, text)
  } catch {} finally {
    replyTarget = null
  }
}

// 供聊天指令与本地 HTTP 控制接口共用
const CMD_ALIASES = {
  进服: 'join', 进服务器: 'join', 加入: 'join', 进入: 'join', 连服: 'join',
  退服: 'leave', 退出: 'leave', 离开: 'leave', 下线: 'leave',
  服务器命令: 'srvcmd', 执行: 'srvcmd', cmd: 'srvcmd',
  跟随: 'follow', 跟: 'follow', 追: 'follow',
  说: 'say', 代发: 'say', 发言: 'say', 喊: 'say',
  收集: 'collect', 采集: 'collect', 挖: 'collect',
  停止: 'stop', 停: 'stop', 别动: 'stop',
  巡逻: 'go', 逛: 'go', 自由活动: 'go',
  去: 'goto', 前往: 'goto', 走到: 'goto',
  飞: 'fly', 飞行: 'fly', 飞到: 'fly',
  过来: 'come', 来: 'come',
  打: 'pvp', 攻击: 'pvp',
  重锤: 'mace',
  发育: 'develop', 发展: 'develop', 钻套: 'develop', 钻石套: 'develop',
  静默: 'silent', 安静: 'silent', 闭嘴: 'silent', 别说话: 'silent',
  日志: 'logmode', 播报: 'logmode',
  简报: 'quiet', 少说: 'quiet',
  矿透: 'xray', 透视: 'xray',
  地图: 'map', map: 'map',
  地图物品: 'mapitem', 手上地图: 'mapitem',
  验证码: 'captcha', captcha: 'captcha',
  丢垃圾: 'toss', 清理: 'toss', 扔垃圾: 'toss',
  状态: 'status', 汇报: 'status',
  帮助: 'help', 帮: 'help', 指令: 'help', help: 'help'
}

/**
 * 把物品栏里的地图物品（filled_map）导出成 PNG：
 * 先拿在手上让服务端下发数据，没反应就右键一次再看（有些服务端此时才重发），
 * 仍拿不到就说明这张图没探索过。
 */
async function exportMapItem (want = 0) {
  if (!bot || !bot.entity) throw new Error('不在服务器里')
  const maps = bot.inventory.items().filter((i) => i.name === 'filled_map' || i.name === 'map')
  if (!maps.length) throw new Error('物品栏里没有地图')
  const prev = bot.heldItem
  const waitMapPacket = async (ms, activate) => {
    const before = lastMapPacketAt
    if (activate) { try { bot.activateItem() } catch {} }
    const t0 = Date.now()
    while (Date.now() - t0 < ms && lastMapPacketAt <= before) {
      await new Promise((r) => setTimeout(r, 150))
    }
    return lastMapPacketAt > before
  }
  try { await bot.equip(maps[0], 'hand') } catch {}
  let got = await waitMapPacket(3000, false)
  if (!got && !(want && mapDataById.has(want))) got = await waitMapPacket(5000, true)
  if (prev) { try { await bot.equip(prev, 'hand') } catch {} }
  const id = want && mapDataById.has(want) ? want : lastMapId
  const data = id ? mapDataById.get(id) : null
  if (!data || !data.hasData) {
    throw new Error(`服务器还没下发这张地图的数据（物品栏里有 ${maps.length} 张地图，但这张可能还没探索过）`)
  }
  const out = renderItemMap(data)
  lastMap = { path: out.file, at: out.at, radius: 0, center: null, dim: '地图物品', summary: out.summary, analysis: out.analysis }
  return out
}

function rememberCaptcha (file) {
  if (!file) return
  captchaImages.push({ path: file, at: Date.now() })
  while (captchaImages.length > 5) {
    const old = captchaImages.shift()
    try { if (old && old.path !== file) fs.unlinkSync(old.path) } catch {}
  }
}

/**
 * 登录验证码提示 → 自动导出验证码地图。
 * 只负责"把图准备好并留档"，数字由人工确认后再让 AI 提交。
 */
function maybeCaptcha (msg, gen) {
  const s = String(msg || '')
  if (!/captcha|验证码/i.test(s)) return
  if (captcha.pending) return
  captcha = { pending: true, path: null, at: Date.now(), error: '' }
  log('captcha: 服务器要求验证码，准备导出验证码地图')
  setTimeout(() => {
    if (gen !== connGen) return
    exportMapItem(0).then((out) => {
      if (gen !== connGen) return
      captcha = { pending: true, path: out.file, at: Date.now(), error: '' }
      rememberCaptcha(out.file)
      log(`captcha: 已导出验证码地图 ${out.file}`)
    }).catch((e) => {
      captcha.error = e.message
      log('captcha: 导出失败:', e.message)
    })
  }, 800)
}

async function dispatchCommand (username, raw) {
  const input = String(raw).trim()
  const [rawCmd, ...args] = input.split(/\s+/)
  const cmd = CMD_ALIASES[rawCmd] || rawCmd.toLowerCase()
  const rest = input.slice(rawCmd.length).trim()
  if (!rawCmd) throw new Error('空指令')

  if (authState !== 'done' && !['stop', 'status', 'help', 'join', 'leave'].includes(cmd)) {
    throw new Error('尚未登录')
  }

  try {
    switch (cmd) {
      case 'help':
        reply('进/出服：！进服 <host> [port] [version] ！退服')
        reply('移动/任务：！状态 ！停 ！发育 ！去 x y z ！飞 x y z ！跟随 [玩家] ！收集 <方块> [数量] ！打 [玩家] ！重锤 [玩家] ！过来 ！地图 [半径] ！地图物品')
        reply('其它：！代发 <内容> ！服务器命令 <cmd> ！矿透 开/关/auto ！丢垃圾 [n] ！验证码 ！静默 ！日志 ！简报 ｜ 私聊直接发指令，回复走私聊，代发仍发公屏')
        break
      case 'join': {
        const t = joinServer(args[0], args[1], args[2])
        reply(`正在连接 ${t.host}:${t.port}（${t.version}）`)
        break
      }
      case 'leave':
        leaveServer()
        reply('已退出服务器')
        break
      case 'map': {
        // 画一张附近地形的俯视 PNG（同步扫描，几十万次方块查询，通常 1~5 秒）
        if (!bot || !bot.entity) throw new Error('不在服务器里')
        const out = renderMap(bot, { radius: Number(args[0]) || 32 })
        lastMap = { path: out.file, at: out.at, radius: out.radius, center: out.center, dim: out.dim, summary: out.summary }
        log(`map: ${out.file}（半径 ${out.radius} 格）`)
        reply(`地图已保存（半径 ${out.radius} 格）`)
        break
      }
      case 'mapitem': {
        const out = await exportMapItem(Number(args[0]) || 0)
        log(`mapitem: ${out.file}（#${out.id}）`)
        reply(`地图 #${out.id} 已保存`)
        break
      }
      case 'captcha': {
        // 手动（或上层）要求导出验证码地图：导出后标记 pending 并留档
        const out = await exportMapItem(Number(args[0]) || 0)
        captcha = { pending: true, path: out.file, at: Date.now(), error: '' }
        rememberCaptcha(out.file)
        log(`captcha: 已导出验证码地图 ${out.file}`)
        reply('验证码地图已导出')
        break
      }
      case 'srvcmd': {
        if (!rest) throw new Error('用法 srvcmd <服务器命令>')
        if (!bot || !bot.entity) throw new Error('不在服务器里')
        bot.chat(rest.startsWith('/') ? rest : `/${rest}`)
        lastError = null
        log(`srvcmd: ${rest}`)
        break
      }
      case 'silent':
        outputMode = 'silent'
        log('输出模式：静默（不回答、不发消息）')
        break
      case 'quiet':
        outputMode = 'quiet'
        reply('输出：只报关键节点')
        break
      case 'logmode':
        outputMode = 'log'
        reply('输出模式：日志，每完成一步发一条')
        break
      case 'xray': {
        const v = String(args[0] || 'auto').toLowerCase()
        if (['开', 'on', 'true', '1'].includes(v)) { setAntiXray(false); reply('矿透：强制穿透挖') }
        else if (['关', 'off', 'false', '0'].includes(v)) { setAntiXray(true); reply('矿透：只挖洞穴暴露面') }
        else { setAntiXray(null); reply('矿透：自动检测假矿') }
        break
      }
      case 'toss': {
        const n = await dropJunk(Number(args[0]) || 32)
        reply(`已丢弃 ${n} 个垃圾`)
        break
      }
      case 'stop':
        stopped = true
        flyAbort = true // 若正在飞行，则就地滑翔降落
        DEV.cancelled = true
        saveMode('stopped')
        stopPvp()
        stopMace()
        stopFollow()
        stopCollect()
        if (patrolTimer) clearTimeout(patrolTimer)
        bot.pathfinder.setGoal(null)
        bot.setControlState('forward', false)
        reply('已停止')
        break
      case 'go':
        stopped = false
        saveMode('patrol')
        schedulePatrol(100)
        reply('开始移动')
        break
      case 'say': {
        if (!rest) throw new Error('用法 say <内容>')
        // 代发永远发公屏（即使是私聊下指令），只用私聊回一句确认
        bot.chat(rest)
        lastError = null
        log(`say: ${rest}`)
        if (replyTarget) reply('已代发到公屏')
        break
      }
      case 'follow': {
        const arg = args[0]
        if (!arg || arg === 'off' || arg === 'stop' || arg === '停') {
          if (!stopFollow('已停止跟随')) reply('当前没有跟随')
          saveMode('patrol')
          schedulePatrol(800)
          break
        }
        const spec = resolveFollowTarget(args)
        stopPvp()
        stopMace()
        stopCollect()
        // 注意：spec 里也有 kind 字段，直接展开会覆盖模式名
        saveMode('follow', spec.kind === 'player' ? { name: spec.name } : { type: spec.type })
        reply(`跟随 ${followLabel(spec)}`)
        runFollow(spec)
        break
      }
      case 'collect': {
        const arg = args[0]
        if (!arg || arg === 'off' || arg === 'stop' || arg === '停') {
          if (!stopCollect('已停止收集')) reply('当前没有收集任务')
          saveMode('patrol')
          schedulePatrol(800)
          break
        }
        const type = BLOCK_ALIASES[arg] || arg.toLowerCase()
        if (!bot.registry.blocksByName[type]) throw new Error(`未知资源 ${arg}`)
        const total = Math.max(1, Math.min(Number(args[1]) || 1, 512))
        stopPvp()
        stopMace()
        stopFollow()
        saveMode('collect', { type, count: total })
        reply(`开始收集 ${type} x${total}`)
        runCollect(type, total)
        break
      }
      case 'develop': {
        stopPvp()
        stopMace()
        stopFollow()
        stopCollect()
        if (patrolTimer) clearTimeout(patrolTimer)
        patrolTimer = null
        saveMode('develop')
        reply('开始自主发育：木头→石镐→铁镐→钻石套，停止用 停')
        develop().catch(e => log('[dev] top error', e.message))
        break
      }
      case 'goto': {
        const [x, y, z] = args.map(Number)
        if ([x, y, z].some(Number.isNaN)) throw new Error('用法 goto x y z')
        stopPvp()
        stopMace()
        stopFollow()
        stopCollect()
        saveMode('goto', { x, y, z })
        reply(`前往 ${x} ${y} ${z}`)
        await goto(x, y, z)
        if (mode.kind === 'goto') saveMode('patrol')
        reply('到达目标')
        stopped = false
        schedulePatrol(1500)
        break
      }
      case 'fly': {
        const [x, y, z] = args.map(Number)
        if ([x, y, z].some(Number.isNaN)) throw new Error('用法 fly x y z')
        stopPvp()
        stopMace()
        stopFollow()
        stopCollect()
        saveMode('fly', { x, y, z })
        stopped = true
        reply(`鞘翅飞往 ${x} ${y} ${z}`)
        await flyTo(x, y, z)
        if (mode.kind === 'fly') saveMode('patrol')
        reply('已安全降落')
        stopped = false
        break
      }
      case 'come': {
        const owner = bot.players[username] && bot.players[username].entity
        if (!owner) throw new Error('找不到你的位置')
        stopped = true
        await goto(owner.position.x, owner.position.y, owner.position.z)
        reply('到了')
        stopped = false
        schedulePatrol(1500)
        break
      }
      case 'mace': {
        if (flying) throw new Error('正在飞行')
        const arg = args[0]
        if (arg === 'off' || arg === 'stop') {
          if (!stopMace('鞘翅重锤已停止')) reply('当前没有重锤模式')
          saveMode('patrol')
          break
        }
        if (!findItem('mace')) throw new Error('背包里没有重锤')
        let name = arg
        if (!name) {
          const nearest = Object.values(bot.players)
            .filter(p => p.entity && p.username !== bot.username)
            .sort((a, b) => bot.entity.position.distanceTo(a.entity.position) -
              bot.entity.position.distanceTo(b.entity.position))[0]
          if (!nearest) throw new Error('附近没有玩家')
          name = nearest.username
        }
        if (!bot.players[name]?.entity) throw new Error(`看不到玩家 ${name}`)
        stopPvp()
        stopMace()
        stopFollow()
        stopCollect()
        saveMode('mace', { name })
        maceCancelled = false
        runMace(name)
        break
      }
      case 'pvp': {
        if (flying) throw new Error('正在飞行')
        stopMace()
        const arg = args[0]
        if (arg === 'off' || arg === 'stop') {
          if (!stopPvp('PvP 已停止')) reply('当前没有 PvP')
          saveMode('patrol')
          break
        }
        // 不带参数时攻击最近的玩家
        let name = arg
        if (!name) {
          const nearest = Object.values(bot.players)
            .filter(p => p.entity && p.username !== bot.username)
            .sort((a, b) => bot.entity.position.distanceTo(a.entity.position) -
              bot.entity.position.distanceTo(b.entity.position))[0]
          if (!nearest) throw new Error('附近没有玩家')
          name = nearest.username
        }
        if (!bot.players[name]?.entity) throw new Error(`看不到玩家 ${name}`)
        stopPvp()
        stopFollow()
        stopCollect()
        saveMode('pvp', { name })
        runPvp(name)
        break
      }
      case 'status':
        if (!bot || !bot.entity) {
          reply(wantConnect ? `连接中…（${CFG.host}:${CFG.port}）` : '当前未进服，可用 join <host> [port] [version] 进服')
          break
        }
        reply(`${fmt(bot.entity.position)} 模式=${bot.game.gameMode} 鞘翅=${Boolean(bot.entity.elytraFlying)}${mode.kind === 'develop' ? ` 发育中(钻石x${countItem('diamond')})` : ''}${pvpName ? ` PvP=${pvpName}` : ''}${maceName ? ` 重锤=${maceName}` : ''}${followTarget ? ` 跟随=${followLabel(followTarget)}` : ''}${collectJob ? ` 收集=${collectJob.type} ${collectJob.done}/${collectJob.total}` : ''}`)
        break
      default:
        throw new Error(`未知指令 ${cmd}`)
    }
    lastError = null
  } catch (e) {
    lastError = e.message
    log('command failed:', e.message)
    reply(`失败: ${e.message}`)
    if (mode.kind === 'goto' || mode.kind === 'fly') saveMode('patrol')
    if (!flying && mode.kind !== 'stopped') stopped = false
    throw e
  }
}

// ---------- 进出服（由小钠通过 HTTP 下令）----------
// 换服/退服前把在跑的任务全部停掉，否则旧任务会拿着已经作废的 bot 继续跑
function resetTasks () {
  if (patrolTimer) clearTimeout(patrolTimer)
  patrolTimer = null
  flying = false
  flyAbort = true
  pvpName = null
  pvpRunning = false
  maceName = null
  maceRunning = false
  followCancelled = true
  followTarget = null
  followRunning = false
  collectJob = null
  collectRunning = false
  if (global.__elytraAssert) { clearInterval(global.__elytraAssert); global.__elytraAssert = null }
}

function joinServer (address, portArg, versionArg) {
  let host = String(address || '').trim()
  if (!host) throw new Error('用法 join <host> [port] [version]')
  let port = Number(portArg) || 0
  const m = host.match(/^([^\s:]+):(\d+)$/)
  if (m) { host = m[1]; port = Number(m[2]) }
  if (!port) port = 25565
  if (!(port >= 1 && port <= 65535)) throw new Error(`端口不合法：${port}`)
  CFG.host = host
  CFG.port = port
  if (versionArg) CFG.version = String(versionArg).trim()

  wantConnect = true
  stopped = false
  reconnectDelay = 5000
  authState = 'unknown'
  authSeen = false
  regTries = 0
  lastMap = null // 换服后旧地图作废，避免拿到上一个服的位置
  mapDataById.clear() // 地图编号是按服务器分配的，换服必须清缓存
  lastMapPacketAt = 0
  lastMapId = 0
  chatLog.length = 0 // 换服后旧聊天记录会误导判断
  lastTitle = { title: '', subtitle: '', actionBar: '', at: 0 }
  captcha = { pending: false, path: null, at: 0, error: '' }
  captchaImages.length = 0
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  const old = bot
  connGen++ // 旧实例的 end 回调作废，也不会触发重连
  bot = null
  resetTasks()
  if (old) {
    try { old.pathfinder?.setGoal(null) } catch {}
    try { old.quit('switch') } catch {}
  }
  saveMode('stopped')
  log(`join ${CFG.host}:${CFG.port} (${CFG.version}) as ${CFG.username}`)
  setTimeout(createBot, 300)
  return { host: CFG.host, port: CFG.port, version: CFG.version }
}

function leaveServer () {
  wantConnect = false
  connGen++
  lastMap = null
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  const old = bot
  bot = null
  authState = 'unknown'
  stopped = true
  resetTasks()
  if (old) {
    try { old.pathfinder?.setGoal(null) } catch {}
    try { old.quit('leave') } catch {}
  }
  saveMode('stopped')
  log('leave: 已退出服务器')
}

// ---------- 本机 HTTP 控制接口（给 agent 用）----------
/** 侧边计分板：标题 + 各行文本（mineflayer 不同版本结构略有差异，统一拍平） */
function readScoreboard () {
  try {
    const sb = bot && bot.scoreboard
    if (!sb) return null
    const raw = sb.items || []
    const items = (Array.isArray(raw) ? raw : Object.values(raw))
      .map((i) => {
        if (i == null) return ''
        if (typeof i === 'string') return i
        if (i.displayName != null) return flattenText(i.displayName)
        return i.name != null ? String(i.name) : ''
      })
      .filter(Boolean)
    return { title: flattenText(sb.title || sb.name || ''), items: items.slice(0, 20) }
  } catch { return null }
}

/** Boss 栏：标题 + 进度（mineflayer 存在 bot.bossBars） */
function readBossBars () {
  try {
    const list = bot && bot.bossBars
    if (!list || !list.length) return []
    return list.slice(0, 5).map((b) => ({
      title: flattenText(b.title),
      health: Number(b.health),
      dividers: Number(b.dividers) || 20
    }))
  } catch { return [] }
}

function botState () {
  const connected = Boolean(bot && bot._client && bot._client.state === 'play')
  const server = { host: CFG.host, port: CFG.port, version: CFG.version, wantConnect }
  // 界面信息不依赖 spawned：登录/验证码阶段的提示也在这几条通道里
  const hud = { chat: chatLog.slice(-30), title: lastTitle, scoreboard: readScoreboard(), bossBars: readBossBars() }
  const caps = { captcha, captchaImages: captchaImages.slice() }
  if (!bot || !bot.entity) {
    return { connected, server, auth: authState, spawned: false, mode: { kind: mode.kind, updatedAt: mode.updatedAt }, lastReply, lastError, map: lastMap, ...caps, ...hud }
  }
  const p = bot.entity.position
  const players = Object.values(bot.players)
    .filter(x => x.entity && x.username !== bot.username)
    .map(x => ({ name: x.username, distance: Number(p.distanceTo(x.entity.position).toFixed(2)) }))
    .sort((a, b) => a.distance - b.distance)
  const inventory = {}
  try {
    for (const it of bot.inventory.items()) inventory[it.name] = (inventory[it.name] || 0) + it.count
  } catch {}
  const offhand = bot.inventory?.slots?.[45]?.name || null
  return {
    connected,
    server,
    auth: authState,
    authTries: { login: authTries, register: regTries },
    spawned: true,
    gamemode: bot.game.gameMode,
    pos: { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)), z: Number(p.z.toFixed(3)) },
    health: bot.health,
    food: bot.food,
    onGround: bot.entity.onGround,
    elytraFlying: Boolean(bot.entity.elytraFlying),
    flying,
    pvp: pvpName,
    mace: maceName,
    follow: followTarget ? { kind: followTarget.kind, name: followTarget.name, type: followTarget.type } : null,
    followAir: followAirInfo(),
    collect: collectJob ? { type: collectJob.type, done: collectJob.done, total: collectJob.total } : null,
    mode: { kind: mode.kind, updatedAt: mode.updatedAt },
    outputMode,
    antiXray: antiXray === null ? 'auto' : (antiXray ? 'on(表面挖)' : 'off(穿透挖)'),
    develop: mode.kind === 'develop' ? { running: DEV.running, tries: DEV.tries } : null,
    lastReply,
    lastError,
    map: lastMap,
    ...caps,
    ...hud,
    players,
    inventory,
    offhand,
    invSlots: (() => { try { return bot.inventory.slots.map((s, i) => s ? `${i}:${s.name}x${s.count}` : null).filter(Boolean) } catch { return null } })(),
    nearDrops: (() => { try { return Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(p) < 12).length } catch { return null } })(),
    path: bot.pathfinder
      ? {
          goal: bot.pathfinder.goal ? (bot.pathfinder.goal.constructor?.name || 'goal') : null,
          moving: bot.pathfinder.isMoving(),
          mining: bot.pathfinder.isMining(),
          dig: bot.targetDigBlock?.name || null
        }
      : null,
    here: bot.entity ? [0, 1, 2, 3].map(dy => bot.blockAt(p.offset(0, dy, 0))?.name || null).concat(
      [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => bot.blockAt(p.offset(dx, 0, dz))?.name || null)) : null
  }
}

function listenControl () {
  const port = Number(process.env.MC_CTL_PORT || 2319)
  const send = (res, code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/state') {
      return send(res, 200, botState())
    }
    if (url.pathname === '/cmd') {
      const collect = req.method === 'GET'
        ? Promise.resolve('')
        : new Promise(r => { let d = ''; req.on('data', c => { d += c }); req.on('end', () => r(d)) })
      collect.then(body => {
        let cmd = url.searchParams.get('cmd')
        if (!cmd && body) {
          try { cmd = JSON.parse(body).cmd } catch { cmd = body }
        }
        if (!cmd) return send(res, 400, { ok: false, error: '缺少 cmd' })
        const p = dispatchCommand('agent', cmd)
        return Promise.race([
          p.then(() => ({ kind: 'done' })).catch(e => ({ kind: 'error', error: e.message })),
          sleep(1500).then(() => ({ kind: 'pending' }))
        ]).then(r => send(res, r.kind === 'error' ? 400 : 200, {
          ok: r.kind !== 'error',
          pending: r.kind === 'pending',
          error: r.error,
          reply: lastReply,
          state: botState()
        }))
      })
      return
    }
    send(res, 404, { ok: false, error: 'GET /state | POST /cmd {"cmd":"goto 100 64 100"} | GET /cmd?cmd=status' })
  })
  server.on('error', e => log('control server error:', e.message))
  server.listen(port, '127.0.0.1', () => log(`control: http://127.0.0.1:${port}/state`))
}
// 守护：agent 断线/不再下指令时，按最后的模式把状态机重新拉起来
let stall = { x: 0, y: 0, z: 0, at: Date.now() }
let stallCount = 0

// 卡死时自己挖开一条路（脚下/头顶/四向各一层）
async function unstick () {
  const p = bot.entity.position.floored()
  const targets = [p, p.offset(0, 1, 0)]
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    targets.push(p.offset(dx, 0, dz), p.offset(dx, 1, dz))
  }
  targets.push(p.offset(0, 2, 0))
  try {
    const cursor = bot.blockAtCursor(3)
    if (cursor) targets.push(cursor.position)
  } catch {}
  log('unstick: 尝试挖开周围方块')
  for (const t of targets) {
    const block = bot.blockAt(t)
    if (!block || block.boundingBox !== 'block' || block.name === 'bedrock') continue
    try { await queuedDig(block) } catch (e) { log('unstick dig failed:', e.message) }
  }
}
let devStall = { at: 0, n: 0, x: 0, y: 0, z: 0 }
// 主动告诉看门狗“我在忙，不算卡死”
function touchDevStall () { devStall.at = Date.now() }
function trackDevelopStall () {
  if (mode.kind !== 'develop' || !DEV.running) { devStall.at = 0; devStall.n = 0; return }
  const p = bot.entity.position
  if (!devStall.at || Math.hypot(p.x - devStall.x, p.y - devStall.y, p.z - devStall.z) > 0.6) {
    devStall = { at: Date.now(), n: devStall.n, x: p.x, y: p.y, z: p.z }
    return
  }
  if (Date.now() - devStall.at < 45000) return
  devStall.n++
  log(`[dev] 45 秒无位移，强制解卡 #${devStall.n}`)
  try {
    const near = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 10)
      .slice(0, 6).map(e => `${e.name || e.type}@${e.position.distanceTo(bot.entity.position).toFixed(1)}`)
    log('[dev] 现场:', JSON.stringify({
      goal: bot.pathfinder.goal ? bot.pathfinder.goal.constructor.name : null,
      dig: bot.targetDigBlock ? bot.targetDigBlock.name : null,
      ctrl: bot.controlState ? Object.keys(bot.controlState).filter(k => bot.controlState[k]) : null,
      near
    }))
  } catch (e) { log('[dev] 现场 dump 失败', e.message) }
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
  try { bot.stopDigging() } catch {}
  try { bot.swingArm() } catch {}
  // 真的动一下：先把自己卡进去的方块挖掉，再往前顶
  setTimeout(async () => {
    try { await freeSelf(4) } catch {}
    try {
      const a = Math.random() * Math.PI * 2
      await bot.look(a, 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(500)
      bot.setControlState('jump', false)
      bot.setControlState('forward', false)
    } catch {}
  }, 400)
  if (devStall.n >= 2) { DEV.axis = null; DEV.tgtKey = null; DEV.noMove = 0 }
  devStall.at = Date.now()
  if (devStall.n >= 3) {
    devStall.n = 0
    log('[dev] 连续解卡无效，重启发育流程')
    DEV.cancelled = true
    setTimeout(() => {
      if (mode.kind !== 'develop') return
      DEV.cancelled = false
      DEV.running = false
      develop().catch(() => {})
    }, 4000)
  }
}

function startWatchdog () {
  setInterval(() => {
    if (!bot || !bot.entity || authState !== 'done') return
    trackDevelopStall()
    if (mode.kind === 'stopped') { stopped = true; return }
    if (flying) return
    if (mode.kind === 'goto') return
    if (mode.kind === 'pvp') {
      if (!pvpRunning) { saveMode('patrol'); stopped = false; schedulePatrol(800) }
      return
    }
    if (mode.kind === 'mace') {
      if (!maceRunning) { saveMode('patrol'); stopped = false; schedulePatrol(800) }
      return
    }
    if (mode.kind === 'follow') {
      if (!followRunning && (mode.name || mode.type)) {
        runFollow({ kind: mode.name ? 'player' : 'entity', name: mode.name, type: mode.type })
      }
      return
    }
    if (mode.kind === 'develop') {
      if (!DEV.running && Date.now() > (DEV.nextTry || 0)) develop().catch(() => {})
      return
    }
    if (mode.kind === 'collect') {
      if (!collectRunning && mode.type) runCollect(mode.type, mode.count || 1)
      return
    }
    // patrol：卡住 15s 就重新规划，避免寻路死锁导致状态停滞
    const p = bot.entity.position
    if (Math.hypot(p.x - stall.x, p.y - stall.y, p.z - stall.z) > 0.3) {
      stall = { x: p.x, y: p.y, z: p.z, at: Date.now() }
      stallCount = 0
    } else if (Date.now() - stall.at > 15000) {
      stallCount++
      log(`patrol 卡住，重新规划 (#${stallCount})`)
      if (patrolTimer) clearTimeout(patrolTimer)
      patrolTimer = null
      try { bot.pathfinder.setGoal(null) } catch {}
      if (stallCount >= 2) {
        stallCount = 0
        unstick().catch(() => {})
      }
      stall = { x: p.x, y: p.y, z: p.z, at: Date.now() }
      schedulePatrol(600)
      return
    }
    if (patrolTimer || bot.pathfinder.goal) return
    stopped = false
    schedulePatrol(300 + Math.random() * 700)
  }, 5000).unref()
}


function onDeath () {
  log('died, respawning')
  if (mode.kind === 'develop') DEV.dead = true
  flying = false
  flyAbort = false
  stopped = false
  try { bot.clearControlStates() } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  if (bot.entity) {
    try { bot.entity.elytraFlying = false } catch {}
    try { bot.entity.velocity?.set(0, 0, 0) } catch {}
  }
  pvpName = null
  pvpRunning = false
  maceName = null
  maceRunning = false
  followCancelled = true
  followTarget = null
  followRunning = false
  collectJob = null
  collectRunning = false
  if (bot.pathfinder) bot.pathfinder.setGoal(null)
  setTimeout(() => { if (bot && bot.respawn) bot.respawn() }, 1000)
}

// 被 kill 时先正常退出，避免服务端残留在线会话（playerAlreadyOnline）
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { if (bot) bot.quit('restart') } catch {}
    setTimeout(() => process.exit(0), 400)
  })
}

loadMode()
listenControl()
startWatchdog()
if (wantConnect) createBot()
else log(`等待进服指令：POST /cmd {"cmd":"join <host> [port] [version]"}（用户 ${CFG.username}）`)
