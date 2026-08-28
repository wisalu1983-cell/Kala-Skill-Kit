---
title: 审核 kala-english-mode 在 Claude Code 与 ChatGPT Desktop 的 Windows/macOS 兼容性
date: 2026-08-28 18:19
status: 进行中
chain: english-mode-cross-platform-a5c9
seq: 1
parent: none
related: none
---

## 1. 背景与目标

用户期望新版 `kala-english-mode` 同时在 Claude Code 和 ChatGPT Desktop 生效，并兼容 Windows 与 macOS。当前工作先完成新版 skill 与 hook 的本机部署，再按“功能行为、宿主运行面、操作系统、可复跑证据”四个维度做验收。目标不是只证明脚本能运行，而是确认每个新会话默认开启基础档、每条回复遵守两段式格式、中文/英文/混合输入分类正确、当前会话可关闭，并且四个目标组合都有真实证据。审查结论是“部分满足，尚不能验收”：底层实现跨平台且 Codex app-server 路径可执行 hook，但 Claude Code Windows 出现基础档格式缺口，ChatGPT Desktop 尚无直接 UI 端到端测试，macOS 证据也没有以可复跑测试留在仓库。

## 2. 当前状态

- 仓库当前分支为 `main`，开始 handoff 前工作区干净；最近相关提交是 `d9d508b kala-english-mode: 加 hook 机械兜底,解决长对话格式衰减和中文检测不稳定`。
- `kala-english-mode` 权威源目录为 `skills/kala-english-mode/`，当前只有 5 个文件：`SKILL.md`、`references/windows-setup.md`、`scripts/hook.mjs`、`scripts/lib.mjs`、`scripts/wire-hooks.mjs`。
- 仓库内自动化测试文件数量为 `0`；`references/windows-setup.md` 虽写“本地单元测试全部通过”，但没有提交可复跑测试入口。
- 本次用当前源码临时运行了 3 个 `.mjs` 语法检查，全部通过；另运行 16 项核心行为断言，`behavior_failures=0`，覆盖开关、基础/挑战档、中英混合检测、代码块排除、非法 JSON 和关闭后不注入。
- 新版本已部署到 `C:\Users\jiaren.lu\.claude\skills\kala-english-mode` 与 `C:\Users\jiaren.lu\.agents\skills\kala-english-mode`；Cursor/OpenClaw 仍按安装器跳过。
- Claude 用户级 hook 已注册到 `C:\Users\jiaren.lu\.claude\settings.json` 的 `UserPromptSubmit` 和 `SessionStart`；Codex hook 已注册到 `C:\Users\jiaren.lu\.codex\hooks.json` 的 `UserPromptSubmit`。
- 两端 hook 当前都指向 `node.exe "C:\Users\jiaren.lu\.claude\skills\kala-english-mode\scripts\hook.mjs"`；个人偏好为 `defaultEnabled=true`、`defaultTier=basic`。
- 用户已在 Codex CLI 的 `/hooks` 中完成 hook 信任；官方 Codex 文档说明非托管 hook 按当前 hash 信任，改路径或改内容后需重新审查。
- Claude Code Windows 真实端到端测试使用 Claude Code `2.1.196`，hook 确实触发并生成新会话状态文件；回复含 `【English Coach】` 与 `【回答】`，但基础档 `【回答】` 直接进入中文，缺少规范要求的 1–2 句英文摘要。
- Windows Codex app-server 临时、非持久化线程测试收到 `hook_started=1`、`hook_completed=1`，证明 app-server 生命周期能够执行当前用户 hook。
- 第二次 app-server 实测回复为英文摘要在前、中文回答在后，满足基础档语义；hook 生命周期同样完整。
- 本机 ChatGPT Desktop 是 `OpenAI.Codex_26.814.5167.0_x64`，由捆绑的 `codex.exe ... app-server` 驱动；该桌面进程启动于 2026-08-24，早于 2026-08-28 的 hook 注册，当前会话没有完成“完全重启桌面应用后”的直接 UI 验收。
- 官方 Claude Code hooks 文档明确说明终端、IDE 扩展、Claude Desktop 与 Web 都触发同一 hook 事件，并明确支持 Windows PowerShell 与 macOS/Linux 配置。
- 官方 OpenAI Hooks 文档说明 Codex 从 `~/.codex/hooks.json` 发现 hook；官方 App Server 文档说明 app-server 驱动富客户端并发布 `hook/started`、`hook/completed` 事件。因此 ChatGPT Desktop 的架构路径成立，但当前版本仍缺直接桌面 UI 验收与部署后的重启步骤。
- `scripts/lib.mjs:110-117` 的机械提醒只要求“两个区块 + 正常作答”，没有把基础档“英文摘要后再中文”和挑战档“全英文”的完整输出契约注入；这与 Claude Code Windows 的真实失败吻合。
- 从仓库源码目录运行 `scripts/wire-hooks.mjs` 时，dry-run 仍计划追加 hook，因为已注册的是安装目录绝对路径；`alreadyRegistered` 只认同一个脚本路径，源码路径与安装路径会被当成两条 hook，存在重复注入风险。
- `references/windows-setup.md` 仍写“Windows 未实机跑过”，已落后于本次 Windows 实测；其中 macOS 测试是历史文字记录，没有随仓库保留测试代码或当前执行结果。
- earlier Codex CLI 启动曾因 `model_reasoning_effort="max"`、`service_tier="default"` 失败；当场最终回读 `C:\Users\jiaren.lu\.codex\config.toml` 已变为 `model_reasoning_effort="xhigh"`、`service_tier="fast"`，变更来源未在本 session 内核实 `[?]`。

