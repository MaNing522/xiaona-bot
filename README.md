# 小钠 QQ 机器人 · xiaona-bot

基于**真实 QQ 账号**的群聊机器人，外加一个 **Minecraft Fabric 服务端模组**，把 QQ 群和游戏内聊天双向打通。

- **本机（Windows）**：QQ 登录（SnowLuma / OneBot11，注入桌面 QQ）、AI 回复、联网搜索、语音、截图、网页控制面板、QQ ↔ 游戏ID 绑定、完整的命令系统。
- **服务端（Fabric 1.21.11）**：把游戏事件（聊天 / 进出服 / 死亡 / 成就）推给本机，接收本机投递的文本；**与 MC 共用同一个端口**（端口复用），即使服务商只放行一个端口也能用。

> 本仓库不含 SnowLuma 本体（体积大，已在 `.gitignore` 中排除），需自行下载后放到 `snowluma/` 目录；它依赖**桌面 QQ 客户端**，并且只能扫码登录。

---

## 系统架构

```
        QQ 群 / 私聊                          游戏内玩家
             │                                     │
             ▼                                     ▼
   SnowLuma (OneBot11, ws://127.0.0.1:3001) Fabric 模组 xiaona（服务端）
             │                                     │
             └──────────────┬──────────────────────┘
                            ▼
                   本机 Node 机器人（src/index.js）
                   ├─ AI 回复（DeepSeek）+ 记忆
                   ├─ 联网搜索 / 语音 / 截图
                   ├─ 命令系统 / 定时任务 / 权限
                   ├─ 网页控制面板 :80 (HTTP，可选 HTTPS)
                   └─ 加签 HTTP + SSE  ◄──►  服务端 mod（端口复用，共用一个对外端口）
```

- QQ 与 AI **全部在本机运行**；服务端只运行一个轻量桥。
- 本机 ↔ 服务端之间用 **HMAC-SHA256 签名**通信（时间戳 + nonce 防重放）。

---

## 功能特性

- **AI 对话**：群聊 @ 或含「小钠」关键词触发；私聊直接对话；支持会话记忆与联网搜索。
- **唤起会话**：被叫到之后，接下来即使没有 @ 也没提名字，也会继续判断有没有在跟它说话（像真人被叫住后会接着聊）。额度：首先唤起的人多接几条，别人插嘴只接一条；用完自动回到"不叫不理"。
- **联网搜索**：接入百度智能搜索（千帆 ai_search），小钠自己判断何时需要搜索（无手动命令）。
- **QQ ↔ 游戏ID 绑定**：**只能在桥接群**里发 `#绑定 <游戏ID>`（其他群和私聊都不行），过图形验证码即可把群里消息转发进游戏（每人最多 3 个）。
- **游戏桥**：双向聊天转发、进出服/死亡/成就提示、游戏图片转 QQ 真图、公聊限速与重复内容屏蔽。
- **网页控制面板**：HTTP（默认，可选 HTTPS）+ 登录鉴权 + 图形验证码 + 登录限速；可查看状态、管理权限、以机器人身份发消息、开关功能、人工接管。「全局设置」管默认参数，「会话设置」只改单个群/私聊。
- **登录前试用**：`/trial` 无需登录即可跟小钠私聊（普通用户「小锂」身份，限速防滥用）；登录后同一套界面按**所有者**身份跑（套用 `BOT_OWNER` 信息），支持 `#命令` 与语音。
- **老旧浏览器兼容**：不支持 `async` / `?.` / `??` / `fetch` 的老浏览器自动跳到 `/legacy` 精简页（状态 / 登录 / 试用），现代浏览器照常使用完整面板。
- **命令系统**：`#帮助` 分类菜单，覆盖绑定、记忆、群管、定时、主人、工具等。
- **文字转语音**、**屏幕/网址截图**、**MC 服务器状态查询**、**定时提醒/定时禁言**。
- **QQ 空间自动说说**：按 1~7 天随机间隔发说说，每发 N 条自评一条；有人评论你的说说时在动态下回复。间隔、频率、查看权限、风格都在网页「全局设置」里调。
- **AI 本地笔记**：AI 可用 `write_note` / `read_note` 把资料写进 `data/notes/*.txt`，之后按需读回（授权用户及以上）。
- **静默启动**：启动器自动拉起 QQ 后把窗口最小化到任务栏，不打断当前操作。
- **进群/好友申请审批**：转发给主人，引用通知回复「同意 / 拒绝」即可（绝不自动同意）。
- **端口复用**：HTTP 面板与 MC 同端口共存；并让服务端也能拿到玩家**真实 IP**。
- **健康检查**：`GET /health`（免登录）返回机器人 / MC 桥 / AI 的通断状态，便于外部探活。
- **日志落盘**：终端、面板实时日志、`logs/YYYY-MM-DD.log` 三处同步，级别可配。
- **宽松限速**：冷却与分钟超限**静默排队**（等够了自动回），只有额度用满/排太久才提示；刷屏才静默丢弃。
- **成本优化**：锁死 system prompt 前缀以命中缓存（实测命中约 5.6k tokens）、按类型限制 `max_tokens`、透传 `user`。

