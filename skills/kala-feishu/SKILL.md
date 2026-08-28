---
name: kala-feishu
description: 用你本人的飞书身份(OAuth)读写/管理飞书云文档、知识库与两类表格。能创建/写入/追加 Markdown(标题·列表·表格·代码·图片)、把云文档/知识库文档全文读成可读 Markdown 供参考引用、管理云盘目录、浏览与新建知识库节点、读写电子表格(单元格·工作表·行列)与多维表格(记录·字段)、在文档里创建原生画板并生成节点(形状·文字·卡片版面)。支持在任意机器从零部署:agent 一步步引导用户建应用、授权、验证。当用户提到「飞书文档/云文档/云盘/知识库/wiki/写进飞书/飞书目录/飞书表格/多维表格/读取飞书文档」时触发。
trigger_keywords: 飞书, 飞书文档, 云文档, 飞书云盘, 知识库, wiki, 写进飞书, 飞书目录, docx, 飞书表格, 电子表格, 多维表格, sheets, bitable, 表格数据, 画板, 白板, board, whiteboard, 卡片, 读取飞书文档, 读飞书文档, 参考文档
allowed-tools: Bash, Read, Write, Edit, Glob
---

# 飞书云文档 / 知识库(用户身份)

用**用户本人的 OAuth 身份**(user_access_token)操作飞书:创建的文档归用户所有、用户可编辑内容并管理权限、后续任何 agent 都能继续编辑。纯 Node 脚本(零 npm 依赖,Node ≥ 18),与具体 agent 运行时解耦。

## 定位脚本目录(每次先做)

脚本在**本 skill 目录**的 `scripts/` 下。先确定本 skill 的安装路径,设为 `SKILL_DIR`,后续命令都用它:

