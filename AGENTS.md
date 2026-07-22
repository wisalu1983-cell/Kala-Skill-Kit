# AGENTS.md —— 给在本仓库里干活的 agent

这是一个跨工具的个人 agent skill 仓库(Claude Code / Codex / Cursor / OpenClaw 共用一套定义)。
本文件面向**负责安装 / 部署 / 维护**的 agent。给人看的总览见 [README.md](README.md)。

## 安装 / 部署:先预览,别盲跑全量

`install.sh` 默认是**全量**(所有 skill → 所有探测到的工具)。除非用户明确说"全部都装",
**按下面的顺序来,不要一上来就 `./install.sh`**:

1. 看有哪些选项和目标:`./install.sh --list`
2. 预览这次会做什么(不改动任何文件):`./install.sh --dry-run [参数]`
3. 把预览结果给用户确认后,去掉 `--dry-run` 再真正安装。

选择性安装:
- 只装某些 skill:`./install.sh kala-handoff kala-resume`
- 只装到某些工具:`./install.sh --tools codex,claude`(可选:claude / codex / cursor / openclaw)
- 组合:`./install.sh --tools codex kala-feishu`

## 硬规则

- **kala-feishu 不装到 OpenClaw**:OpenClaw 自带 `feishu_doc/drive/wiki/perm` 工具,重复且会造成触发歧义。
  install.sh 已对 OpenClaw 自动跳过 kala-feishu——**不要绕过这个跳过手动塞进 OpenClaw**。
- **install.sh 是覆盖式**:每个 skill 先 `rm -rf` 再 `cp`,会冲掉已装副本里的手改。装前务必 `--dry-run` 看清"新建 / 覆盖 / 跳过"。
- **装完要重启对应 CLI**:skill 在 CLI 启动时注册,重装后不重启看不到。
- **加新 skill**:在 `skills/<名>/SKILL.md` 建好,并把名字加进 `install.sh` 的 `SKILLS=(...)` 数组——**不是自动发现目录**。

## kala-feishu 特有(若本次涉及)

- 运行期数据在仓库外 `~/.kala/feishu/`(App 凭证 / OAuth token / 目标位置),**不进 git,不要提交**。
- 每台设备首次用需部署一次:写 App 凭证 + 浏览器 OAuth 授权一次。`skills/kala-feishu/SKILL.md` 有从零引导,细节见 `skills/kala-feishu/references/setup-guide.md`。
- 部分步骤(建飞书应用、点浏览器授权、后台审权限)**只能用户本人做**,agent 只能给指引并等待。
- **多账号 / 多租户**:一个飞书 App(= 一个租户)对应一个账号,用 `KALA_FEISHU_ACCOUNT=<名>` 区分(默认 `default`)。**文档属于哪个租户,就必须用那个租户的账号去读写**——用错账号会报 `131006 permission denied`(这是身份/租户不对,不是 token 坏了)。不确定用哪个时,`ls ~/.kala/feishu/*.config.json` 看有哪些账号,按文档 URL 的租户域名选对应的。
- **token 保活**用 `scripts/keepalive.mjs`(遍历 `~/.kala/feishu/` 下所有账号逐个 refresh);**不要**让定时任务直接跑 `feishu-oauth.mjs refresh`——那只刷 `default` 一个账号,别的会闲置过期。