---

## 目录结构

```
QQBot/
├─ start.js             启动器（拉起 QQ + SnowLuma + 机器人 + WebUI）
├─ src/                 机器人源码（主程序 index.js + 各功能模块）
│  ├─ index.js          机器人主程序（消息处理、AI、命令）
│  ├─ paths.js          项目根路径（运行时资源都相对它，整目录复制即可迁移）
│  ├─ aiService.js      AI 服务商可插拔层（选服务商 / 定模型 / 发请求 / max_tokens）
│  ├─ rateLimit.js      宽松限速（用户/群/全局滑动窗口 + 信号量队列 + 反刷屏）
│  ├─ idle.js           闲时调度（避开工作日高峰跑维护任务）
│  ├─ webui.js          网页控制面板（HTTP/HTTPS / 登录 / 权限 / 开关 / 接管 / 健康检查 / 试用）
│  ├─ tls.js            WebUI 本地根 CA + 服务器证书（生成 / 续签 / 自动信任，data/tls 不入库）
│  ├─ logger.js         统一日志出口（终端 + 面板 + 按天文件）
│  ├─ mcbridge.js       与服务器 mod 的加签通信（HTTP + SSE）
│  ├─ binding.js        QQ ↔ 游戏ID 绑定（验证码）
│  ├─ memory.js         会话记忆（SQLite）   db.js          建表 / FTS5 / 旧数据迁移
│  ├─ help.js           #帮助 菜单           scheduler.js   定时任务
│  ├─ search.js         联网搜索（百度智能搜索）
│  ├─ qzone.js          QQ 空间自动说说（随机间隔 / 自评 / 回复评论）
│  ├─ notes.js          AI 本地文本笔记（data/notes）
│  ├─ tts.js            文字转语音           screenshot.js  屏幕 / 网址截图
│  └─ mc.js             MC 服务器状态        captcha.js / shake.js / state.js / datafile.js
├─ test/                Vitest 单元测试
├─ web/index.html       控制面板页面
├─ web/legacy.html      老旧浏览器兼容页（纯 ES5 / XHR）
├─ prompt.txt           机器人人设提示词（改完保存即热更新）
├─ config.json          数值类可调项（冷却 / 限流 / 时效，热加载）
├─ push.bat / restart.bat / 启动.bat / startASR.bat   运维脚本
├─ tools/               附带工具（如 VC 运行库安装包）
├─ .env.example         配置模板（复制为 .env 填写；.env 不入库）
├─ logs/                按天滚动的运行日志（YYYY-MM-DD.log，不入库）
└─ xiaona-mod/          Minecraft Fabric 服务端模组（Java）
   └─ src/main/java/com/xiaona/  ·  src/main/resources/
```

> **迁移**：整个 `QQBot/` 目录可直接复制到别处运行。`.env`、`config.json`、`data/`、`logs/`、`voice_cache/`、`web/`、`snowluma/` 都相对项目根定位，不写死盘符。`asr-venv/` 是 Python 虚拟环境，换机若基础 Python 路径不同需重建（不建也能启动，只是本地语音识别不可用）。

---

## 环境要求

