# Kala-Skill-Kit

我的个人 agent skill 仓库,跨 Claude Code / Codex / Cursor / OpenClaw 共用一套定义。
一个 skill 一处维护,`install.sh` 探测本机装了哪些工具,只往存在的工具里安装。

## 当前 skills

| Skill | 作用 |
|---|---|
| **kala-handoff** | 为长 session 写结构化交接文档,让不同设备/不同 agent 无损接手。覆盖背景、当前状态、过程(含放弃的方案)、关键决策、用户反馈原话、下一步。 |
| **kala-resume** | 换设备/换 agent 后,从项目 `.handoff/` 恢复上一段工作:git pull → 按话题链列出 → 复述理解 → 等确认再动手。 |
| **kala-feishu** | 用你本人的飞书身份(OAuth)读写/管理飞书云文档、知识库与两类表格(创建·写 Markdown 含表格图片·云盘目录·知识库节点·全文评论·电子表格单元格/工作表/行列·多维表格记录/字段)。多账号按租户自动选。含从零部署引导 + 自动化冒烟测试。纯 Node 脚本,零 npm 依赖。 |
| **kala-gog** | 用你本人的 Google 身份(OAuth)读写 Gmail / 日历 / Drive / Docs / Sheets / Contacts,覆盖个人号与 Garena 工作号两个账号。底层是本地 `gog` CLI。含从零部署引导(装 CLI → 配 OAuth 客户端 → 逐账号授权 → 冒烟)与 Windows 指南。 |
| **kala-meeting-minutes** | 根据会议录音转录、白板和样例纪要生成证据可追溯、范围准确、视觉可验收的会议纪要。发布到飞书时依赖 kala-feishu；无飞书能力时生成可换设备继续发布的本地纪要包。 |
| **kala-design-doc** | 创建、编辑、改写或审核中文功能设计文档。用语义底账防止措辞优化改变原意，并检查职责越界、语义重复、抽象术语、无效举例和不必要的技术细节。 |

仓库还维护一份不属于 Skill 的[全局对话表达规范](global-instructions/dialogue-style.md)。它负责日常问答的直答、非技术表达和信息密度；`kala-design-doc` 只在实际创建、修改或审核设计文档时运行。

> 用 `kala-` 前缀是为了和其它来源的同名 skill(如项目 `.agents/skills/` 里的 `handoff`)区分开——同名 skill 在 Codex 等工具的选择器里不会合并、会各列一条。

> **kala-feishu 说明**:它带 `scripts/`(纯 Node,零 npm 依赖)+ `references/`。skill 定义随 git 走;**运行期数据(App 凭证 / OAuth token / 目标位置)落在仓库外的 `~/.kala/feishu/`,不进 git**。每台设备首次用需部署一次(写凭证 + 浏览器授权一次),skill 的 SKILL.md 会引导。Claude Code / Codex / Cursor 三端都可用(OpenClaw 自带飞书工具,明确跳过)。

