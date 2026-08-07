# Kala-MeetingMinutes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 本次用户已明确要求不创建 worktree；受当前会话禁止子代理约束，主 agent 在当前工作区逐项执行并自行复核。

**Goal:** 新增 `kala-meeting-minutes`，稳定将录音转录转换为证据可追溯、视觉可验收且可由 `kala-feishu` 精确发布的会议纪要，并部署到 Codex、Claude Code、Cursor。

**Architecture:** Skill 采用轻量编排层：`SKILL.md` 路由工作阶段，`references/` 定义内容与飞书版式方法，`assets/` 固定交付结构，纯 Node 脚本验证待发布包。飞书 API、账号路由、图片和画板操作全部复用 `kala-feishu`。

**Tech Stack:** Markdown、JSON、HTML、Node.js 18+ 标准库、PowerShell 验证脚本、Kala-Skill-Kit 跨平台安装器。

---

### Task 1: 为本地纪要包验证器建立失败测试

**Files:**
- Create: `tests/kala-meeting-minutes-validator.test.mjs`
- Test: `skills/kala-meeting-minutes/scripts/validate-package.mjs`

**Step 1: 写验证器契约测试**

使用 Node 内置 `node:test` 创建临时目录，覆盖：完整包通过、缺少必需文件失败、正文缺少必需章节失败、证据映射引用不存在失败、发布计划使用绝对路径失败。

**Step 2: 运行测试确认失败**

Run: `node --test tests/kala-meeting-minutes-validator.test.mjs`

Expected: FAIL，原因是 `validate-package.mjs` 尚不存在。

**Step 3: 提交失败测试**

```powershell
git add -- tests/kala-meeting-minutes-validator.test.mjs
git commit -m "test: 定义会议纪要包验证契约"
```

### Task 2: 实现待发布纪要包验证器

**Files:**
- Create: `skills/kala-meeting-minutes/scripts/validate-package.mjs`

**Step 1: 实现最小验证逻辑**

验证以下内容并输出 JSON：

- 必需文件 `meeting-minutes.md`、`source-map.json`、`preview.html`、`publish-plan.json`、`qa-report.md`、`visuals/`；
- 正文必需章节与完整转录策略；
- `source-map.json` 每个关键结论/待办含证据或明确的未确认状态；
- `publish-plan.json` 含目标、操作语义、目标位置和相对资产路径；
- 资产引用存在且不能逃出包目录；
- HTML 预览包含标题与正文容器；
- 校验失败时退出码为 1，成功时为 0。

**Step 2: 运行测试确认通过**

Run: `node --test tests/kala-meeting-minutes-validator.test.mjs`

Expected: 所有测试 PASS。

**Step 3: 运行语法检查**

Run: `node --check skills/kala-meeting-minutes/scripts/validate-package.mjs`

Expected: exit 0。

**Step 4: 提交实现**

```powershell
git add -- skills/kala-meeting-minutes/scripts/validate-package.mjs
git commit -m "feat: 添加会议纪要包验证器"
```

### Task 3: 编写 Skill 主流程、参考规范和模板

**Files:**
- Create: `skills/kala-meeting-minutes/SKILL.md`
- Create: `skills/kala-meeting-minutes/references/content-workflow.md`
- Create: `skills/kala-meeting-minutes/references/feishu-layout-guide.md`
- Create: `skills/kala-meeting-minutes/references/qa-rubric.md`
- Create: `skills/kala-meeting-minutes/references/offline-package.md`
- Create: `skills/kala-meeting-minutes/assets/meeting-minutes-template.md`
- Create: `skills/kala-meeting-minutes/assets/preview-template.html`
- Create: `skills/kala-meeting-minutes/assets/publish-plan.example.json`

**Step 1: 编写 `SKILL.md`**

要求：