| 组件 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| 运行时 | **Node.js ≥ 22**（记忆存储用内置 `node:sqlite`，无需编译原生依赖） |
| QQ | 一个真实 QQ 账号（作机器人）+ 桌面 QQ 客户端；SnowLuma 自备 |
| 服务端桥 | Java 21 · Fabric Loader ≥ 0.18.1 · Fabric API · Minecraft 1.21.11 |

---

## 快速开始

### 1) 本机机器人（Node 端）

```bat
npm install
copy .env.example .env
```

编辑 `.env`（**至少**填这几项）：`BOT_OWNER`、`AI_API_KEY`、`MC_BRIDGE_SECRET`、`WEBUI_PASSWORD`。

启动：

```bat
启动.bat
```

或 `npm start`。启动器会自动拉起 QQ 与 SnowLuma；**首次使用请在服务器桌面上的 QQ 扫码登录**，登录后 SnowLuma 自动注入，OneBot 端口随之上线。

### 2) 服务端桥（Fabric mod）

```bat
cd xiaona-mod
gradlew.bat build
```

产物在 `xiaona-mod/build/libs/xiaona-mod-<版本>.jar`，连同 **Fabric API** 一起放进服务端 `mods/`。

首次启动会生成 `config/xiaona/config.json`，把其中的 `bridge.secret` 填成与 `.env` 的 **`MC_BRIDGE_SECRET` 完全一致**（且 ≥ 32 位；不填则桥拒绝启动）。

---

## 配置说明

### `.env`（本机）

> **缺配置即停用**：没填的项对应的功能会自动关闭，机器人不会报错崩溃；启动时会打印一份「功能状态」清单。
> `AI_API_KEY` → AI 对话；`BAIDU_SEARCH_KEY` → 联网搜索；`WEBUI_PASSWORD` → 网页面板；`MC_BRIDGE_URL`+`MC_BRIDGE_SECRET` → MC 服务器桥；`BOT_OWNER` → 授权/审批等主人功能（所有者）。

