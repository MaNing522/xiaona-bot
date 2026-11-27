# 给下一个接手本项目的 AI

## 0. 最重要的一条：改完自己提交并推送，不要等用户开口

用户明确要求过「下次自动提交」。做完一件事就立刻提交推送，**别问、别攒**。

- 提交：`git add <具体文件…>` —— **不要用 `git add -A` / `git add .`**，仓库里有 `_tk_repro.mjs` 之类的临时文件，不该进版本库
- 推送：在 `c:\QQBot` 目录下执行 `.\push.bat`（读 `.env` 里的 `GITHUB_TOKEN` / `GITHUB_REPO` 推到 GitHub）
- 提交信息：`git commit -m "标题" -m "正文"`
- **改完重启机器人**：在 `c:\QQBot` 执行 `.\restart.bat`。它会自提权、结束旧的 `start.js` 进程树（连同 SnowLuma / bot），顺带删除旧的 `XiaonaBot` 计划任务（**已取消开机自启**），再以**隐藏窗口**在后台启动 —— 不需要用户再开控制台。

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
| QQ 机器人 | `c:\QQBot`（Node） | SnowLuma（注入桌面 QQ）+ OneBot 11。AI 对话、游戏ID绑定、MC 桥接 |
| MC 服务端 mod | `c:\QQBot\xiaona-mod` | Fabric 多版本（1.21.11 / 1.21.8 / 1.21.1），Java 21，跑在 Minecraft 服务器上 |

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

