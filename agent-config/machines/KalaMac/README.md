# KalaMac

- 设备归属：公司
- 操作系统：macOS 26.6.1（Build 25G76）
- 主要工具：Claude Code、Codex、OpenClaw
- 采集时间：2026-09-08

## 快照来源

- `/Users/jiaren.lu/.claude/CLAUDE.md`
- `/Users/jiaren.lu/.codex/AGENTS.md`

本机没有 `~/.claude/rules/`，也没有 `~/.codex/rules/`：对应的规则已经并入上面两个文件的正文。

## 说明

- 设备标识取 macOS 的 ComputerName / LocalHostName（`KalaMac`），不取 `hostname` 输出的机器编号。
- 两份文件末尾的「全局对话表达」都在 `<!-- kala-skill-kit:dialogue-style -->` 标记块内，由 `install.mjs --dialogue-style` 安装；要改这一段应回到仓库的 `global-instructions/dialogue-style.md`，不要直接改快照。
- 「kala-english-mode 全局默认」两节于 2026-09-08 改为「新 session 默认不启用」，与本机个人偏好 `~/.kala/english-mode/config.json`（`defaultEnabled=false`）一致。该偏好文件按设计不进 git。

## 排除项

未收录 settings、credentials、token、历史记录、缓存、会话数据和其他运行期私密配置。
