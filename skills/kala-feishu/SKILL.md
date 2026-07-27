---
name: kala-feishu
description: 用你本人的飞书身份(OAuth)读写/管理飞书云文档与知识库。能创建/写入/追加 Markdown(标题·列表·表格·代码·图片)、管理云盘目录、浏览与新建知识库节点。支持在任意机器从零部署:agent 一步步引导用户建应用、授权、验证。当用户提到「飞书文档/云文档/云盘/知识库/wiki/写进飞书/飞书目录」时触发。
trigger_keywords: 飞书, 飞书文档, 云文档, 飞书云盘, 知识库, wiki, 写进飞书, 飞书目录, docx, 飞书表格
allowed-tools: Bash, Read, Write, Edit, Glob
---

# 飞书云文档 / 知识库(用户身份)

用**用户本人的 OAuth 身份**(user_access_token)操作飞书:创建的文档归用户所有、用户可编辑内容并管理权限、后续任何 agent 都能继续编辑。纯 Node 脚本(零 npm 依赖,Node ≥ 18),与具体 agent 运行时解耦。

## 定位脚本目录(每次先做)

脚本在**本 skill 目录**的 `scripts/` 下。先确定本 skill 的安装路径,设为 `SKILL_DIR`,后续命令都用它:

```bash
# macOS / Linux —— 常见位置(按你所在工具选一个存在的):
#   Claude Code: ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/kala-feishu
#   Codex:       ${CODEX_HOME:-~/.codex}/skills/kala-feishu
SKILL_DIR="$HOME/.claude/skills/kala-feishu"   # ← 改成实际路径
```

**Windows(PowerShell)**:`$skill = "$env:USERPROFILE\.claude\skills\kala-feishu"`,下文命令里的 `$SKILL_DIR` 换成 `$skill`;
指定账号写 `$env:KALA_FEISHU_ACCOUNT="x"` 而不是 `KALA_FEISHU_ACCOUNT=x`。完整 Windows 部署/保活见 `references/windows-setup.md`。

运行期数据(凭证/token/目标位置)在 `~/.kala/feishu/`,与本仓库、与 openclaw 都无关。可用 `KALA_FEISHU_ACCOUNT` 区分多个飞书身份(不设时用默认账号 `personal`)。

## 第 0 步:判断处于哪个阶段

```bash
node "$SKILL_DIR/scripts/feishu-oauth.mjs" status
```

- 显示 **✅ 有效** → 已部署,直接进入下面的【日常使用】。
- 提示没有 token / 凭证 → 进入【首次部署】。

---

## 【首次部署】从零引导

**明确区分:标 👤 的只能用户本人在浏览器/后台做,agent 负责给指引并等待;标 🤖 的 agent 做。** 详细图文见 `references/setup-guide.md`,照着念即可。

1. 🤖 检查 `node -v` ≥ 18,不满足先指引安装。
2. 👤 在开发者后台 <https://open.feishu.cn/app> 创建**企业自建应用**,把 **App ID + App Secret** 给 agent。
3. 👤 「权限管理→导入」粘贴 `references/permission-scopes.json` → **创建版本 → 发布 → 管理员审核**(不做则调用报权限错)。
4. 👤 「安全设置→重定向 URL」添加 `http://127.0.0.1:9876/callback`。
5. 🤖 写本地凭证(secret 不回显、不进 git):
   ```bash
   node -e "import('$SKILL_DIR/scripts/feishu-config.mjs').then(m=>m.saveAppCredentials('cli_xxxx','SECRET'))"
   node "$SKILL_DIR/scripts/feishu-config.mjs"   # 自检:打印解析结果(secret 只显示长度)
   ```
6. 🤖→👤 发起授权,把链接给用户,**用户在浏览器点授权**:
   ```bash
   node "$SKILL_DIR/scripts/feishu-oauth.mjs" auth
   ```
