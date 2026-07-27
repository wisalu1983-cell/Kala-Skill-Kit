# kala-feishu:Windows 部署指南(给部署 agent)

目标:**部署后与 macOS 效用等价**——同样的读写/云盘/知识库/评论能力、同样的多账号自动路由、同样的 token 自动保活。

脚本本体是跨平台的(纯 Node、无 shell 依赖、`os.homedir()` + `path.join`、`chmod` 已 try/catch),
**真正需要按平台处理的只有三件事:安装器入口、路径写法、定时保活。** 下面逐条给 Windows 做法。

> ⚠️ 本文的 Windows 命令由 macOS 侧编写、未在 Windows 实机执行过。首次部署时请按步验证,
> 遇到偏差以实际报错为准并回头修订本文。脚本本体的跨平台性是**代码层面核实过**的(见文末)。

---

## 平台差异速查

| 项 | macOS / Linux | Windows |
|---|---|---|
| 安装器 | `./install.sh`(薄封装) | **`node install.mjs`**(同一份逻辑) |
| 运行期数据 | `~/.kala/feishu/` | `%USERPROFILE%\.kala\feishu\` |
| Claude Code skills | `~/.claude/skills/` | `%USERPROFILE%\.claude\skills\` |
| Codex skills | `~/.codex/skills/` | `%USERPROFILE%\.codex\skills\` |
| 设环境变量(单次) | `KALA_FEISHU_ACCOUNT=x node …` | `$env:KALA_FEISHU_ACCOUNT="x"; node …` |
| 定时保活 | launchd plist | **任务计划程序**(Task Scheduler) |
| 文件权限收紧 | `chmod 600`(脚本自动做) | `chmod` 无效(自动跳过),需 `icacls`(见下) |

---

## 步骤 0 — 前置

```powershell
node -v          # 需 ≥ 18(全局 fetch)
git --version
```
没有 Node:`winget install OpenJS.NodeJS.LTS`(装完**重开终端**)。

## 步骤 1 — 拉仓库

```powershell
git clone <你的私库URL> "$env:USERPROFILE\MyProjects\Kala-Skill-Kit"
cd "$env:USERPROFILE\MyProjects\Kala-Skill-Kit"
```

## 步骤 2 — 安装 skill(先预览)

```powershell
node install.mjs --list       # 看有哪些 skill / 工具
node install.mjs --dry-run    # 预览会装/覆盖/跳过什么,不改动任何文件
node install.mjs              # 确认无误后真正安装
```

选择性安装同 macOS:`node install.mjs --tools codex kala-feishu`。
装完**重启对应 CLI**(skill 在 CLI 启动时注册)。

## 步骤 3 — 写 App 凭证(每个飞书组织一份)

凭证不随 git 走,新机必须重新写。**secret 由用户提供**,写进 `%USERPROFILE%\.kala\feishu\<账号>.config.json`:

```powershell
$skill = "$env:USERPROFILE\.claude\skills\kala-feishu"
$env:KALA_FEISHU_ACCOUNT = "personal"         # 换成目标账号名
node -e "import('file:///$($skill -replace '\\','/')/scripts/feishu-config.mjs').then(m=>m.saveAppCredentials('cli_xxxx','SECRET_HERE'))"

node "$skill\scripts\feishu-config.mjs"        # 自检:secret 只显示长度,不回显明文
```

> 也可以直接手写 JSON 文件(内容 `{"appId":"cli_xxxx","appSecret":"xxxx"}`),效果一样。

**收紧权限**(Windows 没有 chmod,脚本会自动跳过;建议手动做一次):
```powershell
icacls "$env:USERPROFILE\.kala\feishu" /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
```

## 步骤 4 — OAuth 授权(每个账号一次,用户本人点)

```powershell
$env:KALA_FEISHU_ACCOUNT = "personal"
node "$env:USERPROFILE\.claude\skills\kala-feishu\scripts\feishu-oauth.mjs" auth
```
把打印出的链接给用户,**用户在浏览器点授权**;回调 `http://127.0.0.1:9876/callback`(回环地址,Windows 防火墙通常不拦;若被拦,放行 node.exe 的本地回环即可)。

