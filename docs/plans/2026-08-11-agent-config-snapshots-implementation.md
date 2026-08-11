# Agent 配置快照 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将当前公司设备的 Claude Code 与 Codex 全局规则以可追溯的设备快照形式写入项目。

**Architecture:** 使用 `agent-config/machines/SDXCN-00838980/` 保存当前设备快照，使用 `agent-config/shared/` 预留人工确认后的公共规则；不改变 `skills/` 和现有工具配置。

**Tech Stack:** Markdown、Codex `.rules` 文本、Git。

---

### Task 1: 创建快照目录说明

**Files:**
- Create: `agent-config/README.md`
- Create: `agent-config/shared/README.md`
- Create: `agent-config/machines/SDXCN-00838980/README.md`

**Verification:** 回读目录说明，确认包含设备标识、设备归属、操作系统、来源和排除项。

### Task 2: 写入当前设备规则原文

**Files:**
- Create: `agent-config/machines/SDXCN-00838980/claude/CLAUDE.md`
- Create: `agent-config/machines/SDXCN-00838980/claude/rules/*.md`
- Create: `agent-config/machines/SDXCN-00838980/codex/AGENTS.md`
- Create: `agent-config/machines/SDXCN-00838980/codex/rules/default.rules`

**Verification:** 逐文件与本机来源做 SHA-256 比对；确认未纳入 settings、credentials、token、缓存或会话数据。

### Task 3: 检查项目状态

**Files:**
- Verify: `AGENTS.md`
- Verify: `CLAUDE.md`

**Verification:** `git status --short` 只显示本次新增快照和设计记录文件；`skills/` 内容不变。
