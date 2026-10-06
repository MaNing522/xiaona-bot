# 给下一个接手本项目的 AI

## 0. 最重要的一条：改完自己提交并推送，不要等用户开口

用户明确要求过「下次自动提交」。做完一件事就立刻提交推送，**别问、别攒**。

- 提交：`git add <具体文件…>` —— **不要用 `git add -A` / `git add .`**，仓库里有 `_tk_repro.mjs` 之类的临时文件，不该进版本库
- 推送：在 `c:\QQBot` 目录下执行 `.\push.bat`（读 `.env` 里的 `GITHUB_TOKEN` / `GITHUB_REPO` 推到 GitHub）
- 提交信息：`git commit -m "标题" -m "正文"`

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
```

## 6. 约定与文件地图

- 版本号在 [xiaona-mod/build.gradle](file:///c:/QQBot/xiaona-mod/build.gradle)，**每次加功能递增**。
- 注释、日志、提交信息一律用**中文**（用户偏好）。
- bot：`index.js` 入口与命令分发、`binding.js` 游戏ID绑定、`mcbridge.js` MC 桥客户端、`help.js` 帮助文案、`prompt.txt` AI 人设、`push.bat` 推送。
- mod：`XiaonaMod`（入口/接线）、`Config`、`BridgeServer`（全部 HTTP 接口）、`McEvents`（事件队列 + SSE + 注入）、`BindBoard`（未绑定玩家计分板）、`WhitelistGate`（白名单模式）、`BotState`（日志）、`mixin/`（`ServerNetworkIoMixin` / `ClientConnectionMixin` / `PlayerManagerMixin`）。

## 7. 变更前请验证

改完至少跑：`.\gradlew.bat build`（含单测）+ `npm test`。动了 bot 文件再补 `npx eslint <file>`。
