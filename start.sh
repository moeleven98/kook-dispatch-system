#!/usr/bin/env sh
# kook派单系统 · macOS / Linux 一键启动
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js，请先到 https://nodejs.org 安装 LTS 版本（22.5 或更高）。"
  exit 1
fi
exec node scripts/start.mjs