> **kala-gog 说明**:它是**纯文档 skill**(无 `scripts/`),能力来自宿主机上的 [gogcli](https://github.com/openclaw/gogcli)——二进制命令名是 **`gog`**,不是 `gogcli`。所以"部署"= 装 CLI + 配 OAuth 客户端 + 逐账号授权,**凭证与 token 存进系统密钥链(macOS Keychain / Windows 凭据管理器),不进 git、不跨设备迁移**,换机重新授权一遍即可。账号名册见 [accounts.json](skills/kala-gog/references/accounts.json)。Claude Code / Codex / Cursor 三端可用(OpenClaw 侧已有同源的 `gog` skill,明确跳过)。

> **kala-meeting-minutes 说明**:它带 `scripts/`、`references/` 和 `assets/`,在三端都安装为真正的 skill 目录。飞书读取、账号路由、图片、画板和文档块操作统一复用 kala-feishu,不另存凭证。没有飞书能力时,默认在当前项目 `.meeting-minutes/<日期>-<主题>/` 生成正文、证据映射、HTML 预览、视觉资产、发布计划和 QA 报告;不在项目中时使用 `~/Documents/Kala/MeetingMinutes/`。当前不装到 OpenClaw。

## 安装

```bash
git clone <你的私库URL> ~/MyProjects/Kala-Skill-Kit
cd ~/MyProjects/Kala-Skill-Kit
./install.sh                 # macOS / Linux
# Windows(PowerShell):  node install.mjs
```

> 安装逻辑在跨平台的 `install.mjs`(纯 Node,三平台同一份);`install.sh` 只是 macOS/Linux 的薄封装,参数一致。
> Windows 上部署 kala-feishu 见 [skills/kala-feishu/references/windows-setup.md](skills/kala-feishu/references/windows-setup.md);
> kala-gog 见 [skills/kala-gog/references/windows-setup.md](skills/kala-gog/references/windows-setup.md)。

`install.sh` 会:
- **Claude Code**(`${CLAUDE_CONFIG_DIR:-~/.claude}`)→ 该目录下的 `skills/`。注意:Compass/企业版会用 `CLAUDE_CONFIG_DIR` 把配置目录改到别处(如 `~/.claude-compass`),installer 会自动认这个环境变量,装到它读的地方,而不是默认的 `~/.claude`。
- **Codex**(探测 `~/.codex` 或 `~/.agents`)→ `~/.agents/skills/`。这是个人/可复用 skill 的管理目录;`~/.codex/skills` 仅保留系统或兼容内容,安装器不再往两处重复安装。
- **OpenClaw**(`~/.openclaw`)→ `~/.openclaw/skills/`
- **Cursor**(`~/.cursor`)→ 双轨:**带 `scripts/` 的 skill**(如 kala-feishu、kala-meeting-minutes)装到 `~/.cursor/skills/<名>/`,并按该目录的约定登记 `_manifest.json`、调它自带的 `scripts/generate-index.ps1` 刷新 `_index.md`(没有这套管理文件的机器就只是普通目录);**纯文档的 skill** 生成自包含的 `commands/kala-handoff.md`、`kala-resume.md`、`kala-gog.md`(内容同源,供 `/` 斜杠命令调用)
- 某工具本机没装 → 跳过并在小结里标出。装好后重跑脚本增量补齐,幂等。

改完任何 skill,重跑 `./install.sh` 覆盖更新;跨设备就 `git pull` 后再跑。

### 选择性安装 / 预览(可选)

默认 `./install.sh` 是**全量**:所有 skill → 所有探测到的工具。若某台机器只想装一部分、或想先看清楚会做什么再动手:

```bash
./install.sh --list                              # 列出可选 skill 和工具,不动手
./install.sh --dry-run                           # 预览:只打印会装/覆盖/跳过什么,不改动任何文件
./install.sh kala-handoff kala-resume            # 只装指定的 skill
./install.sh --tools codex,claude                # 只装到指定工具(claude/codex/cursor/openclaw)
./install.sh --dry-run --tools codex kala-feishu # 组合:先预览,确认后去掉 --dry-run 再真装
./install.sh --dry-run --dialogue-style           # 预览 Codex / Claude Code 全局对话规范
./install.sh --dialogue-style                     # 只安装全局对话规范,不安装 skill
./install.sh --dialogue-style kala-design-doc     # 同时安装对话规范和指定 skill
```

`--dry-run` 加在任何命令上都是「只看不装」;看清楚了去掉它再跑一次才真正安装。

`--dialogue-style` 使用带标记的受管区块更新 `~/.codex/AGENTS.md` 和 `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md`。目标文件为空时可直接创建；已有完整 Kala 标记时只更新标记内内容,保留区块外规则；若文件非空但没有完整标记,安装器会暂停且不修改任何目标文件,由 agent 对照[新规则](global-instructions/dialogue-style.md)与现有规则,先向用户提出保留、合并和冲突处理建议。安装一次后,规范会在两个工具的日常对话中自动生效；跨设备时 `git pull` 后重跑该命令。

> 如果你是**负责部署的 agent**,规则和推荐流程见 [AGENTS.md](AGENTS.md)(Claude Code 经 `CLAUDE.md` 自动读取)。

## 设计约定(为什么这么设计)

- **交接文档存在项目里,不在 `~/.claude`**:文档是你产品/设计工作的一部分,跟项目 git 库走。skill *定义*在各工具全局,交接*数据*在项目 `.handoff/`——两者解耦。
- **跨设备靠项目自己的 git 同步**:`handoff` 写完只 `add` 那一个新文件并 push;`resume` 先 `pull`。不依赖任何工具专属机制。
- **数据不绑定 skill**:交接文档是纯 markdown。哪怕某台设备的某个工具没装本 kit,你直接让它「读 `.handoff/` 里最新那个文件继续」也能全量接手——`resume` 只是让这一步更省事。
- **并发 session 隔离**:每次 handoff 是独立新文件 `HANDOFF_{话题}_{时间到分}.md`,frontmatter 用 `chain/seq/parent` 串联同话题、区分不同话题。多条并行的活不会互相覆盖。
- **防遗漏 + 防歪曲**:模板 8 段对应固定信息类别 + 写完 6 项自检(轻量,替代强制 hook 和行数配额);写文件前重读引用的文件、存疑标 `[?]`、用户反馈引用原话。

## 用法

新装或改名后,**要完全重启该工具的 CLI**(skill 注册表在进程启动时建立,只 resume 旧 session 不会重新扫描)。

- Claude Code:`/kala-handoff`(可带话题名)、`/kala-resume`
- Codex:输入 `$` 提及 skill 选 `kala-handoff` / `kala-resume`,或 `/skills` 查看,或自然语言描述意图
- OpenClaw:自然语言触发(说「做个交接 / 恢复上次进度」)

会议纪要任务在三端均可自然语言触发 `kala-meeting-minutes`;例如“根据这份录音转录生成飞书妙记式纪要”或“把白板结论原位替换进现有飞书纪要”。发布到飞书前需保证同一工具已安装并授权 `kala-feishu`。

中文游戏策划案、功能说明、产品需求、PRD、交互说明和 UI/UX 设计等文档的创建、编辑、改写与审核会触发 `kala-design-doc`。它先从项目规范中建立文档契约,再在契约内检查语义失真、职责越界、重复和抽象表达；项目明确要求的模板、字段和验收交付物不会被通用规则擅自删改。普通方案讨论或读取文档后回答问题不触发。

## 加新 skill

在 `skills/` 下新建 `<名字>/SKILL.md`(需要就配套 `TEMPLATE.md`、`references/`、`scripts/` 等),
把名字加进 **`install.mjs`** 的 `SKILLS` 数组(`install.sh` 只是薄封装,不要在它里面另写一份),重跑安装器。
若 OpenClaw 那边已有同源能力,顺手往 `install.mjs` 的 `OPENCLAW_SKIP` 表加一条跳过原因。