| 分组 | 关键项 | 说明 |
|---|---|---|
| SnowLuma | `ONEBOT_WS` / `ONEBOT_TOKEN` | OneBot11 连接地址与 token（会自动写进 `snowluma/config/onebot.json`） |
| SnowLuma | `QQ_PATH` / `QQ_AUTOLAUNCH` | 桌面 QQ 路径（留空用默认安装位置）、QQ 未运行时是否自动拉起 |
| 身份 | `BOT_OWNER` / `BOT_OWNER_BACKUP` / `BOT_ADMINS` | 所有者（最高权限，可增删主人，只能改 `.env` 更换）、主人2（`.env` 写死的主人档，留空不启用）、管理员 |
| AI | `AI_PROVIDER` / `AI_API_URL` / `AI_API_KEY` / `AI_MODEL` | 服务商（`deepseek`/`openai`/`custom`，默认 deepseek）；URL 与模型留空则用所选服务商的默认值 |
| 搜索 | `BAIDU_SEARCH_KEY` | 百度智能搜索密钥（千帆 ai_search）；不填则联网搜索关闭 |
| 语音 | `TTS_VOICE_ID` | 玉峰语音合成（kktts，免密钥）；音色 ID 默认甜妹音，列表见 `kktts.php?action=list` |
| 余额统计 | `#余额矫正 <充值总金额> <已使用> [币种]` | `#余额` 的累计充值/已使用直接用命令设定（元），之后充值在该基数上累加；不设则自首次查询起记账 |
| 记忆 | `MEMORY_MAX_RECENT` / `MEMORY_MAX_LONGTERM` / `MEMORY_MAX_AGE_DAYS` | 记忆保留上限与超时清理 |
| 上下文 | `MEMORY_CONTEXT_RECENT` | 每次对话注入给 AI 的「最近对话」条数（默认 20，建议 20~30） |
| 唤起会话 | `ENGAGE_DEBUG` | 置 `true` 打印唤起判断的额度消耗，便于排查 |
| 面板 | `WEBUI_HOST` / `WEBUI_HTTPS` / `WEBUI_PORT` / `WEBUI_HTTP_PORT` / `WEBUI_USER` / `WEBUI_PASSWORD` | 密码留空则面板不启动；默认 HTTP 80，设 `WEBUI_HTTPS=true` 即切回 HTTPS（443）；`WEBUI_HTTP_PORT` 为 HTTP→HTTPS 跳转端口，仅 HTTPS 模式生效（0=关闭） |
| 面板证书 | `WEBUI_TLS_TRUST` / `OPENSSL_BIN` | 仅 `WEBUI_HTTPS=true` 时生效；默认 `true` 自动把本地根 CA 装进当前用户受信任根证书（Chrome/Edge 不再报不安全）；设 `false` 不改系统证书库。`OPENSSL_BIN` 指定 openssl 路径 |
| MC 桥 | `MC_BRIDGE_URL` / `MC_BRIDGE_SECRET` / `MC_BRIDGE_GROUP` | 桥地址、签名密钥、桥接群号 |
| MC 桥 | `MC_SERVER_NAME` | 喂给 AI 的服务器名字（可留空）。地址自动取自 `MC_BRIDGE_URL`；这些值只在 `.env`，不入库 |
| MC 桥开关 | `MC_BRIDGE_MC_TO_QQ` / `MC_BRIDGE_QQ_TO_MC` / `MC_BRIDGE_OP_RELAY` / `MC_BRIDGE_GAME_IMAGE` | 各方向开关 |
| MC 桥限流 | `MC_BRIDGE_CHAT_RATE_MAX` / `MC_BRIDGE_CHAT_RATE_WINDOW_SEC` / `MC_BRIDGE_DUP_MAX` / `MC_BRIDGE_DUP_TTL_SEC` | 公聊限速与重复屏蔽 |
| 行为 | `BOT_REPLY` / `QQ_GROUP_NOTICE` / `POKE_REPLY` / `QQ_REQUEST_APPROVE` | 机器人消息、进出群提示、戳一戳、申请审批 |
| 绑定 | `BIND_CAPTCHA_TTL` | 验证码有效期（每人可绑数量见 config.json 的 `bind.maxPerQQ`，单个 QQ 可用 `#绑定上限` 覆盖） |
| 日志 | `LOG_LEVEL` | `trace`/`debug`/`info`/`warn`/`error`/`fatal`（默认 `info`），三处输出见下 |
| 限速 | `RL_*` | 用户/群/全局三级限额与惩罚阈值（详见「宽松限速」一节），全部可调 |
| 成本 | `AI_MAX_TOKENS` / `AI_MAX_TOKENS_SHORT` / `AI_MAX_TOKENS_LONG` | 输出上限（默认 512 / 300 / 1200） |
| 闲时维护 | `IDLE_INTERVAL_MS` / `IDLE_KICKOFF_MS` / `VOICE_CACHE_KEEP` | 维护间隔、首次延迟、语音缓存保留数 |

### `config/xiaona/config.json`（服务端）

| 分组 | 关键项 | 说明 |
|---|---|---|
| `bridge` | `secret` | 与 `.env` 的 `MC_BRIDGE_SECRET` 一致，≥ 32 位 |
| `bridge` | `prefixColor` / `chatPrefix` / `privateCommand` | 注入前缀颜色、聊天前缀、游戏内私聊命令（默认 `xn`） |
| `bridge` | `allowFrom` / `rateLimitPerMinute` | 来源白名单、注入限速 |
| `http` | `sharePort` / `internalPort` / `mcPort` | 复用端口、MC 内部端口、MC 实际端口（0=自动） |
| `board` | `enabled` / `title` | 未绑定玩家的侧边栏指引计分板 |
| `plan` | `enabled` / `url` / `user` / `password` | Plan 玩家数据插件（服务器本机访问） |

---

## 权限档位

五档从高到低，**高档自动包含低档的全部命令**；群里发 `#帮助 权限` 可随时查看。所有者用 `#授权 <@或QQ号> [等级]` 直接设定等级，另有黑名单档不再响应其消息。