- 名称为 `kala-meeting-minutes`，显示标题使用 `Kala-MeetingMinutes`；
- 触发范围覆盖会议转录、录音转文字、妙记式纪要、会议总结、待办提炼、飞书会议纪要和纪要排版；
- 每次先判断输入证据与 `kala-feishu` 能力；
- 依次执行证据账本、范围锁定、内容生成、视觉规划、双 QA、发布/降级；
- 飞书删除或替换前继承 `kala-feishu` 的明确确认规则；
- 只有链接但无法读取时停止猜测；
- `SKILL.md` 控制在 500 行内，通过明确路由渐进读取参考文件。

**Step 2: 编写四份参考规范**

将本次经验泛化为内容提炼方法、飞书版式/位置规则、验收量表和离线包协议。避免写入本次会议的具体事实作为通用规则。

**Step 3: 编写三份模板资产**

模板必须可直接复制，不含本次会议的参考内容。HTML 使用系统字体、响应式宽度和明确的视觉占位区。发布计划示例只使用相对路径。

**Step 4: 运行静态检查**

Run:

```powershell
node --check skills/kala-meeting-minutes/scripts/validate-package.mjs
rg -n "LLM 决定|GOAP|武向辰|黄宇宸|8 月" skills/kala-meeting-minutes
```

Expected: 第一条 exit 0；第二条只允许方法示例中必要的抽象说明，不应泄露本次会议人物或范围事实。

**Step 5: 提交 Skill 内容**

```powershell
git add -- skills/kala-meeting-minutes
git commit -m "feat: 新增 Kala-MeetingMinutes 工作流"
```

### Task 4: 添加语义评测用例和代表性离线包

**Files:**
- Create: `skills/kala-meeting-minutes/evals/evals.json`
- Create: `tests/fixtures/meeting-minutes/valid-package/**`

**Step 1: 写三类真实评测提示**

覆盖完整飞书工作流、无飞书能力降级、证据不足停止三个场景。每项写明预期输出与可量化检查项。

**Step 2: 建立匿名化有效包 fixture**

使用虚构项目与人物，覆盖总结、关键结论、待办、章节、视觉资产、证据映射和发布计划；不得复制本次会议敏感内容。

**Step 3: 用真实验证器检查 fixture**

Run: `node skills/kala-meeting-minutes/scripts/validate-package.mjs tests/fixtures/meeting-minutes/valid-package`

Expected: 输出 `ok: true`，exit 0。

**Step 4: 运行完整测试**

Run: `node --test tests/kala-meeting-minutes-validator.test.mjs`

Expected: 0 failures。

**Step 5: 提交评测与 fixture**

```powershell
git add -- skills/kala-meeting-minutes/evals tests/fixtures/meeting-minutes
git commit -m "test: 添加会议纪要技能评测样例"
```

### Task 5: 扩展跨平台安装器并建立失败测试

**Files:**
- Create: `tests/install-kala-meeting-minutes.test.mjs`
- Modify: `install.mjs`

**Step 1: 写安装器失败测试**

通过临时 HOME 验证：

- `--list` 包含 `kala-meeting-minutes`；
- Codex 目标是 `~/.agents/skills`，不生成 `~/.codex/skills/kala-meeting-minutes`；
- Claude Code 与 Cursor 使用各自 `skills/`；
- 三端存在 `_manifest.json` 时均登记为 `source: local`；
- 有索引生成脚本时刷新 `_index.md`；
- `--dry-run` 不写文件。

**Step 2: 运行测试确认失败**

Run: `node --test tests/install-kala-meeting-minutes.test.mjs`

Expected: FAIL，原因是新 Skill 尚未注册，Codex 仍指向 `~/.codex/skills`。

**Step 3: 最小修改安装器**

- 将 `kala-meeting-minutes` 加入 `SKILLS`；
- 增加仅用于测试/显式部署的 `KALA_SKILL_HOME` 根目录覆盖；
- Codex 发现 `~/.codex` 或 `~/.agents` 时安装到 `~/.agents/skills`；
- 将 manifest/index 更新逻辑泛化给 Claude Code、Codex 和 Cursor；
- 保持 OpenClaw 现有跳过规则不变；
- 保持 `install.sh` 仅为薄封装。

**Step 4: 运行安装器测试**

