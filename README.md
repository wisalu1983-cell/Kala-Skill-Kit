# Kala-Skill-Kit

我的个人 agent skill 仓库,跨 Claude Code / Codex / Cursor / OpenClaw 共用一套定义。
一个 skill 一处维护,`install.sh` 探测本机装了哪些工具,只往存在的工具里安装。

## 当前 skills

| Skill | 作用 |
|---|---|
| **handoff** | 为长 session 写结构化交接文档,让不同设备/不同 agent 无损接手。覆盖背景、当前状态、过程(含放弃的方案)、关键决策、用户反馈原话、下一步。 |
| **resume** | 换设备/换 agent 后,从项目 `.handoff/` 恢复上一段工作:git pull → 按话题链列出 → 复述理解 → 等确认再动手。 |

## 安装

```bash
git clone <你的私库URL> ~/dev/Kala-Skill-Kit
cd ~/dev/Kala-Skill-Kit
./install.sh
```

`install.sh` 会:
- **Claude Code**(`~/.claude`)→ `~/.claude/skills/`
- **Codex**(`~/.codex`)→ `$CODEX_HOME/skills`(默认 `~/.codex/skills`,Codex 自带的 skill-installer/skill-creator 即从这里自动发现 skill)
- **OpenClaw**(`~/.openclaw`)→ `~/.openclaw/skills/`
- **Cursor**(`~/.cursor`)→ 生成自包含的 `commands/handoff.md`、`resume.md`(内容同源)
- 某工具本机没装 → 跳过并在小结里标出。装好后重跑脚本增量补齐,幂等。

改完任何 skill,重跑 `./install.sh` 覆盖更新;跨设备就 `git pull` 后再跑。

## 设计约定(为什么这么设计)

- **交接文档存在项目里,不在 `~/.claude`**:文档是你产品/设计工作的一部分,跟项目 git 库走。skill *定义*在各工具全局,交接*数据*在项目 `.handoff/`——两者解耦。
- **跨设备靠项目自己的 git 同步**:`handoff` 写完只 `add` 那一个新文件并 push;`resume` 先 `pull`。不依赖任何工具专属机制。
- **数据不绑定 skill**:交接文档是纯 markdown。哪怕某台设备的某个工具没装本 kit,你直接让它「读 `.handoff/` 里最新那个文件继续」也能全量接手——`resume` 只是让这一步更省事。
- **并发 session 隔离**:每次 handoff 是独立新文件 `HANDOFF_{话题}_{时间到分}.md`,frontmatter 用 `chain/seq/parent` 串联同话题、区分不同话题。多条并行的活不会互相覆盖。
- **防遗漏 + 防歪曲**:模板 8 段对应固定信息类别 + 写完 6 项自检(轻量,替代强制 hook 和行数配额);写文件前重读引用的文件、存疑标 `[?]`、用户反馈引用原话。

## 用法

- 工作告一段落 / 上下文快满 / 要换设备时:`/handoff`(可带话题名)
- 换到另一设备或另一个 agent:`/resume`

## 加新 skill

在 `skills/` 下新建 `<名字>/SKILL.md`(需要就配套 `TEMPLATE.md` 等),把名字加进 `install.sh` 的 `SKILLS=(...)`,重跑脚本。
