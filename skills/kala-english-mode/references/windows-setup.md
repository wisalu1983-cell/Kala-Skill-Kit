# kala-english-mode:hook 机械兜底的 Windows 部署指南(给部署 agent)

目标:`scripts/wire-hooks.mjs` 在 Windows 上注册出的 hook,效果与 macOS 等价——Claude Code / Codex 每一轮都能收到机械提醒和中文检测结果。

脚本本体(`lib.mjs`/`hook.mjs`)是跨平台的(纯 Node、只用 `os.tmpdir()`/`path.join()`/`fs`,无 shell 调用),不需要按平台改代码。**真正需要按平台确认的只有 `wire-hooks.mjs` 生成的那条注册命令,以及 Codex 特有的一次性信任步骤。**

> ⚠️ 本文由 macOS 侧编写、未在 Windows 实机跑过。首次部署按下面的步骤验证,遇到偏差以实际报错为准并回头修订本文。macOS 上已经做过完整的端到端验证(见下方"macOS 已验证的行为"),Windows 只是同一份逻辑换一层壳。

---

## 步骤 1 — 部署 skill 本体

跟其他 skill 一样先跑仓库自己的安装器(`node install.mjs`),确认 `kala-english-mode` 出现在 `%USERPROFILE%\.claude\skills\` 和 `%USERPROFILE%\.agents\skills\` 下,且各自带着 `scripts\` 子目录(有 `scripts/` 会让 Cursor 的分流逻辑把它当"带脚本"处理,但 kala-english-mode 目前仍在 Cursor 的跳过表里,不受影响)。

## 步骤 2 — 预览要注册的 hook

```powershell
node "$env:USERPROFILE\.claude\skills\kala-english-mode\scripts\wire-hooks.mjs"
```

预期输出第一行是 `检测到系统:Windows`——**先确认这一行,如果没认对系统,后面的路径/命令都不可信,先停下来查 `process.platform` 判断逻辑,不要继续往下走。**

确认预览的两个文件路径正确:
- `%USERPROFILE%\.claude\settings.json`(Claude Code)
- `%USERPROFILE%\.codex\hooks.json`(Codex，或 `%CODEX_HOME%` 指向的路径)

以及 `command` 那一行——应该是 `node.exe "C:\Users\<你>\...\hook.mjs"`(注意是双引号包住绝对路径,不是正斜杠转义出来的东西;如果看到奇怪的反斜杠转义或者引号缺失,说明 `quoteCommand()` 在这台机器上生成的字符串不对,需要回头看 `wire-hooks.mjs` 里的这个函数)。

## 步骤 3 — 确认无误后写入

```powershell
node "$env:USERPROFILE\.claude\skills\kala-english-mode\scripts\wire-hooks.mjs" --yes --default-on --tier basic
```

`--default-on` 是可选的——只有这台设备也要"新 session 默认开启基础档"这条个人偏好时才加;不加就只注册 hook,状态仍要靠对话里显式说「打开英语学习模式」。

写完检查:
```powershell
Get-Content "$env:USERPROFILE\.claude\settings.json" | Select-String -Context 0,10 "hooks"
Get-Content "$env:USERPROFILE\.codex\hooks.json"
```
确认原有的 `permissions`/`model` 等字段还在,只是多了 `hooks` 这一段。如果原文件存在,同目录下应该多出一个 `*.kala-english-mode.bak` 备份——想撤销直接拿备份覆盖回去即可。

## 步骤 4 — Codex 端的一次性信任步骤(容易漏,必须做)

**macOS 上实测发现:Codex 的 hook 不会自动生效**——即便 `hooks.json` 注册完全正确,Codex 也要求在**交互式**会话里手动信任一次,`codex exec`(非交互模式)天生跳不过这一步,所以没法用脚本自动化验证,只能人工做:

1. 在终端(不是 `codex exec`,是直接打 `codex` 进交互式 TUI)里打开一个新会话。
2. 跑 `/hooks`,应该能看到刚注册的这条 `UserPromptSubmit` hook,处于未信任状态;按提示信任它。
3. 信任完之后随便发一句话,确认没有报错,后续每轮回复前 hook 都会静默跑一次(正常情况下你不会看到它的输出——它只是把提醒塞进模型看到的上下文,不会打印到你的终端里)。

这一步**每台设备只需要做一次**(信任状态是持久化的),但换新设备、或者以后改了 `hook.mjs` 的路径重新注册,都需要重新信任一次。

## 步骤 5 — 冒烟验证

Claude Code 端(user-level `settings.json` 的 hook 不需要额外信任步骤,理论上注册完立刻生效——这一点已经在 macOS 上用无头模式实测过,见下方):

```powershell
# 开一个全新会话,发一句中文,确认按两段式格式回复
claude -p "帮我看看这个函数为什么报错"
```

Codex 端(**第一次信任**必须走步骤 4 的交互式流程;信任状态记在 `~/.codex/config.toml` 里、是持久化的,**信任过一次之后**,后续冒烟验证可以直接用 `codex exec` 复测,不用每次都开交互式):

```powershell
codex exec --skip-git-repo-check "这个 bug 我 fix 了但是 test 还没跑,先别 merge"
```

`codex exec` 的输出里能看到 `hook: UserPromptSubmit` 和 `hook: UserPromptSubmit Completed` 这两行日志——**这是判断 hook 是否真的被调用的最直接依据**,比单看模型回复像不像更可靠(回复格式对不代表 hook 生效,可能是模型自己凭 SKILL.md 记性做对了;这两行日志出现,才是 hook 真正跑了的证据)。

两端都测:
- 普通中文输入 → 两段式格式生效。
- 中英混杂输入(如上面例句"这个 bug 我 fix 了但是 test 还没跑")→ English Coach 段落识别出中文片段并给出反馈。
- 「关闭英语学习模式」→ 下一条恢复普通格式。

以上四项(hook 触发日志、普通中文、中英混杂、关闭)已经在 macOS 上用真实 `codex exec` 跑通并逐条核对过。

---

## macOS 已验证的行为(供对照,判断 Windows 上哪些差异是预期内的)

- `lib.mjs`/`hook.mjs` 的开关识别、中文检测、代码块剥离、会话态读写、个人偏好默认值——本地单元测试全部通过,纯 Node 逻辑,Windows 上应该完全一致,不需要重新怀疑这部分。
- `wire-hooks.mjs --dry-run` → `--yes` 的读-改-写合并、幂等性、备份文件——macOS 上完整跑过一遍,行为符合预期。
- Claude Code 的 `UserPromptSubmit` hook:用 `claude -p` 起一个全新无头会话,**真实确认过 hook 会被触发**(会话态文件被正确创建),不需要任何额外信任步骤——这是因为 hook 注册在 user-level 的 `~/.claude/settings.json`,不受"项目未信任"这类限制。
- Codex 的 `UserPromptSubmit` hook:`codex exec`(非交互)测了两次都没触发,查到是"需要交互式 `/hooks` 一次性信任"这个机制导致的,不是接线错误——`hooks.json` 的 schema(`{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"..."}]}]}}`)已经用真实运行的 `codex` 0.144.3 交叉核对过是对的。**这一条已经在 macOS 上由用户本人跑完步骤 4(交互式 `/hooks` 信任)后确认生效**——Windows 部署时预期行为一致,仍建议按步骤 4-5 走一遍确认,而不是假定"跟 macOS 一样所以肯定没问题"。
