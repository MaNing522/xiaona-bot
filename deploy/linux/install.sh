#!/usr/bin/env bash
# ============================================================
# 小钠 QQ 机器人 · Linux（Ubuntu / Debian）一键部署
#
# 用法（在服务器上、项目目录里执行）：
#   sudo bash deploy/linux/install.sh                  # 只装机器人本体（systemd 常驻）
#   sudo bash deploy/linux/install.sh --with-napcat    # 顺带用 Docker 起 NapCat（Linux 上的 QQ 登录）
#   sudo bash deploy/linux/install.sh --with-asr       # 顺带装本地语音识别（FunASR，约 1GB 模型）
#
# 为什么 Linux 不用 SnowLuma：
#   SnowLuma 靠注入桌面 QQ.exe 工作，原生模块只有 win32-x64，
#   Linux 上改用 NapCat（Docker 版 QQ NT）+ OneBot11，机器人照样连 ws://127.0.0.1:3001。
#
# 脚本可重复执行（幂等）：已装好的 Node 会跳过，systemd 单元会覆盖重写。
# 可选环境变量：
#   NODE_VER=24.22.1                 要装的 Node 版本
#   NPM_REGISTRY=https://registry.npmmirror.com
#   PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
#   NAPCAT_IMAGE=mlikiowa/napcat-docker:latest
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_VER="${NODE_VER:-24.22.1}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
NAPCAT_IMAGE="${NAPCAT_IMAGE:-mlikiowa/napcat-docker:latest}"

WITH_NAPCAT=0
WITH_ASR=0
for arg in "$@"; do
    case "$arg" in
        --with-napcat) WITH_NAPCAT=1 ;;
        --with-asr) WITH_ASR=1 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "未知参数：$arg（可用：--with-napcat / --with-asr）"; exit 1 ;;
    esac
done

log() { printf '\033[1;36m[部署]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[部署]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[部署]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash deploy/linux/install.sh"
[ -f "$ROOT/package.json" ] || die "没找到 $ROOT/package.json，请在项目目录里执行"
[ -f /etc/debian_version ] || die "本脚本面向 Ubuntu / Debian；其他发行版请手动装 Node ${NODE_VER} 后用 systemd 跑 start.js"

# ---------- 1. 基础依赖 ----------
log "安装基础依赖（curl / xz / git / imagemagick）…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y || die "apt-get update 失败，请检查 /etc/apt/sources.list 或网络"
apt-get install -y curl ca-certificates xz-utils git imagemagick || die "基础依赖安装失败"

# ---------- 2. Node（要求 ≥ 24.22.1，和 Windows 端保持一致） ----------
node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    node -e 'const a=process.versions.node.split(".").map(Number),b=process.argv[1].split(".").map(Number);process.exit(a[0]>b[0]||(a[0]===b[0]&&(a[1]>b[1]||(a[1]===b[1]&&a[2]>=b[2])))?0:1)' "$NODE_VER" 2>/dev/null
}

if node_ok; then
    log "Node 已满足要求：$(node -v)"
else
    case "$(uname -m)" in
        x86_64|amd64) ARCH=x64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *) die "不认识的 CPU 架构：$(uname -m)" ;;
    esac
    ARCHIVE="node-v${NODE_VER}-linux-${ARCH}.tar.xz"
    TMP="$(mktemp -d)"
    log "下载 Node ${NODE_VER}（${ARCH}，优先国内镜像）…"
    curl -fL --retry 3 --connect-timeout 10 -o "$TMP/$ARCHIVE" \
        "https://npmmirror.com/mirrors/node/v${NODE_VER}/${ARCHIVE}" \
        || curl -fL --retry 3 --connect-timeout 10 -o "$TMP/$ARCHIVE" \
        "https://nodejs.org/dist/v${NODE_VER}/${ARCHIVE}" \
        || die "Node 下载失败：网络不通时可在本地下载后放到服务器手动安装"
    mkdir -p /usr/local/lib/nodejs
    tar -xJf "$TMP/$ARCHIVE" -C /usr/local/lib/nodejs
    for bin in node npm npx; do
        ln -sf "/usr/local/lib/nodejs/node-v${NODE_VER}-linux-${ARCH}/bin/${bin}" "/usr/local/bin/${bin}"
    done
    rm -rf "$TMP"
    node_ok || die "Node 安装后版本仍不满足：$(node -v 2>/dev/null || echo 未找到)"
    log "Node 安装完成：$(node -v)"
fi

# ---------- 3. 依赖安装 ----------
log "安装 npm 依赖（只装运行期依赖）…"
cd "$ROOT"
npm install --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" || die "npm install 失败"

