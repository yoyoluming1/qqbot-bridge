#!/usr/bin/env bash
# 一键部署桥接到云服务器：打包 → scp 直传 → 重启 → 看日志
# 用法：./deploy.sh "这次改了什么"
# 说明：不走「服务器 git pull」（这台服务器到 GitHub 经常超时）；服务器上的 config.json 与 data/ 不在仓库里，不会被覆盖
set -euo pipefail

MSG="${1:-update}"
HOST="${QQBOT_HOST:-root@120.53.2.49}"
PORT="${QQBOT_PORT:-80}"
DIR="${QQBOT_DIR:-/opt/qq-bot}"

cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$MSG"
  git push -q || echo "[deploy] 推送 GitHub 失败（不影响部署）"
else
  echo "[deploy] 没有未提交的改动"
fi

echo "[deploy] 传代码"
COPYFILE_DISABLE=1 tar czf - --exclude ./.git --exclude ./node_modules --exclude ./data --exclude ./config.json . \
  | ssh -p "$PORT" "$HOST" "mkdir -p $DIR && tar xzf - -C $DIR"

echo "[deploy] 重启桥接"
ssh -p "$PORT" "$HOST" "systemctl restart qqbot-bridge && sleep 3 && systemctl is-active qqbot-bridge && tail -3 /var/log/qqbot-bridge.log"