```bash
# macOS / Linux —— 常见位置(按你所在工具选一个存在的):
#   Claude Code: ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/kala-feishu
#   Codex:       ~/.agents/skills/kala-feishu
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
   P0–P2、P5–P12 必须全绿(P7/P8 表格、P9 CLI 契约、P10 体积保护与 URL 解析、P11 网络重试、P12 画板)。
   无可写知识库空间时 P3–P4 记 SKIP(正常)。开发期可用 `--only P7,P8` 只跑指定阶段。
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
- **任何删除操作前,先把待删对象列清单给用户、取得明确确认再执行。** 表格脚本的删除类命令(`delsheet`/`delrow`/`delcol`/`deltable`/`delfield`/`delrec`)已把这条写进代码:不带 `--yes` 时只打印待删内容预览并退出 1,**先把预览给用户看、拿到确认再补 `--yes` 重跑**。
- 知识库的**空间成员/管理员**这类空间级权限设置在飞书客户端做,脚本不代做;告知用户即可。
- **多账号自动路由**:接入多个飞书组织时,传飞书 **URL** 的读/写(`feishu-wiki resolve`、`write-md-to-feishu`)会按 URL 租户域名**自动选对账号**,多组织无需手动切;要强制用某账号就设 `KALA_FEISHU_ACCOUNT=<名>`(显式优先)。`node "$SKILL_DIR/scripts/feishu-route.mjs" --list` 看有哪些账号和已学到的路由。报 `131006` = 该身份对该文档确实没权限(不是 token 坏)。

### 写入云文档

目标可以是 docx token/链接,或**知识库节点链接/URL**(自动解析 node→obj,不用手动换 token):

```bash
W="$SKILL_DIR/scripts/write-md-to-feishu.mjs"
# 增量更新:只改变了的那几块 ← 改现有文档首选
node "$W" <doc_token|url> <file.md> --patch --dry-run   # 先看计划,不动文档
node "$W" <doc_token|url> <file.md> --patch --yes       # 计划里有删除/替换时必须带 --yes
# 全量重写正文(清空 + 重建)
node "$W" <doc_token|url> <file.md>
# 追加到文末
node "$W" <doc_token|url> <file.md> --append
# 知识库文档:直接传 wiki 链接即可(内部自动 get_node 换 obj_token)
node "$W" "https://x.feishu.cn/wiki/XXXX" <file.md>
```

**改已有文档默认用 `--patch`,别拿全量重写当默认动作。** 全量重写是「清空正文 + 按 Markdown 重建」:
改一个错别字也会冲掉别人在飞书里的编辑、废掉锚在旧块上的局部评论、在版本历史里留下一次全文变更,
大文档还要删 N 块再建 N 块(每 50 块间隔 400ms)。`--patch` 先对齐现有块和新内容,
文本类改动走原地 PATCH(block_id 不变,评论和位置都保住),只对真正变了的块动手。

`--patch` 的边界(超出这些就老实说明,别当成没发生):
- 只在**顶层块**对齐:表格改一格 = 整张表替换;嵌套列表改一项 = 该项整棵子树替换。
- **图片按位置视为未变、不重传**(飞书那边只有 file_token,Markdown 这边只有 URL,无从比对)。
  换了图但位置没动时,要带 `--force-images` 才会重传。
- 文档里有 Markdown 生成不出来的块(**画板、电子表格、高亮块、分栏**)时,默认会出现在删除清单里。
  执行前必须把清单给用户确认——尤其是画板,删了不可逆。**要原地保住它们就加 `--keep-foreign`**
  (只改这些块周围的内容;代价是文档会比 Markdown 源多出它们,计划里会报出来)。
  带画板的文档(会议纪要常见)默认就该用 `--keep-foreign`。
- 有删除/替换时不带 `--yes` 会只打印计划并退出 1(和 sheets/bitable 的删除闸门同一套规矩)。

计划里的符号:`~` 原地改(block_id 不变)· `±` 整块替换 · `+` 新增 · `-` 删除;`[n]` 是原文档的顶层块序号。
想直观看这几条边界各自会怎么动,跑 `node "$SKILL_DIR/scripts/patch-demo.mjs"`(离线、不碰真文档)。

支持的 Markdown:标题 H1–H6、段落、行内样式(**粗**/*斜*/~~删~~/`code`/链接)、有序·无序·**嵌套**列表、引用、代码块(70+ 语言)、分割线、**表格**(自动列宽+大表分块)、图片(`![](url)` 自动下载上传)。

### 读取云文档全文(docx / 电子表格 / 多维表格)

把一篇云文档、电子表格或多维表格读成可读 Markdown,适合直接喂给当前对话当参考资料
(比如游戏设计讨论时引用一篇设定文档、一张数值表的全文)。目标可以传 docx/sheets/base 的
token 或 URL,或知识库节点/wiki URL(自动识别底层是 docx/sheet/bitable 中的哪一种,resolve 出真实 token,不用手动换)。

```bash
R="$SKILL_DIR/scripts/feishu-doc-read.mjs"
node "$R" <doc_token|url>                       # 打印全文 Markdown 到 stdout,不落盘
node "$R" <doc_token|url> --out ref.md           # 另存一份到本地文件(仅在你确有复用/跨 session 需要时才用)
node "$R" "https://x.feishu.cn/wiki/XXXX"        # 知识库节点:直接传 wiki 链接,自动按底层类型分发
node "$R" <裸 sheet_token> --type sheet          # 裸 token(不带 URL)判断不了类型,电子表格/多维表格要显式指定
node "$R" <裸 app_token> --type bitable
```

**docx**:覆盖标题、行内样式(粗/斜/删除线/code/链接)、有序·无序·嵌套列表、引用、代码块(还原语言)、
分割线、表格。**嵌入的多维表格/电子表格块会展开成实际内容**(取它引用的那一张表/工作表,和独立读取
用同一套裁剪规则)。画板、高亮块、分栏这类真的没有对应 Markdown 表达的块不会被静默丢弃,渲染成一行
占位提示注明块类型,需要看这部分内容时去飞书原文档看。表格/嵌套列表只在顶层结构上还原,不追求逐字节可逆。
若只需要原始 block JSON(供脚本二次处理,不是给人/agent 读),用底层的
`node "$SKILL_DIR/scripts/feishu-doc-writer.mjs" read <doc_token>`。

**图片**:飞书图片没有可直接访问的公网 URL,本命令会把文档里的图片**下载到本地**,Markdown 里
引用本地文件路径(`--out ref.md` 时存到 `ref.images/`,不带 `--out` 时存到一个临时目录,命令输出
会打印每张图的本地路径)。**脚本本身不做图像识别**——图里画的是什么,agent 拿到路径后要自己用
Read 工具逐张查看,再把内容补进这份参考材料,这一步不会自动发生,agent 必须主动做。

**电子表格/多维表格**:每张工作表/数据表渲染成一张 Markdown 表格,按 `## 工作表: xxx` /
`## 数据表: xxx` 分节。**飞书新建时自带的默认空白网格/空字段/空模板记录会被裁掉**,不会把
一堆空格子读进对话。默认每张表最多取前 200 行/条(和 `feishu-sheets.mjs` / `feishu-bitable.mjs`
CLI 的默认上限一致,保护 context),超出会在文末给出用哪条命令导出全量。

