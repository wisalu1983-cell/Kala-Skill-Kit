# Agent 配置快照目录设计

## 目标

把各台机器的 Claude Code、Codex 全局规则保存到本项目，支持按设备比较和后续人工同步，同时避免与 `skills/` 混淆。

## 方案

使用顶层 `agent-config/` 作为规则快照区，按 `machines/<设备标识>/` 分隔设备；每台设备下再按工具分为 `claude/` 和 `codex/`。`shared/` 只作为经过人工确认后的公共规则区，当前保持空白说明。

当前设备使用主机名 `SDXCN-00838980` 作为稳定标识。

## 纳入与排除

纳入：

- Claude Code 的 `CLAUDE.md` 和 `rules/` 规则文件
- Codex 的 `AGENTS.md` 和 `rules/default.rules`
- 设备归属、操作系统、工具和采集时间等最小元数据

排除：

- settings
- credentials、token、密钥
- 历史记录、缓存、会话数据
- 其他运行期私密配置

## 后续同步原则

新增设备使用新的设备目录，不覆盖已有目录。公共规则只有在跨设备逐项比较并人工确认后，才移动或整理到 `shared/`；本目录暂不引入模板渲染、自动应用或自动合并机制。