多个组织就把 `KALA_FEISHU_ACCOUNT` 换成各自的账号名,**各跑一次**。

## 步骤 5 — 冒烟验证(与 macOS 同一套)

```powershell
node "$env:USERPROFILE\.claude\skills\kala-feishu\scripts\selftest.mjs"
```
预期与 macOS 一致:P0–P6 全绿(云盘/文档/知识库/评论/token),隔离容器测完自动清理。

## 步骤 6 — token 自动保活(替代 launchd)

macOS 用 launchd,Windows 用**任务计划程序**跑同一个 `keepalive.mjs`(它会遍历所有账号)。

**推荐:脚本自动注册**(内部用 `schtasks /Create`,每周一 09:00,注册后立即跑一次):

```powershell
node "$env:USERPROFILE\.claude\skills\kala-feishu\scripts\setup-keepalive.mjs"
node "$env:USERPROFILE\.claude\skills\kala-feishu\scripts\setup-keepalive.mjs" --status
```

若脚本注册失败,再用下面的手动 PowerShell 方式(等价):

```powershell
$node   = (Get-Command node).Source
$script = "$env:USERPROFILE\MyProjects\Kala-Skill-Kit\skills\kala-feishu\scripts\keepalive.mjs"
$log    = "$env:USERPROFILE\.kala\feishu\keepalive.log"

$action  = New-ScheduledTaskAction -Execute "cmd.exe" `
           -Argument "/c `"`"$node`" `"$script`" >> `"$log`" 2>&1`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
Register-ScheduledTask -TaskName "KalaFeishuTokenRefresh" -Action $action -Trigger $trigger `
  -Description "kala-feishu 多账号 OAuth token 保活" -Force
```

立即跑一次验证:
```powershell
Start-ScheduledTask -TaskName "KalaFeishuTokenRefresh"
Get-Content "$env:USERPROFILE\.kala\feishu\keepalive.log" -Tail 5
```
预期日志:`保活 N 个账号: …` + 每个账号 `✅ 刷新成功`。

> 为什么必须保活:refresh_token 约 30 天,某个组织长期不用就会过期、需重新浏览器授权。
> **不要**让定时任务直接跑 `feishu-oauth.mjs refresh`——那只刷默认账号(`personal`)一个。

---

## 命令写法对照(agent 常用)

| 操作 | macOS/Linux | Windows PowerShell |
|---|---|---|
| 指定账号跑命令 | `KALA_FEISHU_ACCOUNT=x node a.mjs` | `$env:KALA_FEISHU_ACCOUNT="x"; node a.mjs` |
| 脚本目录变量 | `SKILL_DIR="$HOME/.claude/skills/kala-feishu"` | `$skill="$env:USERPROFILE\.claude\skills\kala-feishu"` |
| 调脚本 | `node "$SKILL_DIR/scripts/x.mjs"` | `node "$skill\scripts\x.mjs"` |
| 看账号与路由 | `node …/feishu-route.mjs --list` | 同左(路径换写法) |

> Node 在 Windows 上也接受正斜杠,所以 `node "$skill/scripts/x.mjs"` 同样能跑;
> 反斜杠只是更符合 Windows 习惯。**在 PowerShell 里给 `-e` 传 `import()` 时用正斜杠更省事**(见步骤 3)。

## 跨平台等价性:代码层面已核实的点

- 无写死 Unix 路径、不读 `HOME`/`USERPROFILE`,统一用 `os.homedir()` → Windows 自动落到 `C:\Users\<你>\`。
- 不调用任何 shell 或 Unix 命令;子进程一律 `execFileSync(process.execPath, …)`(不经 shell)。
- 所有 `chmodSync` 都包了 try/catch,Windows 上静默跳过、不报错。
- 安装器 `install.mjs` 用 `fs.cpSync/rmSync`,不依赖 `cp -R`/`rm -rf`。
- OAuth 回调、HTTP、multipart 上传全用 Node 内置 API,无平台分支。

**唯一平台相关的是本文档写的那三件事**(安装器入口、路径写法、定时保活)。
