#!/usr/bin/env bash
# ============================================================
# 小钠 QQ 机器人 · Linux 更新脚本
#
#   sudo bash deploy/linux/update.sh
#
# 做的事：拉最新代码 → 补装运行期依赖 → 重启 systemd 服务。
# 只做快进合并（--ff-only）：服务器上有本地改动时会直接报错，不会悄悄覆盖。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

log() { printf '\033[1;36m[更新]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[更新]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash deploy/linux/update.sh"
cd "$ROOT"

log "拉取最新代码…"
git pull --ff-only || die "git pull 失败：服务器上有本地改动或分叉，请先处理后重试"

log "补装运行期依赖…"
npm install --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" || die "npm install 失败"

log "重启服务…"
systemctl restart xiaona-bot
sleep 2
systemctl --no-pager --lines=6 status xiaona-bot || true
log "完成。实时日志：journalctl -u xiaona-bot -f"
