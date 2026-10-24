# 给下一个接手本项目的 AI

## 0. 最重要的一条：改完自己提交并推送，不要等用户开口

用户明确要求过「下次自动提交」。做完一件事就立刻提交推送，**别问、别攒**。

- 提交：`git add <具体文件…>` —— **不要用 `git add -A` / `git add .`**，仓库里有 `_tk_repro.mjs` 之类的临时文件，不该进版本库
- 推送：在 `c:\QQBot` 目录下执行 `.\push.bat`（读 `.env` 里的 `GITHUB_TOKEN` / `GITHUB_REPO` 推到 GitHub）
- 提交信息：`git commit -m "标题" -m "正文"`
- **改完重启机器人**：在 `c:\QQBot` 执行 `.\restart.bat`。它会自提权、结束旧的 `start.js` 进程树（连同 NapCat / bot），注册并运行计划任务 `XiaonaBot`，以**隐藏窗口**在后台启动 —— 不需要用户再开控制台。

## 1. 环境坑（先看，能省很多时间）

- **PowerShell 不支持 `&&`**，多条命令用 `;` 分隔。
- **PowerShell 不支持 bash heredoc**（`$(cat <<'EOF')`），提交信息用 `-m` 传。
- 不要用 `cmd /c push.bat`（会被安全策略拦），直接 `.\push.bat`。
- 查 MC 原版 API 用 `C:\Program Files\Java\jdk-21\bin\javap.exe`（不在 PATH），classpath 必须用 **yarn 命名**的 jar：
  `C:\Users\iflytek\.gradle\caches\fabric-loom\minecraftMaven\net\minecraft\minecraft-merged\1.21.11-net.fabricmc.yarn.1_21_11.1.21.11+build.6-v2\minecraft-merged-1.21.11-net.fabricmc.yarn.1_21_11.1.21.11+build.6-v2.jar`
  （`caches\fabric-loom\1.21.11\minecraft-merged.jar` 是 official 混淆名，别用）

## 2. 项目构成

| 部分 | 位置 | 说明 |
|---|---|---|
| QQ 机器人 | `c:\QQBot`（Node） | NapCat + OneBot 11。AI 对话、游戏ID绑定、MC 桥接 |
| MC 服务端 mod | `c:\QQBot\xiaona-mod` | Fabric 1.21.11 / Java 21，跑在 Minecraft 服务器上 |

## 3. 架构与数据流（理解这个才不会做错设计）