## 3. 过程记录(按时间线)

1. 拉取远端后，按 skill 逐个部署 `kala-feishu` 与 `kala-english-mode`；后者先更新 Claude/Codex skill 本体，再运行 `wire-hooks.mjs --yes --default-on --tier basic` 注册 hook。
2. `wire-hooks.mjs` 在 Windows 上正确识别系统，写入 Claude `settings.json`、Codex `hooks.json` 与 `~/.kala/english-mode/config.json`，并生成 `.kala-english-mode.bak` 备份。
3. 首次尝试进入 Codex CLI 时，配置中的 `model_reasoning_effort="max"` 和 `service_tier="default"` 依次被当前 CLI 拒绝；验证了用 `-c model_reasoning_effort=xhigh -c service_tier=fast` 可按单次启动覆盖，不必改配置。
4. 用户最终进入 Codex CLI 并完成 `/hooks` 信任；此后直接调用 hook 的烟测能输出 `hookSpecificOutput`，中文输入检测和基础档提醒均存在。
5. 起初只根据官方页面是否明确写“desktop”来判断 ChatGPT Desktop，证据不足；随后检查本机进程，确认桌面应用实际启动捆绑的 `codex.exe ... app-server`。
6. 放弃“只看回复像不像两段式就算 hook 生效”的方案，因为 skill/AGENTS 本身也可能让模型自觉遵守；改用临时状态文件、`hook/started` 与 `hook/completed` 作为直接证据。
7. 运行一次性源码断言，16 项通过；同时确认仓库没有测试文件，故这些结果只能证明当前机器当前源码，不构成长期回归保障。
8. Windows Claude Code 端到端测试证明 hook 真触发，但发现基础档英文摘要缺失；因此不能因“两个标题都出现”就判定整个行为契约通过。
9. 用临时、ephemeral 的 Codex app-server 线程测试 ChatGPT Desktop 所依赖的核心路径；hook 生命周期完整，第二次测试的实际回复满足英文摘要 + 中文回答。
10. 放弃在当前 session 内强行重启 ChatGPT Desktop 做 UI 测试，因为这会直接终止承载当前会话的桌面进程；该项留给下一 session/用户手工验收。
11. macOS 方面只确认代码使用 `homedir()`、`tmpdir()`、`path.join()`、`node`/`node.exe` 分支等跨平台实现，并回读历史测试说明；没有当前 macOS 主机，因此未把旧文档结果冒充本次完整证据。
12. 用户随后要求生成 handoff；本次没有修改 `kala-english-mode` 源码、测试或文档，只记录审查结论和下一步。

## 4. 关键决策

- 采用严格验收口径：Claude Code/ChatGPT Desktop × Windows/macOS 四个组合都要有当前证据，不能用“Codex CLI 通过”替代“ChatGPT Desktop 通过”。
- 将“实现架构支持”和“端到端验收通过”分开陈述；app-server hook 事件证明架构可行，但桌面 UI 未重启实测，所以整体仍是部分满足。
- 把基础档完整契约定义为：`【English Coach】` → `【回答】`开头 1–2 句英文摘要 → 空行 → 中文完整回答；只出现两个标题不算通过。
- 使用官方生命周期事件和本机临时状态作为 hook 证据，不以模型输出风格单独证明 hook 被调用。
- 不修改用户不希望修改的 Codex 配置；优先验证单次 `-c` 覆盖。后续回读发现配置值已变化，但不擅自归因。
- 不在当前审查任务里顺手修源码；当前授权是“检查是否满足”，因此只诊断、验证并交接缺口。
- macOS 只给“静态兼容 + 历史记录”结论，不声明当前全量通过；要收口必须在真实 Mac 上复跑四场景。
- 后续 hook 部署必须从安装后的 skill 目录运行，或先修复脚本的旧路径识别；从仓库路径运行会产生重复 hook。