7. 🤖 冒烟验证(自动清理):
   ```bash
   node "$SKILL_DIR/scripts/selftest.mjs"
   ```
   P0–P2、P5 必须全绿。无可写知识库空间时 P3–P4 记 SKIP(正常)。
8. 🤖 **注册 token 自动保活(不要跳过)** —— 不配的话某组织 ~30 天没用就要重新授权:
   ```bash
   node "$SKILL_DIR/scripts/setup-keepalive.mjs"   # macOS→launchd;Windows→任务计划程序;注册即跑一次
   ```
   手动/自定义方式见 `references/setup-guide.md` 步骤 8(Windows 见 `references/windows-setup.md` 步骤 6)。
9. 🤖 和用户确认**目标写入位置**并记住复用(见【日常使用·记住目标】)。

> **接第 2、第 3 个组织**:不用重搭架构,带 `KALA_FEISHU_ACCOUNT=<新名>` 重复第 5–7 步即可;
> 保活会自动纳入新账号。详见 `references/setup-guide.md` 的「接入第 2、第 3 … 个组织」,
> 并把新账号登记进 `references/accounts.json` 名册。
>
> **换新设备还原已有配置**(组织/应用都建过,只是换机器):不走上面全流程,
> 按 `references/setup-guide.md`「每台新设备:1:1 还原清单」+ `references/accounts.json` 名册逐账号做。

---

## 【日常使用】

**铁律:**
- 拿 token 一律 `node "$SKILL_DIR/scripts/feishu-oauth.mjs" get`(自动续期)。**禁止**任何代码直接调飞书 refresh API——refresh_token 一次性,绕过管家会断链。
- **任何删除操作前,先把待删对象列清单给用户、取得明确确认再执行。**
- 知识库的**空间成员/管理员**这类空间级权限设置在飞书客户端做,脚本不代做;告知用户即可。
- **多账号自动路由**:接入多个飞书组织时,传飞书 **URL** 的读/写(`feishu-wiki resolve`、`write-md-to-feishu`)会按 URL 租户域名**自动选对账号**,多组织无需手动切;要强制用某账号就设 `KALA_FEISHU_ACCOUNT=<名>`(显式优先)。`node "$SKILL_DIR/scripts/feishu-route.mjs" --list` 看有哪些账号和已学到的路由。报 `131006` = 该身份对该文档确实没权限(不是 token 坏)。

### 写入云文档

目标可以是 docx token/链接,或**知识库节点链接/URL**(自动解析 node→obj,不用手动换 token):

```bash
# 全量重写正文(markdown 文件)
node "$SKILL_DIR/scripts/write-md-to-feishu.mjs" <doc_token|url> <file.md>
# 追加
node "$SKILL_DIR/scripts/write-md-to-feishu.mjs" <doc_token|url> <file.md> --append
# 知识库文档:直接传 wiki 链接即可(内部自动 get_node 换 obj_token)
node "$SKILL_DIR/scripts/write-md-to-feishu.mjs" "https://x.feishu.cn/wiki/XXXX" <file.md>
```

支持的 Markdown:标题 H1–H6、段落、行内样式(**粗**/*斜*/~~删~~/`code`/链接)、有序·无序·**嵌套**列表、引用、代码块(70+ 语言)、分割线、**表格**(自动列宽+大表分块)、图片(`![](url)` 自动下载上传)。

读文档:`node "$SKILL_DIR/scripts/feishu-doc-writer.mjs" read <doc_token>`。

### 云盘运维

```bash
D="$SKILL_DIR/scripts/feishu-drive.mjs"
node "$D" root                              # 根目录 token
node "$D" list [folder_token]               # 列目录
node "$D" mkdir <名字> [父folder_token]      # 建文件夹
node "$D" upload <本地文件> <folder_token>   # 上传
node "$D" move <token> <folder_token> [type] # 移动(type 默认 docx)
node "$D" delete <token> <type>             # 删除 ← 先向用户确认!
node "$D" public <token> [type]             # 设「任何人可读」
```