| 档位 | 来源 | 能用 |
|---|---|---|
| 👑 所有者 | `.env` 的 `BOT_OWNER`（只能改 `.env` 更换） | 主人全部 + 增删主人 |
| 👑 主人 | `BOT_OWNER_BACKUP`（主人2）或 `#授权 <QQ> 0`（仅所有者可设） | 全部命令 + 主人专属 |
| 🛡️ 管理员 | `BOT_ADMINS` 或 `#授权 <QQ> 1` | 授权用户全部 + 群管、定时、`#余额`、`#强制解绑` |
| ✅ 授权用户 | `#申请授权` 由主人审批（或 `#授权 <QQ> 2`） | 普通用户全部 + 工具（`#截图` / `#shot`、`#聊天记录`） |
| 👤 普通用户 | 默认（未授权），或 `#授权 <QQ> 3` | 公开命令：帮助 / 状态 / 查询 / mc / 申请授权、绑定、记忆 |
| 🚫 黑名单 | `#授权 <QQ> 4` | 不响应其消息（命令、AI、验证码都不理），但群里消息照常转发进游戏 |

> `#授权 <@或QQ号> [等级]`：等级 0主人 / 1管理员 / 2授权用户 / 3普通 / 4黑名单，**不填为 2**。`.env` 的 `BOT_OWNER`（所有者）只能用改 `.env` 的方式更换；`BOT_OWNER_BACKUP`（主人2） / `BOT_ADMINS` 同样是写死的身份，命令无法降级它们。

**主人专属**（所有者与主人都有，不下放给管理员）：`#授权`（增删主人仅所有者）、`#拒绝授权` / `#取消授权`、`#换名` / `#换头像`、`#接管` / `#恢复AI`、`#同意` / `#拒绝`（审批）。

---

## AI Agent（工具调用）

小钠不只是聊天——她是一个**会自己调工具的 agent**：模型在回复前可自主决定调用哪些工具、拿到结果后再组织语言（多步循环，最多 5 步）。走的是服务商的原生 function calling（`deepseek-flash` 已支持）。

工具**按提问者身份开放**（对应身份对应调用）：模型只看得到你有权用的工具，执行时再校验一次，越权直接拒绝。

| 工具 | 作用 | 最低身份 |
|---|---|---|
| `web_search` | 联网搜索实时信息（天气/新闻/比分等） | 普通用户 |
| `mc_status` | 查 MC 服务器状态与在线玩家 | 普通用户 |
| `player_query` | 查某玩家的 Plan 数据 | 普通用户 |
| `remember` / `recall_memory` | 写入 / 检索长期记忆 | 普通用户 |
| `ai_balance` | 查 AI 账户余额（账务） | 管理员 |

> 需联网搜索时，需在 `.env` 配 `BAIDU_SEARCH_KEY`；未配则搜索工具不开放给模型。工具清单与身份映射见 `agent.js`。

---

## 使用方式

- **群里**：@ 小钠 或消息里含「小钠」即触发 AI；**引用机器人自己的消息**回复时无需 @。
- **私聊**：直接对话即触发。
- **命令**：以 `#` 或 `/` 开头、或含 `#命令` 的消息按命令处理；命令优先于 AI，认不出的命令不拦截 AI。
- **游戏内**：`/xn <内容>` 私聊小钠；公聊带关键词的消息也会转发进 QQ 群。

### 常用命令

| 分类 | 命令 |
|---|---|
| 基础 | `#帮助` `#状态` `#查询 <玩家名>` `#mc <地址>` `#申请授权` |
| 绑定 | `#绑定 <游戏ID>` `#我的绑定` `#解绑 <游戏ID\|all>` `#强制解绑 <QQ号> [游戏ID]` |
| 记忆 | `#记住 <内容>` `#记忆 [关键词]` `#忘记 <序号>` `#清除记忆` |
| 群管 | `#禁言` `#解禁` `#踢出` `#拉黑` `#全体禁言` `#群公告` |
| 定时 | `#定时提醒` `#定时禁言` `#定时解禁` `#定时列表` `#取消定时` |
| 主人 | `#授权 [@或QQ] [等级]` `#拒绝授权` `#取消授权` `#余额` `#余额矫正` `#换名` `#换头像` `#接管` `#恢复AI` `#同意` `#拒绝` |
| 工具 | `#截图` `#shot <网址>` `#聊天记录 <QQ号 或 @某人> <文案>` |

完整说明见群内 `#帮助 <分类>`。

---

## 端口复用与真实 IP

