#!/usr/bin/env bash
# Kala-Skill-Kit installer —— 逐工具探测,装到实际存在的工具里,缺的跳过。
#
# 默认全量;支持选择性安装与预览:
#   ./install.sh                          全部 skill → 所有探测到的工具(默认)
#   ./install.sh kala-handoff             只装指定的 skill(可多个)
#   ./install.sh --tools codex,claude     只装到指定工具(claude/codex/cursor/openclaw)
#   ./install.sh --dry-run [...]          只预览会装/覆盖/跳过什么,不真正改动任何文件
#   ./install.sh --list                   列出可选 skill / 工具后退出
#   ./install.sh --help                   显示帮助
#
# 幂等:重复运行 = 用当前 repo 内容覆盖更新。改完 skill 后重跑一次即可。
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$KIT_DIR/skills"
SKILLS=(kala-handoff kala-resume kala-feishu)
TOOLS_ALL=(claude codex cursor openclaw)

# ── 参数解析 ─────────────────────────────────────────────────────────────────
DRY_RUN=0
DO_LIST=0
REQ_TOOLS=""
REQ_SKILLS=()

usage() {
  cat <<EOF
用法: ./install.sh [选项] [skill 名...]

不带参数 = 全部 skill 装到所有探测到的工具(默认行为)。

选项:
  --tools a,b     只装到这些工具(可选: ${TOOLS_ALL[*]})
  --dry-run       只预览会装/覆盖/跳过什么,不真正改动任何文件
  --list          列出可选 skill 和工具,然后退出
  -h, --help      显示本帮助

示例:
  ./install.sh --dry-run                     预览默认的全量安装
  ./install.sh kala-handoff kala-resume      只装这两个
  ./install.sh --tools codex kala-feishu     只把 kala-feishu 装到 Codex
  ./install.sh --dry-run --tools claude      预览:只装到 Claude Code
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --list) DO_LIST=1 ;;
    --tools) shift; [ $# -gt 0 ] || { echo "错误: --tools 后面要跟工具名"; exit 1; }; REQ_TOOLS="$1" ;;
    --tools=*) REQ_TOOLS="${1#--tools=}" ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "错误: 未知选项 $1"; echo; usage; exit 1 ;;
    *) REQ_SKILLS+=("$1") ;;
  esac
  shift
done