**不支持**:知识库节点若指向旧版「文档」(doc,非 docx)、幻灯片、思维笔记等类型,本工具不覆盖,会直接报错说明。

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

### 电子表格(Sheets)

格子模型:一个电子表格里有多张工作表,区域用 A1 记法且**必须带 sheet_id 前缀**(`{sheet_id}!A1:C10`)。
第一个参数传 token 或飞书 URL 都行(含知识库里的表格,wiki 链接会自动换成底层 token)。

```bash
S="$SKILL_DIR/scripts/feishu-sheets.mjs"
node "$S" create   <标题> [folder_token]                    # 建表格
node "$S" info     <token|url>                              # 元信息 + 工作表清单(拿 sheet_id)
node "$S" read     <token|url> [sheet_id|sheet_id!A1:C10]   # 读;省略区间=读整张
node "$S" write    <token|url> <sheet_id!A1:C10> <csv文件>  # 覆盖该区域(输出回显被覆盖的原值)
node "$S" append   <token|url> <sheet_id> <csv文件>         # 追加到现有数据末尾,不覆盖
node "$S" addsheet <token|url> <标题>                       # 加工作表
node "$S" rensheet <token|url> <sheet_id> <新名>
node "$S" delsheet <token|url> <sheet_id> --yes             # ← 先看预览再加 --yes
node "$S" insrow   <token|url> <sheet_id> <起始行> [行数]    # 行列号从 1 数(真人视角)
node "$S" delrow   <token|url> <sheet_id> <起始行> [行数] --yes
node "$S" inscol   <token|url> <sheet_id> <起始列> [列数]
node "$S" delcol   <token|url> <sheet_id> <起始列> [列数] --yes
node "$S" clear    <token|url> <sheet_id!A1:C10>            # 清空内容(输出回显清掉的内容)
```

- **`write` 是覆盖、`append` 是追加**,两个命令语义分开,不做智能判断。想加数据别用 `write`。
- **读大表**:`read` 默认最多返回 200 行并给出 `total`/`has_more`,续读加 `--offset 200`。
  **要全量分析用 `--out data.csv`** —— 导出到文件,数据不进 context(几千行的表硬读会把上下文占满)。
- 写入用 CSV;纯数字的格子会写成数字(否则飞书里没法求和),但**前导零(`007`)和超 15 位的长号码保持文本**,日期不做猜测转换。

### 多维表格(Bitable)

记录模型:一个多维表格 → 多张数据表 → 字段(列,有类型)+ 记录(行)。**没有格子坐标**,写入用 `{字段名: 值}`。

```bash
B="$SKILL_DIR/scripts/feishu-bitable.mjs"
node "$B" create   <名字> [folder_token]                     # 建多维表格
node "$B" tables   <token|url>                               # 列数据表(拿 table_id)
node "$B" addtable <token|url> <名字>
node "$B" deltable <token|url> <table_id> --yes              # ← 连表内记录一起没
node "$B" fields   <token|url> <table_id>                    # 列字段(带可读类型名)
node "$B" addfield <token|url> <table_id> <名字> <类型>       # 类型用中文名:文本/数字/单选/多选/日期/复选框/人员/电话/超链接/附件
node "$B" delfield <token|url> <table_id> <field_id> --yes   # ← 整列数据消失且回收站找不回
node "$B" records  <token|url> <table_id>                    # 读记录
node "$B" addrec   <token|url> <table_id> <json或csv文件>     # 新增(csv 的表头即字段名)
node "$B" updrec   <token|url> <table_id> <record_id> <json> # 改(只传要改的字段)
node "$B" delrec   <token|url> <table_id> <record_id...> --yes
```