服务商只放行**一个对外端口**，所以 [PortMux](file:///c:/QQBot/xiaona-mod/src/main/java/com/xiaona/PortMux.java) 让「MC 的 TCP」和「桥的 HTTP」共用同一个端口（玩家照旧用原地址进服）。MC 实际绑到内部端口，由 [PortRelocator](file:///c:/QQBot/xiaona-mod/src/main/java/com/xiaona/PortRelocator.java) 换掉。

**mod 是 HTTP 服务端，bot 是客户端**：

- bot 主动 POST 调 mod 的接口（`/bridge/send`、`/bridge/players`、`/bridge/bindcheck`、`/bridge/whitelist`…）
- bot 还长期挂着 `GET /bridge/stream` 这条 **SSE** 长连接接收游戏事件

**关于"服务端能不能问 bot"——能，别再说不能。** 这是本项目踩过的坑：早先的判断是"服务端没法反向询问"，错的。SSE 虽然是单向的（mod→bot），但 bot 手上另有一条反向的 HTTP 通道，所以 mod 要"问" bot 时：

1. mod 顺着 SSE 推一条事件，事件里带上请求 id（如 `whitelist_query`）
2. bot 收到后用 HTTP POST 把答案回给 mod（如 `/bridge/whitelist_response`）

## 4. 白名单模式（最近改得最多，先读这块）

`config.json` 的 `whitelist` 段（`enabled` / `group` / `kickMessage`）。开启后：**弃用计分板**、启动时强制 `setUseAllowlist(true)`。

进服判定落在 [PlayerManagerMixin](file:///c:/QQBot/xiaona-mod/src/main/java/com/xiaona/mixin/PlayerManagerMixin.java)（拦 `PlayerManager#checkCanJoin`，就是原版查白名单、回 `multiplayer.disconnect.not_whitelisted` 的地方）：

1. 先过**服务器自己的白名单**——已在白名单 / 原版白名单没开 → 交还原版，不干预
2. 不过（不在白名单）→ 查 [WhitelistGate](file:///c:/QQBot/xiaona-mod/src/main/java/com/xiaona/WhitelistGate.java) 的**缓存**（bot 主动推来的绑定名单，即时热加载）
3. 缓存未命中 → **实时询问 bot**（SSE 推 `whitelist_query` + 等 `/bridge/whitelist_response`，超时 3 秒）
4. 在绑定名单里 → 补进原版白名单 + 放行；不在 → 按 `kickMessage`（含群号）踢出

bot 侧：[binding.js](file:///c:/QQBot/binding.js) 绑定/解绑后 `notifyChange` → [index.js](file:///c:/QQBot/index.js) 推 `pushWhitelist`；连上桥时 `pushWhitelistAll` 推整张名单。

**注意**：`checkCanJoin` 是**同步方法**，做实时询问只能阻塞登录线程（限 3 秒，超时回退缓存）。另外原版 `ServerConfigList.add/remove` **自己就会 `save()`**，所以白名单增删本来就落盘。

## 5. 常用命令

```powershell
# mod：构建（产物 build\libs\xiaona-mod-<ver>.jar）/ 跑测试
cd c:\QQBot\xiaona-mod; .\gradlew.bat build; .\gradlew.bat test

# bot：测试（vitest，约 112 用例）/ 静态检查
cd c:\QQBot; npm test; npx eslint <file>

# 推送
cd c:\QQBot; .\push.bat

# 重启机器人（后台隐藏运行；同时保证开机自启任务已注册）
cd c:\QQBot; .\restart.bat
```

- 后台隐藏启动：`background.vbs`（wscript 调用，未提权会自动弹一次 UAC；`restart.bat` 与计划任务都走它）。
- **后台隐藏运行没有可交互终端**：`start.js` 检测到 `stdin` 不是 TTY 时**不会**进手动登录（否则会永远卡在等待输入，NapCat 起不来 → 面板一直显示连不上 3001），而是直接用二维码模式把 NapCat 跑起来，二维码在网页面板看。快速登录失败但已出二维码/需要验证时也**不杀** NapCat 进程。
- **语音识别服务（FunASR）现在由启动器自动拉起**：`start.js` 启动时检查 `ASR_URL` 的端口（默认 8899），没在跑就用 `asr-venv\Scripts\funasr-server.exe --host 127.0.0.1 --port 8899 --model sensevoice --device cpu` 隐藏启动；端口已被占用（手动跑了 `startASR.bat`）就跳过。venv 在项目内 `asr-venv`（已 gitignore），依赖：CPU 版 torch/torchaudio + funasr/fastapi/uvicorn/python-multipart。**FunASR 1.4+ 的模型名必须写它自己注册的 `sensevoice`（或 `paraformer` 等），写 ModelScope 的 `iic/SenseVoiceSmall` 会被 400 拒绝**。首次运行会下载约 1GB 模型到 `~/.cache/modelscope`。
- `restart.bat` 除了结束 `start.js` 进程树，还会清理**残留的 NapCat**（手动启动或上次没退干净的）。残留进程占着 3001 时，新 NapCat 绑不上端口，机器人就会一直 `ECONNREFUSED 127.0.0.1:3001`。
- 开机自启：计划任务 **`XiaonaBot`**（登录时触发，延迟 30 秒，最高权限），动作为 `wscript.exe "C:\QQBot\background.vbs"`。
  排查：`schtasks /query /tn "XiaonaBot" /v /fo LIST`（需管理员）；删除：`schtasks /delete /tn "XiaonaBot" /f`。

## 6. 约定与文件地图

- 版本号在 [xiaona-mod/build.gradle](file:///c:/QQBot/xiaona-mod/build.gradle)，**每次加功能递增**。
- 注释、日志、提交信息一律用**中文**（用户偏好）。
- bot：`index.js` 入口与命令分发、`agent.js`（AI 工具调用 agent：工具注册 + 按身份过滤 + 循环）、`aiService.js`（服务商/模型/请求，含 `chatCompletionRaw`）、`binding.js` 游戏ID绑定、`permission.js` 授权与等级、`mcbridge.js` MC 桥客户端、`chatSettings.js`（会话级设置：群/私聊各自覆盖全局，落盘 `data/chat-settings.json`）、`asr.js`（语音识别：调**本地 FunASR/SenseVoice** 的 OpenAI 兼容接口，服务由 `start.js` 自动拉起（venv 在 `asr-venv`，也可手动跑 `startASR.bat` 看日志）；**amr/silk 会先经 `setAudioConverter` 注入的 NapCat `get_record(out_format=wav)` 转码**，识别结果再按 config.json 的 `asr.homophones` 做**同音纠正**把小娜/小纳改回小钠）、`tts.js`（语音合成：`TTS_PROVIDER` 切换后端。默认 **小米 MiMo TTS**（`mimo-v2.5-tts`，OpenAI 兼容 `POST https://api.xiaomimimo.com/v1/chat/completions`，目标文本放 `role=assistant`，文本开头写 `(风格)` 标签控制语气、写 `(唱歌)` 可唱歌，返回 `choices[0].message.audio.data` base64；密钥 `.env` 的 `MIMO_API_KEY`，音色 `TTS_XIAOMI_VOICE` 默认 `冰糖`）；配不到 key 或 `TTS_PROVIDER=edge` 时回退**微软 Edge 朗读服务**（协议同 Python 的 `edge-tts`，音色/语速/音量读 `TTS_VOICE`/`TTS_RATE`/`TTS_VOLUME`，`edgeDrm.js` 是它的 Sec-MS-GEC v2 令牌算法）。送进 TTS 前统一用 `stripEmoji` 去掉 emoji/颜文字，语音里不带表情）、`edgeDrm.js`（**Edge TTS 的 DRM 令牌**：v2 格式为「16 位 CS64-64 位 SHA256」，两段哈希都是微软魔改版，逐位移植自 edge-tts 的 `drm.py`；改这里要拿 Python `edge-tts` 的 `generate_sec_ms_gec_v2` 对拍）、`help.js` 帮助文案、`prompt.txt` AI 人设、`push.bat` 推送、`restart.bat` 重启（自提权 + 注册计划任务 + 隐藏启动）、`background.vbs` 隐藏窗口启动器（开机自启任务调用它）。
- **配置分工**：`.env` 放密钥/账号/开关等部署项；**数值类可调项（限速、冷却、唤起会话）与「会话层全局默认（chat：是否回复/关键词/语音/补充提示词）放 `config.json`**，由 `config.js` 读取（支持 `//` 注释，缺字段自动兜底）。改这些数值请改 config.json，不要再往 .env 加 `RL_*` / `FORWARD_*`。
- **可切换后端（都在 config.json，网页「全局设置」可改，热加载即生效）**：
  - `search`：`provider` = `off`/`baidu`/`deepseek`/`custom`，`limit`、`customUrl`。deepseek 复用 `.env` 的 `AI_API_KEY`（`POST https://api.deepseek.com/v1/tools/search`，{query,count}）；baidu 用 `BAIDU_SEARCH_KEY`（千帆 ai_search，**不要传 model**，否则走没权限的智能总结模式）；custom 用 `SEARCH_CUSTOM_KEY`。
  - `vision`：`provider` = `ai`（主模型）/`custom`（OpenAI 兼容 /chat/completions，支持 image_url）/`off`，`customUrl`、`customModel`；密钥 `VISION_CUSTOM_KEY`。
  - `bridge`：`mode` = `''`（用 `.env` 的 `MC_BRIDGE_URL`）/`off`/`loopback`/`lan`/`public`，`port`、`lanHost`、`publicUrl`。切换由 `index.js` 的 `applyLiveConfig()` → `applyBridgeConfig()` 热重连（mcbridge.js，`bridgeTargetOf` 是算地址的纯函数）；密钥/桥接群仍看 `.env`。
- **网页「会话管理」**：把 `接管` 页换成会话管理（群聊/单聊两块），每个会话可覆盖全局设置（AI是否回复/触发关键词/语音/补充提示词/限流·冷却·唤起数值/**进出群提醒开关与文案**），留空即用全局。提醒只有群聊能配，文案支持占位符 `{name}`/`{kind}`/`{note}`（见 config.json 的 `notice` 段，全局默认也在那）。后端接口 `/api/chat-settings`（GET 列表+全局、POST 存某会话覆盖）与 `/api/global-config`（GET/POST config.json，写后热加载）。会话 key 仍是 `g:群号` / `p:QQ号`。
- mod：`XiaonaMod`（入口/接线）、`Config`、`BridgeServer`（全部 HTTP 接口）、`McEvents`（事件队列 + SSE + 注入）、`BindBoard`（未绑定玩家计分板）、`WhitelistGate`（白名单模式）、`BotState`（日志）、`mixin/`（`ServerNetworkIoMixin` / `ClientConnectionMixin` / `PlayerManagerMixin`）。

## 7. 变更前请验证

改完至少跑：`.\gradlew.bat build`（含单测）+ `npm test`。动了 bot 文件再补 `npx eslint <file>`。
