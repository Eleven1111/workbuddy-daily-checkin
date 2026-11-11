#!/usr/bin/env bash
# 把仓库里的单文件脚本安装到本机自动化任务使用的固定路径，并保留旧版备份。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/src/checkin.mjs"
DEST_DIR="$HOME/.workbuddy/scripts/daily-checkin"
DEST="$DEST_DIR/checkin.mjs"

[ -f "$SRC" ] || { echo "找不到 $SRC" >&2; exit 1; }
command -v node >/dev/null || { echo "未找到 node" >&2; exit 1; }

mkdir -p "$DEST_DIR"
if [ -f "$DEST" ]; then
  BACKUP="$DEST.v1.0.0.bak"
  [ -f "$BACKUP" ] || cp -p "$DEST" "$BACKUP"
  echo "已备份旧版 → $BACKUP"
fi

cp "$SRC" "$DEST"
chmod 755 "$DEST"
echo "已安装 $DEST  ($(node "$DEST" --version))"
echo "运行自检："
node "$DEST" --doctor