- **写入前先 `fields` 看类型**:往「数字」字段写字符串会被飞书拒绝。
- **读大表**:`records` 默认最多 200 条,续读用 `--page-token <上次返回的 next_page_token>`(bitable 是游标分页,不能按 offset 跳);全量导出用 `--out data.csv`。
- 批量写/删超过 500 条时脚本自动分批;某批失败会报清楚「已成功几批」,**不会假装整体成功、也不会回滚**。
- 文本字段飞书返的是富文本数组,脚本已归一化成纯字符串;多选/附件/人员等保持原结构。

### 画板(Board / 白板)

层级:文档里插入一个 `block_type=43` 的画板块 → 该块的 `board.token` 是 **whiteboard_token** → 往画板里创建「节点」。
节点是**绝对坐标**定位(x/y/width/height),不像文档按流排版,所以能精确摆出卡片、流程图这类版面。

```bash
BD="$SKILL_DIR/scripts/feishu-board.mjs"
node "$BD" insert <doc_token|url>              # 在文档里插入画板块 → 返回 whiteboard_token
node "$BD" nodes  <whiteboard_token>           # 读画板所有节点
node "$BD" add    <whiteboard_token> <nodes.json>  # 批量创建节点(数组 或 {"nodes":[...]})
node "$BD" image  <whiteboard_token> <输出.jpg>     # 导出画板为图片(JPEG)
node "$BD" shapes                              # 列出实测可用的形状
```

节点最小结构(一张卡片 = 背景块 + 标题 + 正文 + 标签,4 个节点):

```json
[
  {"type":"composite_shape","x":0,"y":0,"width":380,"height":230,
   "composite_shape":{"type":"round_rect"},
   "style":{"fill_color":"#eaf3ff","border_color":"#d0d7de","border_style":"solid","border_width":"narrow"}},
  {"type":"text_shape","x":28,"y":26,"width":320,"height":40,
   "text":{"text":"卡片标题","font_size":20,"font_weight":"bold"}},
  {"type":"text_shape","x":28,"y":78,"width":320,"height":96,
   "text":{"text":"卡片正文","font_size":14}},
  {"type":"composite_shape","x":28,"y":182,"width":96,"height":30,
   "composite_shape":{"type":"round_rect"},"style":{"fill_color":"#2b7fff"},
   "text":{"text":"标签","font_size":12,"horizontal_align":"center","vertical_align":"mid"}}
]
```

**可用形状**(实测):`round_rect` `rect` `ellipse` `diamond` `triangle` `star` `parallelogram`。`arrow` 会被飞书拒。

**两个必须知道的坑**(都已做成本地前置校验,报错会直接点明字段):

- **颜色必须 `#RRGGBB`**:`"fill_color":"blue"` 会被飞书拒。
- **飞书先校验字段、后检查权限**:结构写错时只回一句笼统的 `99992402 field validation failed`,
  看起来像"接口不通"或"没权限",极易误判成权限问题。本脚本把已知约束在本地拦下,不把这个笼统报错甩给你。

**权限分两层,别混**:

| 操作 | 需要的权限 |
|---|---|
| 插入画板块(空画板) | **不需要画板权限**,`docx:document` 就够 |
| 创建 / 读节点、导出图片 | `board:whiteboard:node:create` + `board:whiteboard:node:read` |

这两个是**用户身份**权限,后台加完发布审核后**必须重跑 `feishu-oauth.mjs auth`**,旧 token 不会自动带上。
报 `2890005 Edit acl error whiteboard` 不是缺权限,是该身份对那篇文档没有编辑权(本 skill 全程用你本人身份,日常不会遇到)。

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
- **`网络中断: ...`** → 网络层瞬时失败(不是飞书拒绝)。脚本对**幂等**请求(读、写固定值、删除)已自动重试 2 次;
  报错说「**可能已生效**,请先核对」的是**非幂等**请求(建表格/加工作表/追加行/新增记录)——
  这类请求可能已经在飞书执行了、只是响应没回来。**不要直接重跑**,先读一遍看数据在不在,再决定补不补,否则会写两份。
- 更多错误码与 API 明细见 `references/api-cheatsheet.md`。