bot 侧：[binding.js](file:///c:/QQBot/src/binding.js) 绑定/解绑后 `notifyChange` → [index.js](file:///c:/QQBot/src/index.js) 推 `pushWhitelist`；连上桥时 `pushWhitelistAll` 推整张名单。

**注意**：`checkCanJoin` 是**同步方法**，做实时询问只能阻塞登录线程（限 3 秒，超时回退缓存）。另外原版 `ServerConfigList.add/remove` **自己就会 `save()`**，所以白名单增删本来就落盘。

## 5. 常用命令

```powershell
# mod：构建全部 Fabric 版本（根项目 1.21.11 + 子项目 1.21.1 / 1.21.8）
cd c:\QQBot\xiaona-mod; .\gradlew.bat build
# 只构建某个版本：.\gradlew.bat :fabric-1.21.1:build（或 :fabric-1.21.8:build）
# 根项目单测：.\gradlew.bat test

# bot：测试（vitest，约 112 用例）/ 静态检查
cd c:\QQBot; npm test; npx eslint <file>

# 推送
cd c:\QQBot; .\push.bat

# 重启机器人（后台隐藏运行；不再注册开机自启）
cd c:\QQBot; .\restart.bat
```

- 后台隐藏启动：`background.vbs`（wscript 调用，未提权会自动弹一次 UAC；`restart.bat` / `启动.bat` 都走它）。
- **AI 用工具跑 `.\restart.bat` 的坑（2026-10-30 实测）**：起服后的 `node start.js` 仍挂在「执行重启的那条命令」的进程树下，命令一结束就被连坐杀掉（表现为重启成功、日志也正常，但几分钟后机器人凭空消失、80/3001 端口全空）。稳定做法是用**计划任务**把它摘出去（需管理员，先建后删，不留在系统里）：
  ```powershell
  schtasks /create /tn "XiaonaTmpStart" /tr "wscript.exe C:\QQBot\background.vbs" /sc once /st 23:59 /rl highest /f
  schtasks /run /tn "XiaonaTmpStart"
  schtasks /delete /tn "XiaonaTmpStart" /f        # 等 wscript 把 node 拉起来后再删（约 8 秒）
  ```
  验证：用管理员 PowerShell 读 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 的 `CommandLine`（普通权限读不到管理员进程的命令行，会全空）；同时看 `logs/YYYY-MM-DD.log` 里有没有新的「=== 功能状态」。
- **SnowLuma（2026-10 起替代 NapCat）**：它是注入**真实桌面 QQ.exe** 的 OneBot v11 框架，**只能扫码登录**，二维码显示在 QQ 自己的窗口里（不在网页）。启动器 `start.js` 会自动拉起 QQ（`QQ_PATH`，默认 `C:\Program Files\Tencent\QQNT\QQ.exe`；`QQ_AUTOLAUNCH=false` 可关）和 `snowluma/index.mjs`（cwd 必须是 `snowluma/`，配置目录相对 cwd），并设置 `SNOWLUMA_HOOK_AUTOLOAD=1` 让 QQ 登录后自动注入。QQ 没登录时 OneBot WS 不会监听，机器人会一直自动重连，属正常现象。**注意**：桌面 QQ 必须保持在机器人账号上（别让它自动登录成主人号）；QQ 退出或被换号后，SnowLuma 不一定能自己重新注入新开的 QQ——若 3001 端口长时间不恢复，直接 `.\restart.bat`，不要手动单跑 SnowLuma。
- **SnowLuma 版本与升级（2026-10-30：2.1.1）**：当前跑 **2.1.1**，要求 **Node `^24.22.1 || >=26.12.1`**（系统 Node 已从 24.20.0 升到 24.22.1；旧 Node 会让 SnowLuma 直接退出）。npm 上没有这个包，只能从 GitHub Releases 取；国内直连 `release-assets.githubusercontent.com` 基本不通，`ghproxy.net` 单连接只有 2–12 KB/s 且会限流，**用 16 路 range 分段并发能把聚合拉到 ~80KB/s**（临时脚本写法见下）。**用 lite 包就够了**：完整版多出来的只有内置 `node.exe`，而 `start.js` 始终用 `process.execPath`（系统 node）跑 `index.mjs`，根本不会用到它（全量 40.7MB、lite 6.5MB）。升级只替换程序文件、**保留 `snowluma/config/`、`data/`、`logs/`**：删掉除这三个目录以外的所有内容，再把新包解压进去即可（2.1.x 把 `config-*.js`/`server-*.js`/`logger-*.js`/`utils-*.js`/`package-lock.json` 全并进了单个 `index.mjs`，旧分块文件必须删干净）。**2.1.x 移除了旧的 probe-login API 路径**，依赖它的第三方适配器（Tulpa / MaiBotOneKey 等）要各自升级；本项目**不依赖**它（`start.js` 只改 `onebot.json` 再 `spawn(node, ['index.mjs'])`），升级后无影响。管理认证、协议确认（`SNOWLUMA_ACCEPT_EULA` / `SNOWLUMA_ACCEPT_PRIVACY`）与 OneBot 配置结构相对 2.0.3 兼容，`config/` 原样可读。
- **下载大文件的临时办法（国内网络）**：`curl.exe -s -L --http1.1 --ssl-no-revoke --max-time 300 -A "Mozilla/5.0" -r "<起>-<止>" -o partN.bin <url>`，用 `Start-Job` 起 16 个并发、按 `Content-Range` 的总大小切段，最后按序 `FileStream` 拼接并校验总字节数 + zip 可读。Node 的安装包走国内镜像 `https://npmmirror.com/mirrors/node/v<ver>/node-v<ver>-x64.msi`（单连接 ~80KB/s，16 路 53 秒下完 31.8MB），`msiexec /i <msi> /qn /norestart` 需提权。
- **SnowLuma 配置与 token**：`start.js` 会确保 `snowluma/config/onebot.json` 的 `ws-default` 为 `127.0.0.1:<ONEBOT_WS 端口>`、`messageFormat: array`、token = `.env` 的 `ONEBOT_TOKEN`（留空则沿用已有/自动生成并持久化）。已存在的 `onebot_<uin>.json`（snapshot 模式会完全覆盖全局）也会被同步同样的 host/port/token，否则换号后旧的端口/token 会把机器人挡在门外。SnowLuma 自己的控制台默认 `http://127.0.0.1:5099`（端口在 `snowluma/config/runtime.json`）。控制台密码与 OneBot token 是**两回事**：密码存 `snowluma/config/webui.json`（scrypt N=16384,r=8,p=1,keylen=64、16 字节 salt hex），`mustChangePassword:true` 时每次启动都会重新随机生成且只打印在 SnowLuma 控制台（隐藏启动看不到）；忘记密码就按同样参数重写该文件并把 `mustChangePassword` 置 `false`，再 `.\restart.bat`。
- **OneBot action 差异**：SnowLuma 把群公告叫 `_send_group_notice`（NapCat 是 `send_group_notice`），`index.js` 已做未知 action 时自动换名重试；其余用到的 action（`send_group_msg`/`get_record(out_format=wav)`/`set_group_ban`/`get_group_member_list` 等）均已确认存在。
- **权限一致性**：SnowLuma 与 QQ 的进程权限级别要尽量一致。当前启动链（`restart.bat` 自提权 → `background.vbs`）是管理员权限，`start.js` 代拉的 QQ 也会是管理员；如果用户手动开的普通权限 QQ 注入失败，先检查这一点。
- **语音识别（2026-11 起默认小米 MiMo，失败降本地 sherpa-onnx）**：`config.json` 的 `asr.provider` = `mimo`（默认）/ `local` / `custom`，网页「全局设置」可改、热加载生效。`mimo` 复用 `.env` 的 `MIMO_API_KEY`，`POST https://api.xiaomimimo.com/v1/chat/completions`，`model=mimo-v2.5-asr`，音频放 `messages[0].content[0].input_audio.data`（`data:audio/wav;base64,…`，只支持 wav/mp3），语种 `asr_options.language` = auto/zh/en（`asr.language`）。QQ 语音先经 SnowLuma 转 wav；没 Key / 4xx/5xx / 空结果 / 网络失败会**自动降级**到本地（`[ASR] … 改用本地识别` 日志按分钟限流）。本地服务（`sherpa-onnx`）由启动器自动拉起：`start.js` 检查 `ASR_URL` 的端口（默认 8899），没在跑就 `node src/asrSherpa.js --port 8899` 隐藏启动（日志写 `logs/asr-service.log`）；端口已被占用就跳过。服务对外仍是 OpenAI 兼容的 `POST /v1/audio/transcriptions`（multipart 的 `file` 字段，返回 `{text}`），所以 [asr.js](file:///c:/QQbot/src/asr.js) 不用改。依赖 `sherpa-onnx-node`（npm，含 `sherpa-onnx-linux-x64` / `win-x64` 预编译件），模型放 `models/`（**已 gitignore**）：默认 `models/sherpa-paraformer-zh-small`（`model.int8.onnx` 82MB + `tokens.txt`，实测 5.6s 音频 250–430ms、常驻约 210MB，1.7GB 小机器够用）；换 SenseVoice 只需改 `SHERPA_MODEL_DIR` + `SHERPA_MODEL_TYPE=sensevoice`（int8 约 239MB）。服务端自己解 wav（PCM 8/16/32bit、float32、多声道混单、重采样到 16k），非 wav 需要系统里有 `ffmpeg`。`ASR_ENGINE=funasr` 可退回旧的 `asr-venv` 实现（FunASR 1.4+ 模型名只能写 `sensevoice`/`paraformer`）。国内下模型走 `hf-mirror.com`（`csukuangfj/sherpa-onnx-*` 仓库），GitHub 直连不通。
- `restart.bat` 除了结束 `start.js` 进程树，还会清理**残留的 SnowLuma**（手动启动或上次没退干净的，按 3001 端口的 node 进程识别）。残留进程占着 3001 时，新 SnowLuma 绑不上端口，机器人就会一直 `ECONNREFUSED 127.0.0.1:3001`。**不要杀 QQ 进程**（保留登录态）。
- 开机自启：**已取消**（2026-10-26 起 `restart.bat` 不再注册计划任务 `XiaonaBot`，并会删除旧任务）。机器/重启后需要手动双击 `启动.bat`（或 `restart.bat`）拉起。若要恢复自启，可手动执行（需管理员）：
  `schtasks /create /tn "XiaonaBot" /tr "wscript.exe C:\QQBot\background.vbs" /sc onlogon /rl highest /delay 0000:30 /f`
- **Linux 服务器（生产环境）开机自启：靠 PM2，不靠 systemd 单元**。机器人由 `pm2 start start.js --name xiaona-bot` 托管（**不是** `deploy/linux/install.sh` 里的 `xiaona-bot.service`，那套别和 PM2 同时开，会抢 3001/80）；重启后自动恢复靠两件事：
  1. `pm2-root.service` 已 `enable`（`pm2 startup systemd -u root --hp /root` 生成），开机会跑 `pm2 resurrect`；
  2. `pm2 save` 写过 `~/.pm2/dump.pm2`。**改过 `pm2` 的启动参数/名字后必须重新 `pm2 save`**，否则重启还是旧配置。
  SnowLuma 是 Docker 容器，`RestartPolicy=unless-stopped`（`docker update --restart=unless-stopped snowluma` 可重设），所以 QQ 登录态随容器数据卷保留；ASR 由 `start.js` 每次启动自己拉起，不用单独守护。
  验证命令：`systemctl is-enabled pm2-root; pm2 list; docker inspect snowluma --format '{{.HostConfig.RestartPolicy.Name}}'; curl -s 127.0.0.1:8899/health`。
- **「机器人老掉线」先查服务器 swap（2026-11-14 踩过）**：阿里云镜像在 `/etc/sysctl.d/99-apsara-sysctl.conf` 里把 `vm.swappiness` 设成 `0`，1.7G 内存的机器上用满后内核不肯换出匿名页，只能反复踢页缓存再从磁盘重读 —— 表现为 `vmstat` 的 `wa` 90%+、`b` 40+、load 40+（但单进程 CPU 都很低），QQ/SnowLuma 被拖到每分钟掉线一次（bot 日志刷 `[连接] 已断开，3秒后重连…`）。已改为 `60`，写在 `/etc/sysctl.conf` 和 `/etc/sysctl.d/99-zzzz-swappiness.conf`（后者排序在 apsara 之后，防止被覆盖）。排查三连：`cat /proc/sys/vm/swappiness`、`vmstat 1 3`、`free -m`（看 Swap 是否 `used` 恒为 0）。

## 6. 约定与文件地图

- **小钠自己的 MC 客户端（2026-11 改为 headless 子进程）**：代码在 [src/mcheadless/](file:///c:/QQBot/src/mcheadless)（`headless.js` 主程序 + `baritone.js` 寻路/挖矿移植 + `altoclef/` 行为决策移植，独立 `package.json` 标 `type: commonjs`），源自仓库 `MaNing522/wclcmmlBOT`，**两边各存一份，改动要同时提交推送**。它默认 `MC_AUTOCONNECT=false`、不开自动进服，先起本机控制口 `127.0.0.1:2319`，由 [mcbot.js](file:///c:/QQBot/src/mcbot.js) 按需拉起子进程并通过 HTTP 下令：`join <host> [port] [version]` / `leave` / `goto <x> <y> <z>` 或 `goto <x> <z>` / `fly` / `get <物品> [数量]` / `mine <方块> [数量]`（`collect` 是它的别名） / `food [单位]` / `develop` / `pvp [玩家]` / `mace` / `follow` / `stop` / `xray` / `toss` / `map [半径]`（附近地形俯视 PNG） / `mapitem`（物品栏地图物品：先拿在手上等服务器下发 128×128 颜色表，再按原版 62 色 ×4 明暗渲染成 PNG） / `win`（列当前窗口槽位，玻璃板装饰自动隐藏） / `click <槽位>` / `use <槽位>`（右键手持物品，36-44 或 1-9）。**26.2 服务器的 `show_dialog` 验证题**（如 lblt.xyz 的「计算：一 + 二」）由客户端自动解析中文算式、挑对应答案的 `/lbltverify` 命令执行；`maybeCaptcha` 除 `captcha/验证码` 外还认「人机验证 / 手中地图 / 地图上的 N 位数字」。**行为决策照搬 AltoClef（Java → JS 直译）**：`altoclef/tasksystem.js` 是 `Task/TaskChain/TaskRunner/SingleTaskChain`，`tasks.js` 是赶路/挖方块/捡掉落/采矿/打猎任务，`chains.js` 是 `UserTaskChain`/`WorldSurvivalChain`（岩浆、着火、溺水）/`FoodChain`（自动吃饭）/`MLGBucketFallChain`（落地水），`index.js` 是 mineflayer 适配层 + `TaskCatalogue` 式物品映射；`headless.js` 每 50ms（20 TPS）驱动一次，只在 `patrol`/`task` 模式下跑（飞行、开发、PvP、跟随、旧采集不插手）。`get`/`mine`/`food`/`goto` 走任务链后台执行，`/state` 的 `task` 字段和 `mcbot_status` 会显示当前任务；需要合成的物品暂不支持（会明确报错）。地图由 [mapRender.js](file:///c:/QQBot/src/mcheadless/mapRender.js) 零依赖渲染（地形图扫最高方块上色 + 高度明暗 + 玩家打点；物品地图读 `map` 包累积 `pixels`），默认存到状态文件同级的 `maps/`（保留最近 20 张），路径与摘要通过 `/state` 的 `map` 字段回给小钠。账号取 `.env` 的 `MC_BOT_USER`（默认 xiaona）与 `MC_BOT_PASSWORD`，控制口 `MC_BOT_CTL_PORT`，状态落 `data/mcbot-state.json`。AI 工具对应 `mcbot_join` / `mcbot_leave` / `mcbot_status` / `mcbot_chat` / `mcbot_command` / `mcbot_cmd` / `mcbot_map`（生成地图 → 发到当前 QQ 会话 → 视觉模型看一眼画面，摘要回灌）/ `mcbot_mapitem`（同上，来源是物品栏地图）/ `mcbot_players` / `mcbot_inventory`（都 admin+，定义在 [agent.js](file:///c:/QQBot/src/agent.js)，`index.js` 挂到 `ctx.mcbot`）。旧的同进程 mineflayer 实现（`walk_to/break/place/use/login/move`）已删除。**客户端只是执行器，大脑是 AI**：`promptTools.js` 的「自己的 MC 客户端」段要求模型先 `mcbot_status` 读真实状态再决定下一步，宏指令（`develop`/`collect`）只当起点、随时可 `stop` 改路线，不要在 `headless.js` 里再焊死固定流程。
- **目录布局（2026-10 整理）**：`start.js` 是唯一入口、留在根目录；机器人模块全部在 `src/`（主程序 `src/index.js`）。`src/paths.js` 导出 `ROOT`，所有运行时资源（`.env`、`config.json`、`prompt.txt`、`data/`、`logs/`、`voice_cache/`、`web/`、`snowluma/`）都从 `ROOT` 定位，**不写死盘符 —— 复制整个 QQBot 目录即可迁移**。`asr-venv/` 是 Python 虚拟环境，换机若基础 Python 路径不同需重建（不建也能启动，只是本地语音识别不可用）。
- 版本号在 [xiaona-mod/build.gradle](file:///c:/QQBot/xiaona-mod/build.gradle)，**每次加功能递增**。
- **多版本构建（Fabric）**：根项目仍是 1.21.11（源码在 `src/main/java`，产物 `build/libs/xiaona-mod-<ver>.jar`）；`fabric-1.21.1` / `fabric-1.21.8` 是子项目，构建时用 `Sync` 把「根项目共享源码 + `legacy/src/main/java` 覆盖层」合成到各自的 `build/merged-src` 再编译，产物 `fabric-<ver>/build/libs/xiaona-mod-<mc>-<ver>.jar`。
  - `legacy/` 只放旧版（1.21.1 / 1.21.8 同代 API）确有差异的文件：`WhitelistGate`（`GameProfile` 版）、`VanillaBanProvider`（反射读 `ServerConfigEntry#getKey`）、`mixin/PlayerManagerMixin`（`checkCanJoin(SocketAddress, GameProfile)`）、`Compat`（`executeWithPrefix` / `isOperator(GameProfile)`）。
  - 共享代码里凡涉及这些差异的，一律走 `Compat`，不要直接写版本专属 API。
  - **26.x 还没支持**：Yarn 映射止于 1.21.11；26.x 用 Mojang 官方名（没有 intermediary）且要求 Java 25，需要单独做映射改写与 JDK 25 构建环境。
- 注释、日志、提交信息一律用**中文**（用户偏好）。
- bot（模块都在 `src/`）：`index.js` 入口与命令分发、`agent.js`（AI 工具调用 agent：工具注册 + 按身份过滤 + 循环；工具含 web_search/analyze_image/mc_status/player_query/player_pos/ai_balance/mc_command/adjust_favor/sing/remember/recall_memory（`player_pos` **仅管理员及以上可用**（坐标属玩家隐私，2026-11 从 guest 提权），查在线玩家坐标**和所在维度**：先 `data get entity <名> Pos` 再 `data get entity <名> Dimension`，维度映射成主世界/下界/末地；`promptTools.js` 里另有隐私规则：不主动播报、不在群里扩散、不写进记忆。`#查询` 的 Plan 数据**不再显示 UUID**；mod 白名单加了 `data`，但只放行 `data get`，改数据的子命令一律 403。mod 2.12.2 起 `/bridge/players` 每人带 `dim`，`mc_status` 会显示成「名字（主世界）」）。**sing 是普通工具**，模型给歌词后由 `index.js` 的 `ctx.sing` 把歌词**压成一行**、拼 `(唱歌)` 标签后合成语音直接发出，QQ 场景才开放；记不住歌词时模型应先 web_search 搜歌词）、`aiService.js`（服务商/模型/请求，含 `chatCompletionRaw`）、`binding.js` 游戏ID绑定、`permission.js` 授权与等级、`mcbridge.js` MC 桥客户端、`chatSettings.js`（会话级设置：群/私聊各自覆盖全局，落盘 `data/chat-settings.json`）、`asr.js`（语音识别：调**本地 FunASR/SenseVoice** 的 OpenAI 兼容接口，服务由 `start.js` 自动拉起（venv 在 `asr-venv`，也可手动跑 `startASR.bat` 看日志）；**amr/silk 会先经 `setAudioConverter` 注入的 SnowLuma `get_record(out_format=wav)` 转码**，识别结果再按 config.json 的 `asr.homophones` 做**同音纠正**把小娜/小纳改回小钠）、`tts.js`（语音合成：`TTS_PROVIDER` 切换后端。默认 **小米 MiMo TTS**（`mimo-v2.5-tts`，OpenAI 兼容 `POST https://api.xiaomimimo.com/v1/chat/completions`，目标文本放 `role=assistant`，文本开头写 `(风格)` 标签控制语气；**唱歌必须精确用 `(唱歌)` 开头，且整段歌词不能有换行**——标签里多写别的词（如 `(唱歌 温柔)`）、歌词分行、或额外带 `role=user` 的风格指令，都会退化成朗读（实测同段歌词：一行 43s 真唱 vs 分行+指令 26.7s 朗读），返回 `choices[0].message.audio.data` base64；密钥 `.env` 的 `MIMO_API_KEY`，音色 `TTS_XIAOMI_VOICE` 默认 `冰糖`）；配不到 key 或 `TTS_PROVIDER=edge` 时回退**微软 Edge 朗读服务**（协议同 Python 的 `edge-tts`，音色/语速/音量读 `TTS_VOICE`/`TTS_RATE`/`TTS_VOLUME`，`edgeDrm.js` 是它的 Sec-MS-GEC v2 令牌算法）。送进 TTS 前统一用 `stripEmoji` 去掉 emoji/颜文字，语音里不带表情；**发语音时 `segRecord` 会把文件读成 `base64://`**（SnowLuma 在 Docker 里看不到宿主机的 `voice_cache` 路径，直接传路径会 EACCES/ENOENT，语音发不出去））、`edgeDrm.js`（**Edge TTS 的 DRM 令牌**：v2 格式为「16 位 CS64-64 位 SHA256」，两段哈希都是微软魔改版，逐位移植自 edge-tts 的 `drm.py`；改这里要拿 Python `edge-tts` 的 `generate_sec_ms_gec_v2` 对拍）、`help.js` 帮助文案、根目录 `prompt.txt`（**只放人设与说话风格**）、`src/promptTools.js`（程序侧系统提示词：工具清单/权限/记忆机制/MC 桥玩法，按身份与能力动态生成，别再往 prompt.txt 里写工具用法和实现细节）、`push.bat` 推送、`restart.bat` 重启（自提权 + 删除旧自启任务 + 隐藏启动）、`background.vbs` 隐藏窗口启动器（由 `restart.bat` / `启动.bat` 调用）。
- **网页设置优先复用 .env（2026-11）**：全局设置里与 `.env` 同名的项，**只有 `.env` 里确实存在该键时**才从 `.env` 取值显示，保存时写回 `.env` 并把 `config.json` 对应字段清空（避免 config 覆盖 env）；`.env` 没写的键仍按原方案存 `config.json`。覆盖范围：`RL_*`（rateLimit 全部 15 项）、`TTS_PROVIDER` / `TTS_XIAOMI_VOICE` / `TTS_VOICE` / `TTS_RATE` / `TTS_VOLUME`、`ASR_CUSTOM_URL` / `ASR_CUSTOM_MODEL`。映射在 `webui.js` 的 `ENV_BACKED`，读写用 `readEnvValues` / `writeEnvValues`（只改已有键、保留其它行与换行风格，写完同步 `process.env` 热生效）。因为 rateLimit 会被写进 `.env`，`config.js` 的 `ENV_NUM_KEYS` / `applyEnvOverrides` 让 `.env` 里已有的 `RL_*` **优先于 config.json**（否则清空后的字段会退回默认值）。
- **配置分工**：`.env` 放密钥/账号/开关等部署项；**数值类可调项（限速、冷却、唤起会话、AI 模型行为）与「会话层全局默认（chat：是否回复/关键词/语音/补充提示词）放 `config.json`**，由 `src/config.js` 读取（支持 `//` 注释，缺字段自动兜底）。改这些数值请改 config.json，不要再往 .env 加 `RL_*` / `FORWARD_*`。
  - `ai`：`thinking` 是否思考、`reasoningEffort`（auto/low/high/max，DeepSeek 2026 的 `reasoning_effort`，auto 不传）、`contextMessages` 注入条数（5~50）、`temperature`（0~2）、`runTimeoutSec` 单轮 AI 总超时（30~600，默认 120）；`aiService.js` 的 `aiSettings()` / `reasoningParams()` 每次请求现读，热加载生效。
  - **工具调用是真 agent 循环（2026-11 修正）**：正常走 OpenAI `tools` / `tool_calls`，模型可以连续多轮"调用→看结果→再调用"，最后才回话；**中间旁白不再发给用户**（以前会把"我查一下"先发出去，看起来像"发消息前用工具"）。**工具失败也照实回灌给模型**（tool 消息里带「工具 X 执行失败：…，请用你自己的话告诉用户，别装成功」），并且失败后模型若沉默，会再逼它说一句，绝不悄悄吞掉。有些中转不支持结构化调用、把 `<tool_calls><tool_call>{json}</tool_call></tool_calls>`、`<tool_call>…` 或 `<function=名字>…` 当正文吐出来，`aiService.extractTextToolCalls()` 会还原成标准 tool_calls 并把这些标签从回复里清掉（只认真实存在的工具名，防止误判）。
  - **会话 agent：引导式（steering）而非排队式（2026-11 重写）**：`index.js` 的 `aiSessions` 每个会话一个运行态，同一时刻只跑一轮；**同一个人**在运行中又发的消息不再排队等整轮结束，而是由 `runAgentLoop` 的 `steer` 回调在每次请求模型前追加成新的 user 消息；模型刚要给出最终答复时又来新消息，会把旧答复记进对话后**重答一轮**，而不是发一句没看到新消息的过时回复。不同人的消息留在收件箱按到达顺序等下一轮（合并不同 QQ 的话，工具权限/身份会串，所以只并同一个人的）。限速按「轮」申请一次（引导进来的消息不再单独 `acquire`，否则会和 rateLimit 的同会话 `inFlight` 互锁）。整轮仍有 `ai.runTimeoutSec` 超时（`AbortController` + `Promise.race`），超时后把没处理的消息放回收件箱并提示"想太久卡住了"；收到「闭嘴/别说了」会 `abort` 当前轮并清空收件箱。**被打断也不能丢上下文**：这一轮已经交给模型的消息仍会写进记忆（`rememberUsers`；超时会把引导/连发消息放回收件箱重跑，所以只补记被丢弃的首条，避免重复），并记住被打断的人 —— 他 10 分钟内的下一轮会自动把「最近对话」一起注入（`includeHistory`），不用等模型自己 `read_history`。`runAgentReply`/`runAgentLoop` 支持 `signal`，模型调用与工具执行都套了"取消即拒绝"。`chatCompletionRaw` 把整轮 signal 与单次超时用 `AbortSignal.any` 合并。
  - **提示词按正常 agent 分工（2026-11）**：system = `prompt.txt` 人设 + `promptTools.js`（工具/权限/记忆/MC）+ `index.js` 的 `buildChatRules()`（工具选择、VOICE/REPLY 标记、分条、引导语义）+ `buildTurnContext()`（记忆/会话补充设定）；**user 消息只放本轮元数据行 + 用户原话**，工具结果以 `role:tool` 回灌。别再把人设/规则塞进 user 消息。
  - `memory`：`maxUserMessages` 每人保留条数（5~20，`memory.js` 会夹边界）。
- **Linux（Ubuntu / Debian）部署（2026-11）**：`deploy/linux/install.sh` 一键装 Node `24.22.1` + 运行依赖 + `.env` + systemd 服务 `xiaona-bot`（`WorkingDirectory` 为项目根、`ExecStart` 跑 `start.js`）；`--with-snowluma` 用 Docker 起 SnowLuma 官方镜像（`motricseven7/snowluma:latest`，内置 Linux QQ + Xvfb + noVNC；端口 6081 noVNC 扫码 / 5099 WebUI / 3001 OneBot WS，后两个只绑 127.0.0.1；必须带 `--cap-add=SYS_PTRACE --security-opt seccomp=unconfined` 与 `--shm-size=1g`，数据卷 `qq-gateway-data` 存 `config/onebot*.json`）；`--with-napcat` 是备选，用 Docker 起 NapCat（`mlikiowa/napcat-docker`，WS `127.0.0.1:3001`、WebUI `127.0.0.1:6099`；脚本会预写 `/opt/napcat/config/onebot11.json` 自动开启正向 WS，NapCat ≥ 4.5.3 登录即生效，更低版本要在 WebUI 手动建；官方镜像的 QQ NT 是 x86_64，ARM 实例跑不了），`--with-asr` 建 `asr-venv`（Linux 的命令在 `bin/funasr-server`，Windows 是 `Scripts\funasr-server.exe`）。**Windows 里的 `snowluma/native` 只有 win32-x64，Linux 本机跑不了（只能走官方 Docker 镜像）**：`start.js` 在非 Windows 上跳过 QQ / SnowLuma 配置与拉起（机器人只作为 OneBot11 客户端），只启动机器人和本地 ASR；token 必须与容器里 `onebot*.json` 一致（空对空也算一致）；两个开关互斥，**已有现成 OneBot（端口已监听）或同名容器时只跳过/`docker start`，不删不改**。`deploy/linux/update.sh` 负责 `git pull --ff-only` + 补依赖 + 重启。Linux 上 `#截图` 不可用（服务器无桌面，直接提示改用 `#shot`），`#shot` 用 Chrome/Chromium（加 `--no-sandbox`），`#换头像` 的居中裁剪走 ImageMagick（Windows 仍走 PowerShell）。
- **游戏内 #指令作用到桥接群（2026-10-31）**：`src/index.js` 的 `runGameCommand` 给游戏伪事件填 `group_id = MC_BRIDGE_GROUP`（配了桥接群时 `message_type` 一律 `group`），所以 `#禁言/#解禁/#踢出/#拉黑/#全体禁言/#解除全体禁言/#群公告/#聊天记录` 都作用在转发群上；回复依旧走 `__replySink` 回注游戏、不发 QQ。`#撤回` 看 `__bridgeConvKey`（`g:<桥接群>`）取 `botSentMsgs`；`__convKey` 仍是 `mc:<玩家名>`，只给记忆/AI 隔离用，别把两者合并。
- **记忆按「人」存（2026-10 改）**：`memory.js` 的键是 `u:QQ号` / `n:玩家名`，**不再是会话键**；`messages` 表新增 `scene` 记来源（`g:群号` / `p:QQ号` / `mc:玩家`），注入上下文时以 `[群123]` / `[私聊]` / `[游戏]` 标注。**只记录真正触发 AI 回复的消息**（`index.js` 的 `runAI` 内写入，入口处不再全量记录；被超时/喊停打断的轮次也会记录，保证下一句接得上），每人超上限直接删最老（旧「压缩进 summary」逻辑已移除，`summary` 表只保留给旧数据）。旧数据启动时自动迁移：带 `qq` 的 user 行 → `u:qq`（原会话键写进 `scene`），私聊的旧长期记忆 `p:QQ号` → `u:QQ号`。
- **可切换后端（都在 config.json，网页「全局设置」可改，热加载即生效）**：
  - `search`：`provider` = `off`/`baidu`/`deepseek`/`custom`，`limit`、`customUrl`。deepseek 复用 `.env` 的 `AI_API_KEY`（`POST https://api.deepseek.com/v1/tools/search`，{query,count}）；baidu 用 `BAIDU_SEARCH_KEY`（千帆 ai_search，**不要传 model**，否则走没权限的智能总结模式）；custom 用 `SEARCH_CUSTOM_KEY`。
  - `vision`：`provider` = `ai`（主模型）/`custom`（OpenAI 兼容 /chat/completions，支持 image_url）/`off`，`customUrl`、`customModel`；密钥 `VISION_CUSTOM_KEY`。
  - `tts`：`provider` = `''`（按 .env 自动）/`xiaomi`/`edge`，`xiaomiVoice`、`voice`、`rate`、`volume`（留空回退 `.env` 的 `TTS_*`；`tts.js` 每次合成现读，热加载生效）。
  - `asr`：`provider` = `mimo`/`local`/`custom`，`language` = auto/zh/en（见上文语音识别）；`customUrl`/`customModel`/`customKey` 供 custom 后端。
  - `bridge`：`mode` = `''`（用 `.env` 的 `MC_BRIDGE_URL`）/`off`/`loopback`/`lan`/`public`，`port`、`lanHost`、`publicUrl`。切换由 `src/index.js` 的 `applyLiveConfig()` → `applyBridgeConfig()` 热重连（`src/mcbridge.js`，`bridgeTargetOf` 是算地址的纯函数）；密钥/桥接群仍看 `.env`。
- **网页「会话管理」**：把 `接管` 页换成会话管理（群聊/单聊两块），每个会话可覆盖全局设置（AI是否回复/触发关键词/语音/补充提示词/限流·冷却·唤起数值/**进出群提醒开关与文案**），留空即用全局。提醒只有群聊能配，文案支持占位符 `{name}`/`{kind}`/`{note}`（见 config.json 的 `notice` 段，全局默认也在那）。后端接口 `/api/chat-settings`（GET 列表+全局、POST 存某会话覆盖）与 `/api/global-config`（GET/POST config.json，写后热加载）。会话 key 仍是 `g:群号` / `p:QQ号`。
  - **会话统计（2026-11）**：`src/convStats.js` 按会话累计 `wake`（消息真正交给 AI 的轮数，含最终没回复的轮）与 `reply`（成功发出 AI 回复的轮数），落盘 `data/conv-stats.json`（1.5 秒防抖 + 退出补写）。`index.js` 的 `runAI` 在调用 AI 前 `bump(...,'wake')`、发出回复后 `bump(...,'reply')`；`/api/chat-settings` 返回 `stats`，会话列表每项显示「💬 唤起 / 回复」，选中会话的表单底部也有累计统计。
- **网页状态页（2026-11）**：原「连接状态」页已并入「状态 / 帮助」页（导航只留后者，默认打开它），SnowLuma 日志板块已移除。连接探测：Windows 用 `tasklist` 查 `QQ.exe`；Linux 先 `docker ps --filter name=snowluma` 看容器，再退回 `pgrep -f '([/ ]|^)[Qq][Qq]([ /]|$)'`，避免 Linux 上 QQ 状态恒为「未运行」。
- **网页 QQ 客户端（2026-11，`/qq`，页面 `web/qq.html`）**：必须登录，未登录 302 到 `/login`；旧的 `/trial` 只做 302 跳 `/qq`。左侧会话来自 `src/qqInbox.js` 的内存收件箱（不落盘，重启即清空；会话上限 200、每会话 300 条）：`index.js` 收到群聊/私聊时 `recordIncoming`（禁言/黑名单里的消息也照记），`callApi` 在 `send_group_msg`/`send_private_msg` 成功后 `recordOutgoing`。接口：`GET /api/qq/conversations`、`GET /api/qq/messages?key=g:群号|p:QQ号&after=消息id`（读取即清未读）、`POST /api/qq/send`（用机器人 QQ 号发真实消息）。页面另有置顶的「小钠」直聊会话，走 `/api/trial/chat`（仅登录、所有者身份，不经过 QQ）。
- **公开服务器主页 / PCL 适配（2026-11）**：`web/home.html` 是**所有访客的首页**（`/`、`/home` 一律给主页，登录后也留在主页，右上角「登录」自动变成「进入控制台」，按身份跳 `/console`、`/admin`、`/me`），卡片布局显示服务器地址、在线状态、在线玩家（名字+维度）、快速入口（控制面板/我的账号/热力图）、进服须知，10 秒轮询 `GET /api/home`（公开，只返回 `{name,address,configured,connected,online,players[{name,dim}],ts}`，不含密钥/群号/坐标，取玩家有 3 秒超时兜底）。**控制面板改到 `/console`**（所有者专属，`/index.html` 302 到它；未登录 302 `/login`，管理员/普通玩家分别 302 `/admin`、`/me`）。`GET /pcl/Homepage.xaml` 按请求 Host 动态生成 PCL 自定义主页（WPF XAML，`local:MyCard`/`MyListItem`/`MyHint`，全部是静态卡片 + 「打开网页」跳转）；PCL 不支持内嵌 HTML，所以 XAML 只当入口，实时数据靠网页主页。用法：保存为 PCL 目录的 `Homepage.xaml`，或在 PCL「设置 → 主页 → 自定义主页下载地址」填 `http://<面板地址>/pcl/Homepage.xaml`。服务器名取 `.env` 的 `MC_SERVER_NAME`。**所有网页内容区统一 90% 宽**（主页 `.wrap`、面板 `.app`、网页 QQ `.app`、登录/我的账号/管理/热力图 `.wrap`、兼容页 `.card`），明暗与控制面板共用 `localStorage['xiaona-theme']`（右上角切换），点服务器地址即复制。
- **亮色 / 暗色模式（2026-11）**：控制面板侧栏底部（`.side-foot`）和网页 QQ 的左下角各有一个切换按钮（`.theme-toggle`），选中值存 `localStorage['xiaona-theme']`（`light`/`dark`），无值时跟随系统 `prefers-color-scheme`。主题写在 `<html data-theme="dark">` 上，靠 CSS 变量覆盖实现：`web/index.html`、`web/qq.html` 各有一套 `html[data-theme="dark"]`；`src/webui.js` 的登录 / 我的账号 / 管理 / 热力图页共用 `THEME_BOOT`（在 `<head>` 里尽早应用，避免闪白）和同一组 `:root` / `[data-theme="dark"]` 变量。热力图 canvas 的网格/坐标/玩家名从 CSS 变量现取（画布不继承 CSS 颜色），底色用 `--mapbg`、网格线用 `--mapline`（暗色下比 `--line` 亮一档，否则在调亮的地图底上看不见），暗色下描边换成深色光晕。新增页面要支持暗色：引入 `THEME_BOOT`、补 `[data-theme="dark"]` 变量、硬编码的 `#fff`/`#d9d9d9` 之类换成 `var(--card)` / `var(--line-strong)`。
- **网页面板登录（2026-11，QQ 号登录）**：登录页 `/login` 账号框默认留空，填 QQ 号。会话存 `{qq, code, exp}`（`data/webui-sessions.json`），角色每次请求用 `perm.role()` 实时算。
  - **所有者**（`.env BOT_OWNER`）：用 `WEBUI_PASSWORD` 登录；在网页改过密码后改用 `data/web-accounts.json` 里的 scrypt 哈希（`src/webAccounts.js`）。
  - **有权限的用户**（master/admin/已绑定游戏ID的玩家）：用 `/api/login/send-code` 让 bot 私聊发 6 位验证码（60 秒间隔、每小时 5 次、5 分钟有效、错 5 次作废），`/api/login/code` 验证后建会话；首次登录可在 `/me` 设密码，之后用 QQ 号+密码登录。**验证码登录的会话（`code:true`）改密码不要求原密码**，是忘记密码的恢复路径。**密码支持中文**（长度按 Unicode 码点 6-64 位，`webAccounts.js` 先做 NFC 规范化再 scrypt，避免中文输入法的组合字符导致“看着一样却登不上”）。
  - **隔离**：只有 owner 能进 `/`、`/qq`、`/ssqq`（含 `/ssqq/ws` 的 OneBot 代理）、`/legacy` 和除 `/api/me*`、`/api/heatmap`（只返回自己的数据）外的所有 `/api/*`；owner/master/admin 可进 `/admin` 管理页并使用 `/api/admin/*`；其他人一律 302 到 `/me` 或 403。`/me` 只能看/解绑/绑定自己 QQ 名下的游戏ID、改自己的密码（`/api/me`、`/api/me/unbind`、`/api/me/bind/start`、`/api/me/bind/verify`、`/api/me/password`），页内还有「我的位置热力图」入口。
  - **登录门槛**：除所有者外，登录前会用 OneBot `get_group_member_info` 查该 QQ 是否在 `MC_BRIDGE_GROUP` 里（在群缓存 5 分钟、不在缓存 1 分钟；没配群 / 机器人没连上都按不能登录处理）。密码登录、发送验证码、验证码登录三处都判。
  - **管理子页 `/admin`**（owner/master/admin）：列出所有有关联的 QQ（绑定、封禁、网页账号、权限名单），显示角色/封禁/密码状态；可直接补绑（`forceBind`，跳过图形验证码，id 已被他人绑定会拒绝）、解绑（`forceUnbind`）、清除他人网页密码（`/api/admin/password/clear`，所有者除外）。**所有者访问 `/admin` 会 302 到主面板 `/#accounts`**（`web/index.html` 里的内嵌「账户管理」标签页，功能相同）；master/admin 仍用独立的 `/admin` 页。
- **转发敏感词过滤（2026-11）**：QQ 群消息转发进游戏、游戏转发进 QQ 群（`mcbridge.js` 的 `toBridgeGroup`，**只过滤玩家聊天**，上下线/死亡/成就等系统播报传 `{system:true}` 原样发）、`#聊天记录` 合并转发前都会过滤。词库用 **tencent-sensitive-words**（[src/tencent-sensitive-words.txt](file:///c:/QQBot/src/tencent-sensitive-words.txt)，约 4.8 万条，首次使用时载入内存）；`config.json` 的 `filter.words` 是额外补充词，`ignore` 是放行词（词库里有服务器/管理/手机/政府/杀死这类日常词，默认整段放行；留空则按词库原样匹配），`replace` 是占位符，`enabled` 总开关，热加载生效。单字词（妈/爸/操等）按子串匹配太容易误伤，词库与自定义词里的单字**只在独立出现时**才算（如整条“操”或“小明：操！”，不会打码“操作/体操”）；命中取最长匹配，英文不区分大小写。实现见 `src/tencentWords.js`（`maskByWords` / `tencentMask` / `maskForwardText`）。
- **自更新（2026-11）**：`#更新` / AI 的 `bot_update` 拉 GitHub 最新代码（直连失败换镜像），依赖有变化会 `npm install`，成功后在 PM2 下自动重启。**对用户只说一两句话**，不罗列提交、哈希、镜像源；AI 工具结果也只返回结论。重启前会拉起 [updateWatchdog.js](file:///c:/QQBot/src/updateWatchdog.js)（detached）：新版本 90 秒内 WebUI `/health` 不通且 PM2 未稳定在线，就 `git reset --hard` 回上一个 commit（先备份并恢复 `config.json`），直接通过 OneBot WS 到发起更新的会话发一句“更新没成功，已退回上一个版本”，再 `pm2 restart` 旧版本。WebUI 实际监听端口会写 `data/webui-port.json`，看门狗按它探活（端口被占用顺延时不会误判）。
- **AI 重启（2026-11）**：AI 工具 `bot_restart`（admin+）复用「回复发完再重启」的机制（`pendingSelfRestart` + `scheduleSelfRestart`）：PM2 下 `pm2 restart <name> --update-env`，重启上线后回原会话说「我回来啦～」；非 PM2（Windows 本地）不自动重启，只告诉对方手动 `restart.bat`。只在用户明确要求重启时用。
- **日志净化（2026-11）**：昵称/群名片里常带 Unicode 双向控制符（如 U+2067）和零宽字符，会让终端把整行重排（"位置错乱"）甚至伪装日志。`logger.js` 的 `toText` 统一走 `cleanLogText`，剔掉 bidi/零宽/控制字符（保留换行、制表与 ZWJ），三个 sink（终端/WebUI/文件）都生效。
- **好感度语气（2026-11）**：`promptTools.js` 要求模型按元数据里的好感度调整：≥50 更有人情味、更愿意接话和关心，越高越亲切（≥80 更热络/开玩笑），但不越界、不对低好感或陌生人用亲昵称呼。
- **中文游戏ID（mod ≥ 2.14.0，2026-11）**：玩家名规则统一为「1~16 个 Unicode 字母/数字/下划线」（`PlayerNames.valid`，中文一个字算一个）。登录名校验由 `mixin/PlayerNameMixin` 兜底（原版本来就宽松，旧版本严格时也能过）；命令里的中文名由 `mixin/StringReaderMixin` 放开 Brigadier 的 `isAllowedInUnquotedString` 修好 —— `/tp 小明`、`@a[name=小明]`、`@p[team=红队]`、carpet 的 `/player 小明 spawn`（参数就是 `StringArgumentType.word()`）都能解析。桥的 Plan 查询、封禁接口（原版/Paradigm）都改用 `PlayerNames.valid`。bot 侧同步：`binding.js` 的 `GAME_ID`、`agent.js` 的玩家名校验、`webui.js` 的封禁接口、`web/index.html` 的绑定/封禁表单都改成 `[\p{L}\p{N}_]{1,16}`（绑定说明文案改为「1-16 位中英文、数字或下划线」）。
- mod：`XiaonaMod`（入口/接线）、`Config`、`BridgeServer`（全部 HTTP 接口）、`McEvents`（事件队列 + SSE + 注入）、`BindBoard`（未绑定玩家计分板）、`WhitelistGate`（白名单模式）、`BotState`（日志）、`mixin/`（`ServerNetworkIoMixin` / `ClientConnectionMixin` / `PlayerManagerMixin`）。
- **位置热力图（mod ≥ 2.12.0，2026-11）**：mod 记录每个玩家**加载过的区块**（不是定时采样轨迹）：每个 tick 检查在线玩家所在区块，新进入就记一条区块坐标（同一区块只更新"最近时间"，**并累加进入次数**——只有从别的区块/维度重新踏进来才 +1，站着不动不涨），数据**永久保存**在 `config/xiaona-heatmap.json`（每 `heatmap.saveSec` 秒 + 停服时落盘）。接口 `GET /bridge/positions?since=<ms>` → `{ok, since, players:[{name, dim, pts:[[chunkX,chunkZ,次数,最近时间],...], last:{x,z,t}}]}`，`since` 用于时间筛选（**2.13.0 起 pts 每项 4 个值；更早的只有 `[chunkX,chunkZ]`，网页按 1 次画**）。版本差异走 `Compat.worldOf(player)`（1.21.11 `getEntityWorld()`、1.21.1/1.21.8 `getWorld()`）。
  - bot 侧 `mcbridge.getPlayerPositions(since)`；网页 `/heatmap` **所有登录用户都能进**：所有者看全服，其他人只看自己绑定游戏ID 的区块（`/api/heatmap` 服务端按 `getGameIdsOf` 过滤，未绑定返回空），`/me` 和 `/admin` 页都有「我的位置热力图」入口，用 Canvas **把每个区块画成方块**（满格、留一点缝隙），**一人一色、颜色深浅=走过的次数**（1 次最浅、8 次以上最深，对数映射到 0.18~0.95 透明度），**多人走过同一区块时颜色叠加**（按最近走过时间排序，越晚走的画在越上层）；鼠标/触摸（统一走 Pointer Events，Windows 触摸屏同样可用）拖动平移、双指捏合或滚轮以光标为中心缩放、悬停显示方块坐标，画布光标统一是**十字**（拖动/标点等任何工具都一样）；三个维度同屏（主世界全宽、下界/末地双列），不做主世界↔下界坐标互映，当前位置圆点 + 名字；玩家图例在右侧栏、**每个玩家一行**，在线显示「在线 · 当前维度」、离线显示「离线 · 最后下线维度 · 最后在线时间」（`/api/heatmap` 返回的 `online` 是 `{name, dim}` 列表，旧版 mod 没 `dim` 时回退到最后一条记录），图例可隐藏、可「定位」到 256 格窗口、「全图」复位；**支持标点/笔刷/画圆/橡皮擦**（顶部工具条：标点=单击、笔刷=按住涂画、画圆=拖出圆、橡皮擦=点/拖逐条擦除、全部清除；任何工具下按住右键都能拖动地图；每条标记可命名、改色，左侧「标记」栏列出所有标记及名称，点行定位；标记按维度**存在 bot 服务器的 `data/heatmap-marks.json`，按登录 QQ 分开存**（`/api/heatmap/marks` GET/POST，不同人互不可见；旧浏览器 localStorage `xnHeatMarks` 首次打开会自动迁移到服务器），跟着缩放平移走）；时间筛选（1 小时 / 24 小时 / 7 天 / 30 天 / 全部，默认 24 小时，存 localStorage）；自动刷新默认开启、默认中速 1 秒，可切快 0.5s / 慢 5s，选择存 localStorage；每张地图右上角有**自己的「全屏」**，只把这一张铺满浏览器窗口（`body.fsmode` + `.mapcard.fsnow{position:fixed;inset:0}`，Esc 或右上角「退出全屏」还原），不是整页三张一起全屏。主面板侧边栏有入口。旧版 mod 没有该接口，页面会提示升级。
- **封禁来源（mod ≥ 2.8.0）**：装了 **Paradigm**（mod id `paradigm`）时，`/bridge/bans` 读它 SQLite 库的只读视图 `paradigm_v_active_bans`，`/bridge/ban` 走它的 `/ban`、`/unban`（命令不存在时回退 `/pardon`）命令；**没装则完全沿用原版 `UserBanList`**（`VanillaBanProvider`，行为与 2.7.x 一致）。相关类：`BanService`（选 provider）、`BanProvider` / `VanillaBanProvider` / `ParadigmBanProvider`、`ParadigmStorage`（找 storage.json / 数据库路径）、`ParadigmDb`（只读查询）、`BanCommandRunner`（1.21.11 用 dispatcher.parse + execute 跑命令）、`BanException`。
  - 存储后端**只支持 sqlite**：`config/paradigm/storage.json` 的 provider 是 json/mysql 时，`/bridge/bans` 明确返回错误（不会拿空数组冒充"没有封禁"）。
  - sqlite-jdbc 通过 Loom `include 'org.xerial:sqlite-jdbc:3.46.1.3'` 嵌进 mod jar（产物约 14MB，`META-INF/jars`），服务器不用另装 JDBC。
  - `/bridge/status` 新增 `ban: { provider: 'vanilla'|'paradigm' }`；`/bridge/ban` 响应带 `provider`，失败时 `ok:false` + `error`，部分失败看 `failed`/`errors`。
- **Plan 可用性（mod ≥ 2.8.0）**：`PlanAvailability` 先看 mod 是否装了 `plan`/`planfabric`，没装则探活 `{plan.url}/v1/server`（**任何 HTTP 响应都算在线**，只有连不上/超时才判不可用；结果缓存 60 秒）。`/bridge/status` 新增 `plan: { available, modLoaded, reason }`；不可用时 `/bridge/player` 直接返回错误，不再转发到 Plan。
  - bot 侧：`mcbridge.js` 缓存最近一次 status（`planAvailableFrom` / `isPlanAvailable` / `getBridgeCaps`，SSE `hello` 时刷新、换桥配置时清空）；`agent.js` 给 `player_query` 标 `requires: 'plan'`，`toolsForRole(role, { plan })` 过滤；`index.js` 的 `aiReply` / `player_query` / `#查询` 都先判一次。
  - **旧版 mod 的 status 没有 `plan` 字段 → 按"可用"处理**，保持升级前行为。网页「绑定」页的 `/api/bindings` 返回 `gameBansProvider` / `gameBansError`，读取失败会显示真实原因而不是"暂无封禁"。

## 7. 变更前请验证

改完至少跑：`.\gradlew.bat build`（含单测）+ `npm test`。动了 bot 文件再补 `npx eslint <file>`。