## 5. 用户反馈(尽量引用原话)

> “deploy the new version of both skills one by one”

> “i need the detail steps”

> “那可以直接带参数启动绕开这个问题吗？我不想改配置”

> “hook确认好了。 在codex 桌面客户端里会生效吗”

> “my expectation is the new version of the english mode skill 会生效于 claudecode and chatgpt desktop app and 兼容 windows and mac. Check whether the new version meet my demand?”

## 6. 下一步

1. **P0，接手后第一件事：**先为基础档机械提醒写一个能复现 Claude Code Windows 缺失英文摘要的失败测试，再按 TDD 修改 `scripts/lib.mjs::buildReminder()`，让基础档和挑战档的输出契约都被完整注入。
2. **P0：**在 `skills/kala-english-mode/tests/` 增加可提交、可复跑的 Node 测试，至少覆盖开关、档位、中文检测、代码块排除、非法 JSON、SessionStart、Claude/Codex 输出 schema 和重复路径注册。
3. **P0：**完全退出并重启 ChatGPT Desktop Windows，创建新聊天，验证 `hook/started`/`hook/completed`、普通中文、中英混合、关闭当前会话、新会话恢复默认五项；记录桌面 UI 端到端结果。
4. **P1：**修正 `wire-hooks.mjs` 的幂等策略：按 `kala-english-mode` hook 身份识别并替换旧绝对路径，避免源码目录和安装目录形成重复 hook。
5. **P1：**更新 `README.md`、`SKILL.md` 与 `references/windows-setup.md`，明确目标运行面是 Claude Code + ChatGPT Desktop/Codex app-server，补充完全重启桌面应用、CLI 信任和当前 Windows 实测结论。
6. **P1：**在真实 macOS 上复跑同一套 Claude Code + ChatGPT Desktop 验收矩阵；不能只复用旧 `codex exec` 记录。
7. **P2：**所有自动化和四端验收通过后，重新部署、重启、回读配置，再提交并推送；若只完成部分，按平台明确标注验证边界。

## 7. 待解问题

1. ChatGPT Desktop 在完全重启后是否会直接复用 CLI 已保存的 hook 信任 hash，还是桌面端需要额外审查提示？app-server 临时测试已通过，但桌面 UI 尚未确认。
2. macOS ChatGPT Desktop 是否读取同一 `~/.codex/hooks.json` 和同一用户信任记录？官方 app-server 架构支持该推断，但缺真实 Mac UI 证据。
3. 基础档英文摘要是否必须带字面标签 `TL;DR (EN):`，还是只要 1–2 句英文摘要语义成立即可？当前 `SKILL.md` 文字要求后者，示例使用前者，需要用户决定是否收紧格式。
4. 当前 `config.toml` 从 `max/default` 变为 `xhigh/fast` 的具体来源是什么 `[?]`；若后续做跨设备部署，需要确认是用户手改、CLI/UI 写回还是其他同步机制。

## 8. 快速上手

- 先读 `skills/kala-english-mode/SKILL.md`，确认基础/挑战档完整输出契约与开关语义。
- 再读 `skills/kala-english-mode/scripts/lib.mjs` 和 `scripts/hook.mjs`，重点看 `buildReminder()` 与 `UserPromptSubmit` 数据流。
- 然后读 `skills/kala-english-mode/scripts/wire-hooks.mjs`、`references/windows-setup.md`，核对双端注册、信任、备份、路径幂等和跨平台说明。
- 官方依据：Claude Code hooks `https://code.claude.com/docs/en/hooks`；OpenAI Codex hooks `https://learn.chatgpt.com/docs/hooks`；Codex app-server `https://learn.chatgpt.com/docs/app-server`。
- 相关运行期位置：`C:\Users\jiaren.lu\.claude\settings.json`、`C:\Users\jiaren.lu\.codex\hooks.json`、`C:\Users\jiaren.lu\.kala\english-mode\config.json`、`%TEMP%\kala-english-mode\`。
- 本链为第一棒：`HANDOFF_english-mode-cross-platform_2026-08-28-1819.md`。
- 接手第一步先写并运行“基础档提醒必须含英文摘要契约”的失败测试，确认它确实复现 Claude Code Windows 端到端失败后再改实现。