- 服务端把 MC 的实际绑定挪到内部端口（`internalPort`），对外只保留 `sharePort`；`PortMux` 按首字节区分 **HTTP**（面板）与 **Minecraft 握手**后分流。
- 这样即使服务商只放行一个端口，也能同时开 MC 与面板。
- 复用后 MC 侧看到的所有对端都是 `127.0.0.1`；本机通过「上游本地端口 → 真实 IP」映射还原真实地址，服务端侧则由 `ClientConnectionMixin` 在 `getAddress()` 出口处替换，使控制台、日志、封禁等也能看到**真实 IP**。

---

## 运维与开发

### 健康检查

`GET /health` **不需要登录**（面板未配置 `WEBUI_PASSWORD` 时不启动，该端点也不可用）：

```json
{ "status": "ok", "uptime": 123,
  "bot":      { "connected": true },
  "mcBridge": { "configured": true, "connected": true },
  "ai":       { "enabled": true, "reachable": true },
  "timestamp": "2026-10-02T15:01:35.463Z" }
```

一切正常返回 `200`；机器人掉线、或 MC 桥已配置却未连上时返回 **503**。
`ai.reachable` 是轻量探测（结果缓存 60 秒），**不返回**任何密钥、URL、QQ 号、群号。

### 面板 HTTP / HTTPS

- **默认走 HTTP**（`http://<主机>:80`），最简单，没有证书提示。HTTPS 代码完整保留在 `src/tls.js`，想切回去只要在 `.env` 设 `WEBUI_HTTPS=true`（默认端口随之变为 443）。
- HTTPS 模式首次启动用 openssl 在 `data/tls/` 生成一套**本地根 CA**（`ca.crt` / `ca.key`，10 年），再由它签发**服务器证书**（`cert.pem` / `key.pem`，397 天，对齐 Chrome 上限），之后复用，剩不到 30 天自动重签。
- HTTPS 模式启动时自动把根 CA 装进 **当前用户 → 受信任的根证书颁发机构**（`certutil -user -addstore Root`），Chrome / Edge / IE 直接信任，**不再提示「不安全」**。不想改系统证书库时设 `WEBUI_TLS_TRUST=false`。
- **Firefox 用自己的证书库**，不读 Windows 的：设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → 导入 `data/tls/ca.crt`，勾选「信任由此颁发机构标识的网站」。局域网其它设备访问也需各自导入这张 `ca.crt`。
- HTTPS 模式下老地址 HTTP（默认 80）自动 308 跳到 HTTPS；已有 nginx 等做跳转时把 `WEBUI_HTTP_PORT` 设为 `0`。HTTP 模式不启用跳转。
- 生成证书需要 openssl：Windows 装 Git for Windows 即有；找不到时用 `.env` 的 `OPENSSL_BIN` 指定 `openssl.exe` 完整路径。
- 注意：HTTP 是明文。浏览器只在 `localhost` 或 HTTPS 下允许网页调用麦克风，所以局域网用 `http://<IP>` 打开面板时，试用页的语音按钮不可用；需要局域网语音就切回 HTTPS。

### 试用与兼容页

- **`/trial`（登录前可用）**：无需登录直接跟小钠私聊。身份是普通用户「小锂」（虚拟 QQ，不碰真实账号），300 字上限、语音需要登录；限速按浏览器 20 条 / 10 分钟、按 IP 50 条 / 10 分钟、消息间隔 1.2 秒、全局并发 2，防止被白嫖 AI 额度。
- **面板内「私聊试用」**：登录后同一套对话按**所有者**身份执行——套用 `.env` 的 `BOT_OWNER` 信息，`#命令` 按所有者权限跑，500 字、不限速。
- 两种身份的会话互相隔离（`owner:` / `guest:` + 浏览器标识），互不清扰；「清空」会同时清掉两者。
- **老旧浏览器**：`web/index.html` 头部会用 ES5 探测 `async` / `?.` / `??` / `fetch` / `Promise`，任一不支持就自动 `location.replace('/legacy')`。`/legacy` 是纯 ES5 + XHR 的精简页（状态 / 登录 / 试用），现代浏览器不受影响，照常使用完整面板。

### 日志

三处同步输出，级别由 `LOG_LEVEL` 控制：

