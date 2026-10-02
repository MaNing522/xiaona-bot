# 小钠 QQ 机器人 · xiaona-bot

基于**真实 QQ 账号**的群聊机器人，外加一个 **Minecraft Fabric 服务端模组**，把 QQ 群和游戏内聊天双向打通。

- **本机（Windows）**：QQ 登录（NapCat / OneBot11）、AI 回复、联网搜索、语音、截图、网页控制面板、QQ ↔ 游戏ID 绑定、完整的命令系统。
- **服务端（Fabric 1.21.11）**：把游戏事件（聊天 / 进出服 / 死亡 / 成就）推给本机，接收本机投递的文本；**与 MC 共用同一个端口**（端口复用），即使服务商只放行一个端口也能用。

> 本仓库不含 NapCat 本体（体积大，已在 `.gitignore` 中排除），需自行下载后放到 `napcat/` 目录。

---

## 系统架构

```
        QQ 群 / 私聊                          游戏内玩家
             │                                     │
             ▼                                     ▼
   NapCat (OneBot11, ws://127.0.0.1:3001)   Fabric 模组 xiaona（服务端）
             │                                     │
             └──────────────┬──────────────────────┘
                            ▼
                   本机 Node 机器人（index.js）
                   ├─ AI 回复（DeepSeek）+ 记忆
                   ├─ 联网搜索 / 语音 / 截图
                   ├─ 命令系统 / 定时任务 / 权限
                   ├─ 网页控制面板 :8080
                   └─ 加签 HTTP + SSE  ◄──►  服务端 mod（端口复用，共用一个对外端口）
```

- QQ 与 AI **全部在本机运行**；服务端只运行一个轻量桥。
- 本机 ↔ 服务端之间用 **HMAC-SHA256 签名**通信（时间戳 + nonce 防重放）。

---

## 功能特性

- **AI 对话**：群聊 @ 或含「小钠」关键词触发；私聊直接对话；支持会话记忆与联网搜索。
- **联网搜索**：接入百度智能搜索（千帆 ai_search），小钠自己判断何时需要搜索（无手动命令）。
- **QQ ↔ 游戏ID 绑定**：群里发 `#绑定 <游戏ID>`，过图形验证码即可把群里消息转发进游戏（每人最多 3 个）。
- **游戏桥**：双向聊天转发、进出服/死亡/成就提示、游戏图片转 QQ 真图、公聊限速与重复内容屏蔽。
- **网页控制面板**：登录鉴权 + 图形验证码 + 登录限速；可查看状态、管理权限、以机器人身份发消息、开关功能、人工接管。
- **命令系统**：`#帮助` 分类菜单，覆盖绑定、记忆、群管、定时、主人、工具等。
- **文字转语音**、**屏幕/网址截图**、**MC 服务器状态查询**、**定时提醒/定时禁言**。
- **进群/好友申请审批**：转发给主人，引用通知回复「同意 / 拒绝」即可（绝不自动同意）。
- **端口复用**：HTTP 面板与 MC 同端口共存；并让服务端也能拿到玩家**真实 IP**。

---

## 目录结构

```
QQBot/
├─ index.js             机器人主程序（消息处理、AI、命令）
├─ start.js             启动器（拉起 NapCat + 机器人 + WebUI）
├─ webui.js             网页控制面板（登录 / 权限 / 开关 / 接管）
├─ mcbridge.js          与服务器 mod 的加签通信（HTTP + SSE）
├─ binding.js           QQ ↔ 游戏ID 绑定（验证码）
├─ memory.js            会话记忆            permission.js  主人/管理员/授权
├─ help.js              #帮助 菜单           scheduler.js   定时任务
├─ search.js            联网搜索（百度智能搜索）
├─ tts.js               文字转语音（玉峰）   screenshot.js  屏幕 / 网址截图
├─ mc.js                MC 服务器状态        captcha.js / shake.js / state.js
├─ web/index.html       控制面板页面
├─ prompt.txt           机器人人设提示词（改完保存即热更新）
├─ push.bat             用 .env 里的 token 推送到 GitHub
├─ .env.example         配置模板（复制为 .env 填写；.env 不入库）
└─ xiaona-mod/          Minecraft Fabric 服务端模组（Java）
   └─ src/main/java/com/xiaona/  ·  src/main/resources/
```

---

## 环境要求

| 组件 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| 运行时 | Node.js ≥ 18 |
| QQ | 一个真实 QQ 账号（作机器人）；NapCat 自备 |
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

