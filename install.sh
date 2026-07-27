#!/usr/bin/env bash
# Kala-Skill-Kit installer(macOS / Linux 入口)
#
# 真正的逻辑在跨平台的 install.mjs —— 本文件只是薄封装,保证两边行为永不走样。
# Windows 上直接用:node install.mjs [参数]
#
# 用法与 install.mjs 完全一致:
#   ./install.sh                       全部 skill → 所有探测到的工具(默认)
#   ./install.sh --dry-run             只预览,不改动任何文件
#   ./install.sh --list                列出可选 skill / 工具
#   ./install.sh --tools codex kala-feishu
#   ./install.sh --help
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node。本安装器需要 Node.js 18+(kala-feishu 的脚本同样需要)。" >&2
  exit 1
fi

exec node "$KIT_DIR/install.mjs" "$@"