# ---------- 4. .env 初始化 ----------
ENV_FILE="$ROOT/.env"
FRESH_ENV=0
if [ ! -f "$ENV_FILE" ]; then
    cp "$ROOT/.env.example" "$ENV_FILE"
    FRESH_ENV=1
    # 服务器要能远程打开面板：默认监听 0.0.0.0（老 .env 不动，避免覆盖用户设置）
    sed -i 's|^WEBUI_HOST=.*|WEBUI_HOST=0.0.0.0|' "$ENV_FILE"
fi

GEN_PW=""
if grep -qE '^WEBUI_PASSWORD=[[:space:]]*$' "$ENV_FILE"; then
    GEN_PW="$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
    sed -i "s|^WEBUI_PASSWORD=.*|WEBUI_PASSWORD=${GEN_PW}|" "$ENV_FILE"
    log "已生成网页面板密码：${GEN_PW}"
fi

# ---------- 5. systemd 服务（开机自启 + 崩溃自动重启） ----------
NODE_BIN="$(command -v node)"
log "写入 systemd 服务 xiaona-bot.service …"
cat > /etc/systemd/system/xiaona-bot.service <<EOF
[Unit]
Description=Xiaona QQ Bot
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/start.js
Restart=always
RestartSec=5
LimitNOFILE=65535
# 面板默认占 80 端口，所以以 root 运行；想降权就改成专用用户并给 node 加 CAP_NET_BIND_SERVICE
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable xiaona-bot >/dev/null
systemctl restart xiaona-bot
log "服务已启动：systemctl status xiaona-bot"

# ---------- 6. （可选）NapCat：Linux 上的 QQ 登录 ----------
if [ "$WITH_NAPCAT" = "1" ]; then
    # 先确认 .env 期望的 WS 端口：已经有 OneBot 在监听（现成的 NapCat / 其它实现）就跳过，
    # 绝不删除/重建用户已有的容器（那会连登录态和配置一起没了）。
    WS_URL="$(grep -E '^ONEBOT_WS=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r')"
    WS_PORT=3001
    if [[ "$WS_URL" =~ :([0-9]+) ]]; then WS_PORT="${BASH_REMATCH[1]}"; fi
    ONE_TOKEN="$(grep -E '^ONEBOT_TOKEN=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r')"

    if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ":${WS_PORT}([[:space:]]|$)"; then
        log "检测到 ${WS_PORT} 端口已有 OneBot 在监听，跳过 NapCat 部署（直接用现成的）"
        log "若机器人连不上：确认它监听 127.0.0.1:${WS_PORT}，且 token 与 .env 的 ONEBOT_TOKEN 一致"
    elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx napcat; then
        # 已有同名容器：保留原配置与登录态，只确保它在运行
        docker start napcat >/dev/null 2>&1 \
            && log "已启动已有的 napcat 容器（未改动其配置；确认映射到 127.0.0.1:${WS_PORT}）" \
            || warn "napcat 容器启动失败，请手动看 docker logs napcat"
    else
        if ! command -v docker >/dev/null 2>&1; then
            log "安装 Docker…"
            apt-get install -y docker.io || die "Docker 安装失败"
        fi
        systemctl enable --now docker

        log "拉取 NapCat 镜像：$NAPCAT_IMAGE（国内可能较慢，可先配 Docker 镜像加速）…"
        docker pull "$NAPCAT_IMAGE" || die "拉取镜像失败：请配置 Docker 加速器或手动 docker pull $NAPCAT_IMAGE"

        if [ "$(uname -m)" = "aarch64" ]; then
            warn "注意：NapCat 官方镜像里的 QQ NT 是 x86_64，ARM 实例上大概率起不来（可自行了解 box64 方案）"
        fi

        mkdir -p /opt/napcat/config /opt/napcat/qq

        # 预写 NapCat 的 OneBot 默认配置（v4.5.3+ 支持 config/onebot11.json 作为任意账号的默认值）：
        # 登录后自动开启正向 WS，省掉去 WebUI 手工「新建 WebSocket 服务器」这一步。
        # 容器内必须绑 0.0.0.0（只对外暴露到宿主机 127.0.0.1），token 与 .env 的 ONEBOT_TOKEN 保持一致。
        ONE_TOKEN="$ONE_TOKEN" ONE_PORT="$WS_PORT" node -e '
