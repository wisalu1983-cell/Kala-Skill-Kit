---
name: kala-handoff
description: 为长 session 写结构化交接文档,让不同设备/不同 agent 无损接手工作。覆盖背景、过程、现状、决策、用户反馈、下一步。跨 session 并发隔离,git 同步。
argument-hint: "[可选:话题名或交接原因,如 landing 改版 / 上下文快满了]"
allowed-tools: Bash, Read, Write, Edit, Glob
---

# 写交接文档 (Handoff)

**只在用户明确要求「做交接 / 写 handoff / 保存进度」时运行。** 若只是在讨论 handoff 是什么、要不要做,先问清,不要擅自写文件。绝不脱离本流程随手生成一份「看起来像交接」的自由格式总结——那会丢掉链追踪、并发隔离和自检。

参数 `$ARGUMENTS` 若有,当作话题/原因的软提示,对话内容才是事实来源。

## 步骤 1:定位交接目录

交接文档放**当前项目**里,不放 `~/.claude`。确定目录:
```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
mkdir -p "$ROOT/.handoff"
```
`.handoff/` 是隐藏目录,同一项目下可并存任意多份交接文档。

## 步骤 2:判定 chain(话题链)——轻量,不猜

只按两条规则,取先命中的:
1. **本 session 开场读/粘贴过某个已有 handoff 文件** → 那个就是 parent;继承它的 `chain`,`seq = parent.seq + 1`,`parent = 那个文件名`。
2. **否则一律当新链**:`seq = 1`,`parent = none`,`chain = {话题 2-3 词 kebab slug}-{4位随机hex}`。随机后缀保证两个并发 session 绝不撞同一个 chain。生成:
   ```bash
   python3 -c "import secrets; print(secrets.token_hex(2))"
   ```

扫一眼同目录其它 handoff:`ls "$ROOT/.handoff/"`。若有**并行但无关**的(不是本链 parent),把文件名填进 frontmatter 的 `related`,当参考,**不合并**。拿不准是不是续接,就问用户,别硬认。

## 步骤 3:收集事实(不凭记忆)

```bash
date "+%Y-%m-%d %H:%M"          # 真实时间,别用系统给的日期
git -C "$ROOT" log --oneline -10 2>/dev/null   # 有 git 才有输出
git -C "$ROOT" status -s 2>/dev/null
```

**防歪曲三条,必须遵守:**
1. 文档里要提到的任何文件/产出物,**写之前重新读一遍**确认现在的真实内容,不要凭对话记忆转述。
2. 记忆里不确定、没当场核实的陈述,句末标 `[?]`,提示下一个 agent 存疑。
3. 用户反馈**引用原话**,不要改写成你的理解。

## 步骤 4:按模板写文件

**读 `TEMPLATE.md`**(与本文件同目录),严格照它的 8 段结构写。
文件名:`HANDOFF_{话题2-4词kebab-slug}_{YYYY-MM-DD-HHmm}.md`,精确到分钟。撞名就加 `_2`、`_3`。
写到 `$ROOT/.handoff/` 下。一次 Write 写全 8 段,别留「待补」。

## 步骤 5:自检

照 `TEMPLATE.md` 末尾那 6 项逐条过。任一项不过关,用 Edit 把对应段补厚再往下走。这是防遗漏的唯一关口,别跳过。

## 步骤 6:git 同步(只推这一个文件)

```bash
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" add "$ROOT/.handoff/{刚写的文件名}"
  git -C "$ROOT" commit -q -m "handoff: {话题} (seq {N})"
  if git -C "$ROOT" remote | grep -q .; then
    git -C "$ROOT" push -q 2>/dev/null && echo "已推送到远程" || echo "commit 完成,但 push 失败(检查网络/远程)"
  else
    echo "已本地 commit;此仓库没配远程,换设备前请先配 remote 并 push"
  fi
else
  echo "警告:$ROOT 不是 git 仓库,交接文档仅本地保存,无法跨设备同步"
fi
```
只 `add` 这一个新文件,不碰项目里其它改动(可能属于别的并发 session)。

## 步骤 7:输出下一 session 的粘贴提示词

给用户下面这段,让 ta 在另一台设备/另一个 agent 里粘贴即可无损接手:
```
读 .handoff/{文件名}(chain {chain}, seq {N})并接手。
先复述你的理解:背景、当前状态、试过什么(含放弃的方案)、下一步第一件事,
再按「快速上手」列的文件读一遍,然后等我确认后再动手。
```
最后简短汇报:文件路径、chain/seq、自检结果、下一步第一件事。