# 校验 skill 名
is_known_skill() { local x; for x in "${SKILLS[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
if [ ${#REQ_SKILLS[@]} -gt 0 ]; then
  for s in "${REQ_SKILLS[@]}"; do
    is_known_skill "$s" || { echo "错误: 未知 skill '$s'。可选: ${SKILLS[*]}"; exit 1; }
  done
fi

# 校验工具名
if [ -n "$REQ_TOOLS" ]; then
  IFS=',' read -ra _rt <<< "$REQ_TOOLS"
  for t in "${_rt[@]}"; do
    case " ${TOOLS_ALL[*]} " in *" $t "*) ;; *) echo "错误: 未知工具 '$t'。可选: ${TOOLS_ALL[*]}"; exit 1 ;; esac
  done
fi

# 生效的 skill 集(不指定 = 全部)
if [ ${#REQ_SKILLS[@]} -eq 0 ]; then EFF_SKILLS=("${SKILLS[@]}"); else EFF_SKILLS=("${REQ_SKILLS[@]}"); fi

# 是否安装到某工具(不指定 --tools = 全都要)
want_tool() { [ -z "$REQ_TOOLS" ] && return 0; case ",$REQ_TOOLS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# ── --list ───────────────────────────────────────────────────────────────────
if [ "$DO_LIST" -eq 1 ]; then
  echo "可选 skill:  ${SKILLS[*]}"
  echo "可选工具:    ${TOOLS_ALL[*]}"
  echo "默认行为:    不带参数 = 全部 skill → 所有探测到的工具(kala-feishu 不装到 OpenClaw)"
  exit 0
fi

# 去掉 md 文件开头的 YAML frontmatter,给不吃 frontmatter 的工具(Cursor)用
strip_fm() { awk 'seen<2 { if ($0=="---") seen++; next } { print }' "$1"; }

summary=()

# 安装(或预览)一组 SKILL 目录到某工具
install_as_skills() {
  local label="$1" base="$2" skip="${3:-}"
  local dest="$base/skills"
  summary+=("  $label  →  $dest")
  local any=0 s state
  for s in "${EFF_SKILLS[@]}"; do
    any=1
    if [[ " $skip " == *" $s "* ]]; then
      summary+=("      - $s : 跳过(OpenClaw 自带飞书工具)")
      [ "$DRY_RUN" -eq 0 ] && rm -rf "$dest/$s"   # 真跑时清掉历史遗留
      continue
    fi
    state="新建"; [ -e "$dest/$s" ] && state="覆盖(已存在)"
    summary+=("      - $s : $state")
    if [ "$DRY_RUN" -eq 0 ]; then
      mkdir -p "$dest"; rm -rf "$dest/$s"; cp -R "$SRC/$s" "$dest/$s"
    fi
  done
  [ "$any" -eq 0 ] && summary+=("      (本次没有要装到这里的 skill)")
  return 0
}

# Cursor 不吃 SKILL 目录:只把 handoff/resume 转成自包含 command md(feishu 带脚本,跳过)
install_as_cursor() {
  local base="$1" dest="$base/commands"
  summary+=("  Cursor  →  $dest")
  local did=0 s
  for s in "${EFF_SKILLS[@]}"; do
    case "$s" in
      kala-handoff)
        did=1
        summary+=("      - kala-handoff.md : $( [ -e "$dest/kala-handoff.md" ] && echo 覆盖 || echo 新建 )")
        if [ "$DRY_RUN" -eq 0 ]; then
          mkdir -p "$dest"
          { strip_fm "$SRC/kala-handoff/SKILL.md"; echo; echo "---"; echo "# 附:交接文档模板(上文步骤 4/5 引用的 TEMPLATE)"; echo; cat "$SRC/kala-handoff/TEMPLATE.md"; } > "$dest/kala-handoff.md"
        fi ;;
      kala-resume)
        did=1
        summary+=("      - kala-resume.md : $( [ -e "$dest/kala-resume.md" ] && echo 覆盖 || echo 新建 )")
        if [ "$DRY_RUN" -eq 0 ]; then mkdir -p "$dest"; strip_fm "$SRC/kala-resume/SKILL.md" > "$dest/kala-resume.md"; fi ;;
      *)
        summary+=("      - $s : 跳过(Cursor 不装带脚本的 skill)") ;;
    esac
  done
  [ "$did" -eq 0 ] && summary+=("      (本次没有可装到 Cursor 的 skill)")
  return 0
}

# ── 逐工具探测 + 安装 ─────────────────────────────────────────────────────────
# Claude Code(尊重 CLAUDE_CONFIG_DIR;Compass/企业版会把配置目录改到别处)
if want_tool claude; then
  CLAUDE_BASE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if [ -d "$CLAUDE_BASE" ]; then install_as_skills "Claude Code" "$CLAUDE_BASE"
  else summary+=("–  Claude Code 未发现 $CLAUDE_BASE,跳过"); fi
fi

# Codex(默认 ~/.codex/skills 自动发现)
if want_tool codex; then
  if [ -d "$HOME/.codex" ]; then install_as_skills "Codex" "${CODEX_HOME:-$HOME/.codex}"
  else summary+=("–  Codex 未发现 ~/.codex,跳过"); fi
fi

# Cursor
if want_tool cursor; then
  if [ -d "$HOME/.cursor" ]; then install_as_cursor "$HOME/.cursor"
  else summary+=("–  Cursor 未发现 ~/.cursor,跳过"); fi
fi

# OpenClaw 自带飞书工具(feishu_doc/drive/wiki/perm),kala-feishu 对它冗余且会造成触发歧义,故明确跳过
if want_tool openclaw; then
  oc=""
  for c in "$HOME/.openclaw" "$HOME/.config/openclaw" "$HOME/.open-claw"; do
    [ -d "$c" ] && oc="$c" && break
  done
  if [ -n "$oc" ]; then install_as_skills "OpenClaw" "$oc" "kala-feishu"
  else summary+=("–  OpenClaw 未发现其配置目录,跳过(装好后重跑本脚本)"); fi
fi

# ── 输出 ─────────────────────────────────────────────────────────────────────
echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "Kala-Skill-Kit 安装预览 —— --dry-run,不会真正改动任何文件:"
else
  echo "Kala-Skill-Kit 安装结果:"
fi
printf '%s\n' "${summary[@]}"
echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "以上仅预览。确认无误后,去掉 --dry-run 再运行,才会真正安装。"
else
  echo "装好新工具后,重跑 ./install.sh 即可增量补齐。"
fi