const fs = require("fs");
const cfg = {
  network: {
    httpServers: [],
    httpClients: [],
    websocketServers: [{
      name: "xiaona-ws",
      enable: true,
      host: "0.0.0.0",
      port: Number(process.env.ONE_PORT || 3001),
      messagePostFormat: "array",
      reportSelfMessage: false,
      token: process.env.ONE_TOKEN || "",
      enableForcePushEvent: true,
      debug: false,
      heartInterval: 30000,
    }],
    websocketClients: [],
  },
  musicSignUrl: "",
  enableLocalFile2Url: false,
  parseMultMsg: false,
};
fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2));
' /opt/napcat/config/onebot11.json
        log "已预写 NapCat OneBot 配置（WS 0.0.0.0:${WS_PORT} → 宿主机 127.0.0.1:${WS_PORT}）"

        # 只绑定 127.0.0.1：WS 给本机机器人用，WebUI 走 SSH 隧道，避免把 QQ 登录口暴露到公网
        docker run -d --name napcat --restart unless-stopped \
            -p "127.0.0.1:${WS_PORT}:${WS_PORT}" -p 127.0.0.1:6099:6099 \
            -e NAPCAT_UID=0 -e NAPCAT_GID=0 \
            -v /opt/napcat/config:/app/napcat/config \
            -v /opt/napcat/qq:/app/.config/QQ \
            "$NAPCAT_IMAGE" >/dev/null || die "NapCat 容器启动失败"
        log "NapCat 已启动（容器名 napcat，WS 127.0.0.1:${WS_PORT}，WebUI 127.0.0.1:6099）"
    fi
fi

# ---------- 7. （可选）FunASR 本地语音识别 ----------
if [ "$WITH_ASR" = "1" ]; then
    log "安装 Python 语音识别环境（首次会下约 1GB 模型，慢）…"
    apt-get install -y python3 python3-venv || die "python3 / python3-venv 安装失败"
    if [ ! -x "$ROOT/asr-venv/bin/python" ]; then
        python3 -m venv "$ROOT/asr-venv"
    fi
    "$ROOT/asr-venv/bin/pip" install -U pip -i "$PIP_INDEX"
    # CPU 版 torch 优先走官方 CPU 源（体积小），失败再回退国内 PyPI 镜像
    "$ROOT/asr-venv/bin/pip" install torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
        || "$ROOT/asr-venv/bin/pip" install torch torchaudio -i "$PIP_INDEX" \
        || die "torch 安装失败"
    "$ROOT/asr-venv/bin/pip" install funasr fastapi uvicorn python-multipart -i "$PIP_INDEX" \
        || die "FunASR 安装失败"
    [ -x "$ROOT/asr-venv/bin/funasr-server" ] || die "没找到 asr-venv/bin/funasr-server，funasr 可能没装好"
    log "语音识别环境就绪（start.js 会自动拉起，端口 8899）"
fi

# ---------- 8. 收尾提示 ----------
if [ -n "$GEN_PW" ]; then PW_LINE="密码：${GEN_PW}（已写入 .env 的 WEBUI_PASSWORD）"; else PW_LINE="密码：见 .env 的 WEBUI_PASSWORD"; fi
if [ "$FRESH_ENV" = "1" ]; then ENV_LINE="$ENV_FILE（新生成，需补 AI_API_KEY 等）"; else ENV_LINE="$ENV_FILE（已存在，未覆盖）"; fi

sleep 2
systemctl --no-pager --lines=8 status xiaona-bot || true

cat <<EOF

=================== 部署完成 ===================
项目目录 : $ROOT
运行方式 : systemd 服务 xiaona-bot（开机自启、崩溃自动重启）
查看日志 : journalctl -u xiaona-bot -f    （文件日志在 $ROOT/logs/）
网页面板 : http://<服务器IP>/            账号 admin    $PW_LINE
配置文件 : $ENV_LINE

接下来还要做三件事：
 1) 阿里云安全组放行 80 端口（面板）；端口只在系统防火墙/安全组里开，别把 3001/6099 开到公网
 2) 编辑 .env：至少填 AI_API_KEY、MC_BRIDGE_SECRET（要用游戏桥的话）
 3) 登录 QQ：$( [ "$WITH_NAPCAT" = "1" ] && echo 'docker logs -f napcat 看二维码扫码（WS 已在 onebot11.json 预开；NapCat 低于 4.5.3 时需在 WebUI 手动新建 WS 服务器 127.0.0.1:3001）' || echo '需要先装 NapCat（--with-napcat）或其它 OneBot11 实现，监听 127.0.0.1:3001' )

改完配置重启：systemctl restart xiaona-bot
拉取更新    ：sudo bash deploy/linux/update.sh
=================================================
EOF