Run: `node --test tests/install-kala-meeting-minutes.test.mjs`

Expected: 0 failures。

**Step 5: 提交安装器改动**

```powershell
git add -- install.mjs tests/install-kala-meeting-minutes.test.mjs
git commit -m "feat: 支持三端部署会议纪要技能"
```

### Task 6: 更新仓库说明

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

**Step 1: 更新 Skill 清单和使用说明**

补充 `kala-meeting-minutes` 的用途、`kala-feishu` 依赖、离线包路径、三端安装方式和无 Feishu 能力时的行为。

**Step 2: 更新 Codex 真实目录说明**

将 `~/.codex/skills` 改为 `~/.agents/skills`，说明 `.codex/skills` 仅为兼容/系统目录，避免重复安装。

**Step 3: 检查文档引用**

Run:

```powershell
rg -n "kala-meeting-minutes|\.agents/skills|\.codex/skills" README.md AGENTS.md install.mjs
```

Expected: 新 Skill 三处均有入口；Codex 目标无矛盾说明。

**Step 4: 提交文档**

```powershell
git add -- README.md AGENTS.md
git commit -m "docs: 补充会议纪要技能部署说明"
```

### Task 7: 运行项目级验证并生成安装预览

**Files:**
- Verify only

**Step 1: 运行所有 Node 测试**

Run: `node --test tests/*.test.mjs`

Expected: 0 failures。

**Step 2: 验证所有新增脚本语法**

Run: `Get-ChildItem skills/kala-meeting-minutes/scripts -Filter *.mjs | ForEach-Object { node --check $_.FullName }`

Expected: 全部 exit 0。

**Step 3: 运行 Skill 布局检查**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\jiaren.lu\.agents\skills\scripts\validate-skill-layout.ps1`

Expected: 无新增布局错误。

**Step 4: 生成三端安装预览**

Run: `node install.mjs --dry-run --tools codex,claude,cursor kala-meeting-minutes`

Expected: 只显示三个明确目标和 manifest/index 计划，不改本机文件。

**Step 5: 向用户展示预览并取得安装确认**

项目 `AGENTS.md` 要求真实覆盖安装前必须执行这一步。

### Task 8: 部署三端并验证

**Files:**
- Install to: `C:\Users\jiaren.lu\.agents\skills\kala-meeting-minutes\**`
- Install to: `C:\Users\jiaren.lu\.claude\skills\kala-meeting-minutes\**`
- Install to: `C:\Users\jiaren.lu\.cursor\skills\kala-meeting-minutes\**`
- Modify: each root `_manifest.json` and `_index.md`

**Step 1: 用户确认后执行选择性安装**

Run: `node install.mjs --tools codex,claude,cursor kala-meeting-minutes`

Expected: 三端均报告新建或覆盖，Cursor 以 Skill 目录安装。

**Step 2: 验证文件一致性**

逐端比较 `SKILL.md` 和验证脚本 SHA-256，三个目标必须与仓库源一致。

**Step 3: 验证 manifest/index**

确认三端 `_manifest.json` 含 `kala-meeting-minutes`，`_index.md` 包含同名条目。

**Step 4: 对三端运行包验证器**

分别从三个安装目录执行 `validate-package.mjs` 检查同一 fixture。

Expected: 三次均 `ok: true`。

### Task 9: 最终回读、提交与交付

**Files:**
- Verify: all changed files

**Step 1: 检查仓库状态和差异**

Run: `git status --short`、`git diff --check HEAD~6..HEAD`。

Expected: 只有本功能文件；无空白错误。

**Step 2: 运行最终完整验证**

重新执行 Task 7 的全部验证和 Task 8 的三端一致性检查，不能使用旧结果。

**Step 3: 确认提交历史**

Run: `git log --oneline -8`

Expected: 设计、测试、实现、安装器、文档提交完整；不包含无关改动。

**Step 4: 向用户交付**

报告已完成项、测试范围、三端安装路径、需要重启的工具、未执行的真实飞书破坏性发布测试及其原因。未经用户明确要求不 push。