| 去处 | 说明 |
|---|---|
| 终端 | 等宽字体没有 emoji 字形，表情会被替换成 `[表情]`，保证一定看得见 |
| 网页面板 | 实时日志流（保留 emoji，浏览器可正常渲染） |
| 文件 | `logs/YYYY-MM-DD.log`，按天滚动，不入库 |

### 记忆存储

会话记忆存在 `data/memory.db`（SQLite，由 Node 内置的 `node:sqlite` 驱动，**不需要编译原生模块**）：

- 全文搜索用 **FTS5 + trigram 分词**；中文查询需 **≥ 3 个字符**，更短的自动回退 `LIKE`。
- 首次启动若发现旧的 `data/memory.json`，会**一次性导入并保留原文件**作为回滚点。
- `data/` 已在 `.gitignore` 中排除。

### 宽松限速

定位是**正常聊天几乎无感**，只对异常刷屏动手。核心区别是「排队」而不是「拒绝」：

| 层级 | 限制 | 超了会怎样 |
|---|---|---|
| 用户 | 2 秒冷却、8/分 | **静默排队**，等够了自动回（用户只感觉"回得稍慢"） |
| 用户 | 60/时、200/日 | 额度用满才提示（"歇一会儿" / "明天再来"） |
| 群 | 20/分、200/时 | 静默排队；私聊不参与群级限速 |
| 全局 | 并发 3、30/分 | 用**信号量**控制，多出来的 FIFO 排队 |
| 全局 | 队列 15、排队超时 20 秒 | 队列满或等太久才提示"稍后再试" |

反刷屏（两层，都按 QQ 记，带过期时间）：

- **连续超限 5 次** → 冷却 30 秒；
- **10 秒内请求 ≥ 15 次** → 禁言 5 分钟。

惩罚期间**静默丢弃**（不回复，避免跟刷屏的人对话）。计数用**滑动窗口**（时间戳回溯计数），
不是固定窗口——固定窗口在整点边界会放行两倍的量。限额按会话串行，避免同一会话两条回复交叉。

### 成本优化

| 手段 | 做法 | 效果 |
|---|---|---|
| **前缀缓存** | system prompt 在整个会话里**字节不变**（时间/QQ/群号/消息内容全部放 user 消息，绝不进 system） | 实测每次约 **5.6k tokens 命中缓存**，价差可达数十倍 |
| **限制输出** | 按输入类型给 `max_tokens`：短问答 300 / 闲聊 512 / 长文 1200，**绝不省略该参数** | 输出 token 是成本大头，杜绝模型长篇大论 |
| **`user` 透传** | 把提问者 QQ（游戏内是玩家名）作为 `user` 传给服务商，用于 KV 缓存隔离 | 同一个人的连续对话更容易命中前缀缓存 |
| **闲时调度** | 语音缓存清理、记忆过期清理安排在**工作日 9-12、14-18 之外**执行 | 高峰把资源让给实时对话 |

> 说明：缓存优化与限速在高峰同样生效；闲时调度只管"可延后的维护活儿"，不涉及实时回复。

### 常用命令

```bat
npm start          启动机器人
npm run dev        开发模式（改 prompt.txt / .env 或源码自动重启）
npm run lint       代码检查（ESLint 9）
npm run lint:fix   自动修复可修复的问题
npm run format     格式化（Prettier 只作用于新增文件，存量代码保持原样）
npm test           跑单元测试（Vitest）
```

---

## 安全说明

- `.env` 已在 `.gitignore` 中排除，**不会入库**；请勿把密钥写进代码或模板文件。
- 面板默认走 HTTP，可选 HTTPS（本地根 CA 签发 + 自动装进当前用户受信任根证书），默认要求登录（账号密码 + 图形验证码），连续失败 5 次锁定 5 分钟，密码采用固定时间比较；`WEBUI_PASSWORD` 为空时面板直接不启动。
- 本机 ↔ 服务端使用 HMAC-SHA256 签名（含时间戳与 nonce），`bridge.secret` 不足 32 位则桥拒绝启动。
- `push.bat` 从 `.env` 读取 GitHub token，通过一次性 HTTP 头传给 git，**不写入 `.git/config`、不出现在输出中**。

---

## 许可证

见仓库根目录的 [LICENSE](LICENSE) 文件。