或 `npm start`。首次启动会提示登录 QQ：**密码登录用 ANDROID_PAD，扫码登录用 ANDROID_WATCH**。

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

| 分组 | 关键项 | 说明 |
|---|---|---|
| NapCat | `NAPCAT_WS` / `NAPCAT_TOKEN` | OneBot11 连接地址与 token |
| NapCat 面板 | `NAPCAT_WEBUI_TOKEN` / `NAPCAT_WEBUI_JWT_SECRET` | 固定面板密码与会话密钥，避免重启掉登录 |
| 身份 | `BOT_OWNER` / `BOT_ADMINS` | 主人（可执行 `/授权`）、管理员 |
| AI | `AI_API_URL` / `AI_API_KEY` / `AI_MODEL` | 默认 DeepSeek |
| 搜索 | `BAIDU_SEARCH_KEY` | 百度智能搜索密钥（千帆 ai_search）；不填则联网搜索关闭 |
| 语音 | `TTS_VOICE_ID` | 玉峰语音合成（kktts，免密钥）；音色 ID 默认甜妹音，列表见 `kktts.php?action=list` |
| 余额基数 | `AI_BALANCE_RECHARGE_BASE` / `AI_BALANCE_GRANT_BASE` / `AI_BALANCE_USED_BASE` | `#余额` 的累计充值/已使用基数（元）；留空则自首次查询起记账 |
| 面板 | `WEBUI_HOST` / `WEBUI_PORT` / `WEBUI_USER` / `WEBUI_PASSWORD` | 密码留空则面板不启动 |
| MC 桥 | `MC_BRIDGE_URL` / `MC_BRIDGE_SECRET` / `MC_BRIDGE_GROUP` | 桥地址、签名密钥、桥接群号 |
| MC 桥开关 | `MC_BRIDGE_MC_TO_QQ` / `MC_BRIDGE_QQ_TO_MC` / `MC_BRIDGE_OP_RELAY` / `MC_BRIDGE_GAME_IMAGE` | 各方向开关 |
| MC 桥限流 | `MC_BRIDGE_CHAT_RATE_MAX` / `MC_BRIDGE_CHAT_RATE_WINDOW_SEC` / `MC_BRIDGE_DUP_MAX` / `MC_BRIDGE_DUP_TTL_SEC` | 公聊限速与重复屏蔽 |
| 行为 | `BOT_REPLY` / `QQ_GROUP_NOTICE` / `POKE_REPLY` / `QQ_REQUEST_APPROVE` | 机器人消息、进出群提示、戳一戳、申请审批 |
| 绑定 | `BIND_MAX_PER_QQ` / `BIND_CAPTCHA_TTL` | 每人可绑数量、验证码有效期 |

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
| 主人 | `#授权` `#拒绝授权` `#取消授权` `#余额` `#换名` `#换头像` `#接管` `#恢复AI` `#同意` `#拒绝` |
| 工具 | `#截图` `#shot <网址>` |

完整说明见群内 `#帮助 <分类>`。

---

## 端口复用与真实 IP

- 服务端把 MC 的实际绑定挪到内部端口（`internalPort`），对外只保留 `sharePort`；`PortMux` 按首字节区分 **HTTP**（面板）与 **Minecraft 握手**后分流。
- 这样即使服务商只放行一个端口，也能同时开 MC 与面板。
- 复用后 MC 侧看到的所有对端都是 `127.0.0.1`；本机通过「上游本地端口 → 真实 IP」映射还原真实地址，服务端侧则由 `ClientConnectionMixin` 在 `getAddress()` 出口处替换，使控制台、日志、封禁等也能看到**真实 IP**。

---

## 安全说明

- `.env` 已在 `.gitignore` 中排除，**不会入库**；请勿把密钥写进代码或模板文件。
- 面板默认要求登录（账号密码 + 图形验证码），连续失败 5 次锁定 5 分钟，密码采用固定时间比较；`WEBUI_PASSWORD` 为空时面板直接不启动。
- 本机 ↔ 服务端使用 HMAC-SHA256 签名（含时间戳与 nonce），`bridge.secret` 不足 32 位则桥拒绝启动。
- `push.bat` 从 `.env` 读取 GitHub token，通过一次性 HTTP 头传给 git，**不写入 `.git/config`、不出现在输出中**。

---

## 许可证

见仓库根目录的 [LICENSE](LICENSE) 文件。