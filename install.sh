#!/usr/bin/env bash
# Kala-Skill-Kit installer —— 逐工具探测,装到实际存在的工具里,缺的跳过。
# 幂等:重复运行 = 用当前 repo 内容覆盖更新。改完 skill 后重跑一次即可。
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$KIT_DIR/skills"
SKILLS=(kala-handoff kala-resume kala-feishu)

# 去掉一个 md 文件开头的 YAML frontmatter(两个 --- 之间),给不吃 frontmatter 的工具用
strip_fm() { awk 'seen<2 { if ($0=="---") seen++; next } { print }' "$1"; }

summary=()

# 用 SKILL.md 目录结构安装(Claude Code / Codex / OpenClaw 都吃 Agent-Skills 标准)
install_as_skills() {
  local label="$1" base="$2"
  local dest="$base/skills"
  mkdir -p "$dest"
  for s in "${SKILLS[@]}"; do
    rm -rf "$dest/$s"
    cp -R "$SRC/$s" "$dest/$s"
  done
  summary+=("✓ $label  →  $dest")
}

# Cursor 不吃 SKILL 目录,生成自包含的 command md(去 frontmatter;handoff 内联模板)
install_as_cursor() {
  local base="$1"
  local dest="$base/commands"
  mkdir -p "$dest"
  {
    strip_fm "$SRC/kala-handoff/SKILL.md"
    echo; echo "---"; echo "# 附:交接文档模板(上文步骤 4/5 引用的 TEMPLATE)"; echo
    cat "$SRC/kala-handoff/TEMPLATE.md"
  } > "$dest/kala-handoff.md"
  strip_fm "$SRC/kala-resume/SKILL.md" > "$dest/kala-resume.md"
  summary+=("✓ Cursor       →  $dest (kala-handoff.md, kala-resume.md)")
  summary+=("–  Cursor       kala-feishu 依赖脚本目录,Cursor 不装脚本,已跳过(请用 Claude Code / Codex)")
}

# --- Claude Code(尊重 CLAUDE_CONFIG_DIR;Compass/企业版会把配置目录改到别处,如 ~/.claude-compass)---
CLAUDE_BASE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ -d "$CLAUDE_BASE" ]; then install_as_skills "Claude Code" "$CLAUDE_BASE"
else summary+=("– Claude Code  未发现 $CLAUDE_BASE,跳过"); fi

# --- Codex(自带的 skill-installer/skill-creator 确认:从 $CODEX_HOME/skills 自动发现,默认 ~/.codex/skills)---
if [ -d "$HOME/.codex" ]; then
  install_as_skills "Codex" "${CODEX_HOME:-$HOME/.codex}"
else summary+=("– Codex        未发现 ~/.codex,跳过"); fi

# --- Cursor ---
if [ -d "$HOME/.cursor" ]; then install_as_cursor "$HOME/.cursor"
else summary+=("– Cursor       未发现 ~/.cursor,跳过"); fi

# --- OpenClaw(路径不确定,探测几个候选)---
oc=""
for c in "$HOME/.openclaw" "$HOME/.config/openclaw" "$HOME/.open-claw"; do
  [ -d "$c" ] && oc="$c" && break
done
if [ -n "$oc" ]; then install_as_skills "OpenClaw" "$oc"
else summary+=("– OpenClaw     未发现其配置目录,跳过(装好后重跑本脚本,或手动指目录)"); fi

echo
echo "Kala-Skill-Kit 安装结果:"
printf '  %s\n' "${summary[@]}"
echo
echo "装好新工具后,重跑 ./install.sh 即可增量补齐。"