**在目标文件夹新建并写入文档**:先建 docx,再写内容。建议用 doc-writer 的 `create`:

```bash
node -e "import('$SKILL_DIR/scripts/feishu-doc-writer.mjs').then(async m=>{const w=new m.FeishuDocWriter();await w.init();const d=await w.create('标题','<folder_token>');console.log(d.document_id)})"
# 拿到 document_id 后:
node "$SKILL_DIR/scripts/write-md-to-feishu.mjs" <document_id> <file.md>
```

### 知识库运维

```bash
W="$SKILL_DIR/scripts/feishu-wiki.mjs"
node "$W" spaces                                        # 列知识库空间
node "$W" nodes <space_id> [parent_node_token]          # 列节点树
node "$W" create <space_id> <标题> [parent] [obj_type]   # 建节点(默认 docx)→ 返回 node_token + obj_token
node "$W" resolve <wiki_url|node_token>                 # 解析出 obj_token(写内容前)
node "$W" rename <space_id> <node_token> <新标题>
node "$W" move <space_id> <node_token> [parent] [target_space_id]
node "$W" movein <space_id> <obj_type> <obj_token> [parent]  # 把云盘文档移入知识库
node "$W" delete <wiki_url|node_token>                  # 删节点 ← 先向用户确认!
```

新建知识库文档并写入:`create` 拿到 `obj_token` → 用 `write-md-to-feishu.mjs <obj_token> <file.md>` 写。

### 评论(仅全文评论)

```bash
C="$SKILL_DIR/scripts/feishu-comment.mjs"
node "$C" create  <doc_url|token> <评论文本>     # 给整篇文档建一条评论
node "$C" list    <doc_url|token>                # 列出评论(界面里建的局部评论也能读到)
node "$C" get     <doc_url|token> <comment_id>   # 取单条
node "$C" resolve <doc_url|token> <comment_id>   # 标记为已解决
```

**开放 API 的硬限制(不是脚本没做):**
- 只能建**全文评论**(整篇挂一条)。**无法锚定到某段文字建局部评论**——传 `is_whole:false`+`quote` 会被飞书强制转成全文、`quote` 丢弃。要针对某句话批注,只能人到飞书界面手动做;API 只能**读到**这类局部评论。
- **回复评论不支持**(API 对全文评论回复返回 `1069302`)。
- 目标传文档或知识库 URL 都行(wiki 会自动解析成底层 docx),多账号按租户自动选。

### 记住目标位置

确定常用目标后记进 `~/.kala/feishu/<account>.targets.json` 复用(下次直接读):

```bash
node -e "import('$SKILL_DIR/scripts/feishu-config.mjs').then(m=>m.saveTargets({drive_folder:'<folder_token>', wiki_space:'<space_id>', wiki_parent:'<node_token>'}))"
```

### 多组织权限体检

接了多个飞书组织时,查各组织应用权限是否一致(真调 API 实测,不是读配置):

```bash
node "$SKILL_DIR/scripts/feishu-scope-audit.mjs"        # 全部账号
node "$SKILL_DIR/scripts/feishu-scope-audit.mjs" --no-write  # 只做只读探测
```

会用**应用身份 / 用户身份**两种身份分别测云盘·知识库·IM·通讯录·文档写·评论·公开权限,
并自动列出**各组织之间不一致的项**。统一方法见 `references/setup-guide.md` 的「多组织:权限统一标准与维护」。

## 排错

- 权限/能力类报错(`99991672`/`99991679`)→ 后台 scope 没配全 / 没发布审核 / OAuth 没授权到,回 `references/setup-guide.md` 步骤 2、5 核对。
- `99991663` token 过期 → `feishu-oauth.mjs refresh`;refresh 也过期 → `auth` 重新授权。
- 更多错误码与 API 明细见 `references/api-cheatsheet.md`。
