#!/usr/bin/env bash
# 一键部署：提交 → 推送 → 服务器拉取 → 重启 → 看日志
# 用法：./deploy.sh "这次改了什么"
# 环境变量可覆盖：QQBOT_HOST / QQBOT_PORT / QQBOT_DIR
set -euo pipefail

MSG="${1:-update}"
HOST="${QQBOT_HOST:-root@120.53.2.49}"
PORT="${QQBOT_PORT:-80}"
DIR="${QQBOT_DIR:-/opt/qq-bot}"

cd "$(dirname "$0")"

if [ -z "$(git status --porcelain)" ]; then
  echo "[deploy] 没有改动，跳过提交"
else
  git add -A
  git commit -m "$MSG"
  git push
fi

echo "[deploy] 服务器拉取并重启"
ssh -p "$PORT" "$HOST" "cd $DIR && git pull --ff-only && systemctl restart qqbot-bridge && sleep 3 && tail -3 /var/log/qqbot-bridge.log"
