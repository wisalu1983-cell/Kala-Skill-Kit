# 第三方 Skill 库存

这里存放从开源仓库拉来的第三方 skill,作为**取用源和参考基准**。

- **不是部署源**:`install.mjs` 不碰这个目录,装机时不会自动安装这里的任何东西。
- **取用方式**:手工把需要的 skill 目录拷到目标位置(某个项目的 `.claude/skills/`,或全局 `~/.claude/skills/`)。
- **为什么留全量**:换新机器时打开本文件就知道自己有哪些可选 skill;跟上游做 diff 时也需要一个完整基准。

---

## mattpocock-skills

| | |
|---|---|
| 上游 | https://github.com/mattpocock/skills |
| 快照 commit | `6eeb81b` (2026-06-18) |
| 拉取日期 | 2026-06-22 |
| 本地路径 | `_upstream/mattpocock-skills/` |
| 规模 | 34 个 skill,475K 纯文本 |
| 作者推荐的安装方式 | `npx skills add mattpocock/skills`(见下方「为什么不用它」) |

### 已在项目中取用(11 个)

全部在 **Trumen** 项目的 `.claude/skills/` 下,项目级使用:

`codebase-design` `diagnosing-bugs` `domain-modeling` `git-guardrails-claude-code`
`grill-me` `grill-with-docs` `grilling` `handoff` `prototype` `tdd` `to-issues`

其中 **`grilling` 有本地定制**——在上游原文后追加了一整段「Evidence Discipline(证据纪律)」协议:每个 grill 问题回答前必须先列出相关文档、实际查证、在回答开头给出带 `file:line` 的「已查证事实」段;每个断言标注是有出处的事实还是纯工程判断;用户可随时抽查出处。定制版的权威副本在 Trumen 项目里(已入 git),**不在本库存目录**。其余 10 个与上游一字不差。

> `grill-me` 和 `grill-with-docs` 只是入口(正文各一句话),真正的规则在 `grilling` 里。改定制只改 `grilling`,两个入口自动继承。

### 未取用的正式发布 skill(7 个)

作者在 `plugin.json` 里正式发布了 17 个,以下 7 个还没用过。全部是**手动触发**(`disable-model-invocation: true`),不会被模型自动拉起:

| skill | 作用 |
|---|---|
| `ask-matt` | 路由器:问它「我这情况该用哪个 skill」 |
| `triage` | 把 issue 和外部 PR 过一遍状态机:分类、核实、必要时 grill、产出可直接交给 agent 的简报 |
| `improve-codebase-architecture` | 扫代码库找可深化的点,出可视化 HTML 报告,再 grill 你挑中的那个 |
| `setup-matt-pocock-skills` | 一次性配置:给某个仓库设定 issue 追踪位置、triage 标签词汇、领域文档布局。首次用其他 engineering skill 前跑 |
| `to-prd` | 把当前对话直接合成 PRD 并发到项目 issue 追踪器,不再反问 |
| `teach` | 在当前工作区里教你一个新技能或概念 |
| `writing-great-skills` | 参考文档:怎么写好一个 skill,术语和原则 |

### 其余 16 个

`in-progress/`(5)是作者未完成的草稿,`personal/`(2)绑定作者自己的环境,`deprecated/`(4)已废弃,`misc/`(4)中只有 `git-guardrails-claude-code` 已取用。这些不建议直接用,需要时自己读了再判断。

### 更新流程

本目录**没有 `.git`**(删掉了,避免嵌套仓库)。要看上游改了什么,临时拉一份做 diff:

```bash
git clone --depth 1 https://github.com/mattpocock/skills.git /tmp/mp-new
diff -rq /tmp/mp-new/skills third-party/_upstream/mattpocock-skills/skills
```

确认要更新后,用新版覆盖本目录(记得保留 `.claude-plugin.disabled` 的改名,见下),并回来更新上面的 commit 和日期。

**同步定制版要小心**:`grilling` 的上游版和 Trumen 里的定制版是两条线。上游若改了 `grilling`,要人工把改动合进 Trumen 那份,不能直接覆盖。

### `.claude-plugin.disabled` 是怎么回事

上游自带 `.claude-plugin/plugin.json`,声明了 17 个 skill。Claude Code 只要在扫描路径下发现这个文件,就会把整个目录当成一个名为 `mattpocock-skills` 的本地插件加载。

2026-06 到 08 期间这个 clone 被放在 Trumen 项目的 `.claude/skills/` 下,结果同一批 skill 被加载了两次:顶层副本给出 `grill-me`,插件给出 `mattpocock-skills:grill-me`,10 个 skill 各出现两遍,选错版本会拿到未定制的上游行为。

现在把该目录改名为 `.claude-plugin.disabled`,插件身份失效。**不要改回原名,也不要把本目录放到任何 `.claude/` 路径下。**

> 补充:这个仓库没有 `marketplace.json`,所以它也装不进 Claude Code 的原生插件市场。作者推荐的 `npx skills add`(vercel-labs/skills CLI)落点就是 `.claude/skills/`,跟手工拷贝形态完全一样,但官方文档没有说明 `update` 如何处理本地修改、也没有冲突检测——对有定制的 skill 有静默覆盖风险,所以这里选择手工管理。
