# kala-feishu 首次部署详解(开发者后台步骤)

这份是给用户看的图文级步骤;agent 引导时可直接照这里念,并明确「哪几步只能你本人在浏览器/后台做」。

术语:飞书自建应用 = 你在飞书开发者后台创建的一个 App,它提供 App ID / App Secret,
是这套能力的信任根。文档写入用**你本人的身份**(OAuth user token),所以文档归你所有、你能编辑和管权限。

---

## 步骤 1 — 创建自建应用(只能你做)

1. 打开开发者后台:<https://open.feishu.cn/app>(国际版 Lark:<https://open.larksuite.com/app>)。
2. 「创建企业自建应用」→ 填名称/图标 → 创建。
3. 进入应用 →「凭证与基础信息」,记下:
   - **App ID**(形如 `cli_xxxxxxxx`)
   - **App Secret**(点显示/复制)
4. 把这两个值给 agent(agent 会写进本地 `~/.kala/feishu/<account>.config.json`,`600` 权限,不进 git、不回显)。

> 说明:App Secret 属敏感凭证。它只会落在你自己机器的本地文件里,用于向飞书换取 token。任何时候都不要贴进会同步/公开的地方。

## 步骤 2 — 开权限并发布(只能你做,且不可省)

1. 应用 →「权限管理」→ 找到「导入」(或「批量导入/导出」)。
2. 打开 `references/permission-scopes.json`,把内容粘进导入框,确认勾选。
   - 关键写入权限:`docx:document`(读写文档)、`drive:drive`(云盘)、`wiki:wiki`(知识库)、`offline_access`(OAuth 刷新必需)。
3. 「版本管理与发布」→ 创建版本 → 提交发布 →(企业需)**管理员审核通过**。
   - ⚠️ 不发布/不审核,权限不生效,调用会报 `99991672`/无权限类错误。

## 步骤 3 — 登记 OAuth 重定向 URL(只能你做)

1. 应用 →「安全设置」→「重定向 URL」。
2. 添加:`http://127.0.0.1:9876/callback`
   - 这是本机授权时脚本临时监听的回调地址(授权成功后 1 秒关闭)。

## 步骤 4 — 写本地凭证(agent 做)

> **多组织注意**:一个组织一个账号,步骤 4–5 要**每个账号各做一遍**,做之前先
> `export KALA_FEISHU_ACCOUNT=<账号名>`(不设 = 默认账号 `personal`)。已有哪些账号见
> `references/accounts.json`;换新设备按那份名册逐个来。

agent 执行(或引导执行),把 App ID/Secret 落到本地:

```bash
# 方式 A:agent 直接写(推荐)
node -e "import('./scripts/feishu-config.mjs').then(m=>m.saveAppCredentials('cli_xxxx','app_secret_xxxx'))"

# 方式 B:环境变量(临时/CI)
export KALA_FEISHU_APP_ID=cli_xxxx
export KALA_FEISHU_APP_SECRET=app_secret_xxxx
```

自检:`node scripts/feishu-config.mjs`(打印解析结果,secret 只显示长度不回显明文)。

## 步骤 5 — OAuth 授权(agent 发起,你在浏览器点)

```bash
node scripts/feishu-oauth.mjs auth
```

- agent 会把授权链接给你,**你在浏览器打开并点「授权」**。
- 成功后 token 存到 `~/.kala/feishu/<account>.token.json`(access 约 2 小时,refresh 约 30 天,自动续)。
- 之后日常操作 agent 用 `node scripts/feishu-oauth.mjs get` 自动拿/续 token,无需你再管,直到 refresh 也过期(约 30 天没用过)才需重跑 `auth`。

## 步骤 6 — 冒烟验证(agent 做)

```bash
node scripts/selftest.mjs
```

跑完全部能力并自动清理。P0–P2、P5 必须全绿。若本机没有可写知识库空间,P3–P4 会记 SKIP(见步骤 7)。

## 步骤 7 — 记住目标位置(agent 做)

确定你要往哪写,把位置记进 `~/.kala/feishu/<account>.targets.json` 复用:

- **云盘目标**:`node scripts/feishu-drive.mjs list` 找到/新建目标文件夹,记 `folder_token`。
- **知识库目标**:`node scripts/feishu-wiki.mjs spaces` 列空间 → `nodes <space_id>` 浏览 → 记 `space_id` 和目标 `parent_node_token`。
  - ⚠️ 知识库要「你能管权限」,前提是你在该空间是**管理员**;空间成员/角色设置需在飞书客户端做,脚本不代做。

## 步骤 8 — token 自动保活(agent 做,**不要跳过**)

不配保活,某个组织超过 ~30 天没用,refresh_token 就过期、必须重新浏览器授权。
`scripts/keepalive.mjs` 会遍历 `~/.kala/feishu/` 下**所有**账号逐个 refresh(新增账号自动纳入)。

**推荐:一条命令注册(跨平台)**:

```bash
node scripts/setup-keepalive.mjs            # macOS→launchd;Windows→任务计划程序;注册即跑一次
node scripts/setup-keepalive.mjs --status   # 查看注册状态(--uninstall 取消)
tail -5 ~/.kala/feishu/keepalive.log        # 验证:应看到「保活 N 个账号」+ 逐账号 ✅
```

它注册的 node 是「当前运行的 node」、脚本路径是「自己所在的那份副本」,幂等可重跑
(换 node 版本 / 挪仓库后重跑一次即可)。Windows 上若注册失败,手动 PowerShell 方式见
`windows-setup.md` 步骤 6。下面的手动方式与脚本等价,需要自定义(改周期/路径)时参考。

**手动方式:macOS(launchd)** —— 写一个 LaunchAgent,每 7 天跑一次:

```bash
KIT=~/MyProjects/Kala-Skill-Kit          # ← 改成你的仓库实际路径
NODE=$(command -v node)
cat > ~/Library/LaunchAgents/ai.kala.feishu.token-refresh.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.kala.feishu.token-refresh</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$KIT/skills/kala-feishu/scripts/keepalive.mjs</string>
  </array>
  <key>StartInterval</key><integer>604800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.kala/feishu/keepalive.log</string>
  <key>StandardErrorPath</key><string>$HOME/.kala/feishu/keepalive.log</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/ai.kala.feishu.token-refresh.plist
launchctl unload ~/Library/LaunchAgents/ai.kala.feishu.token-refresh.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/ai.kala.feishu.token-refresh.plist
sleep 3 && tail -5 ~/.kala/feishu/keepalive.log   # 预期:保活 N 个账号 + 每个 ✅ 刷新成功
```

> ⚠️ `$NODE` 要用**稳定的绝对路径**。若 node 装在 nvm 下(路径含版本号),升级 nvm 后 plist 会失效;
> 建议指向一个固定位置的 node,或升级后重新生成 plist。

**Linux**:等价地用 systemd timer 或 crontab 跑同一条命令。
**Windows**:见 `windows-setup.md` 步骤 6(任务计划程序)。

> **不要**让定时任务直接跑 `feishu-oauth.mjs refresh`——那只刷默认账号(`personal`)一个,其它组织仍会过期。

## 接入第 2、第 3 … 个组织(多租户)

一个飞书组织 = 一个应用 = 一个账号。加新组织**不用重做步骤 1–3 以外的架构**,只需:

0. 🤖 **先确认它真的是新组织,别搞错身份**(最容易踩的坑,不要凭印象跳过):
   问用户要该组织内**任意一篇真实文档的链接**,看域名 `xxx.feishu.cn`,与
   `references/accounts.json` 名册和 `~/.kala/feishu/routing.json` 比对:
   - 域名**已存在** → 不是新组织,只是同一租户下的另一个项目/知识空间。**不用建新应用、不用走审核**,
     让用户把该文档/知识空间共享给已有身份即可。
   - 域名**不存在** → 才是真新组织,继续下面的流程。

   > 2026-07 接入某组织时就因为跳过这步,一直误以为是已有组织,白绕了好几轮。
   > 另:第 3 步验证读取成功后,**再看一眼返回内容是否真对得上预期组织**,把身份确认闭环。
1. 👤 在**该组织**下重复步骤 1–3(建应用、导入 `permission-scopes.json`、登记重定向 URL)。
2. 🤖 带账号名重复步骤 4–5:
   ```bash
   export KALA_FEISHU_ACCOUNT=<新账号名>      # 例:casualgame
   node -e "import('.../feishu-config.mjs').then(m=>m.saveAppCredentials('cli_xxx','SECRET'))"
   node scripts/feishu-oauth.mjs auth          # 用户在浏览器点授权
   ```
3. 🤖 验证:`KALA_FEISHU_ACCOUNT=<新账号名> node scripts/selftest.mjs`
4. 🤖 保活**无需改动**——`keepalive.mjs` 自动发现新账号。
5. 🤖 跑 `node scripts/feishu-scope-plan.mjs` 看新组织与既有组织的权限差距,按输出对齐。
6. 🤖 把新账号登记进 `references/accounts.json`(账号名/组织/域名/App ID,**不含 secret**)并提交——
   这是换设备 1:1 还原的名册,不登记新机就不知道要建它。

> 之后**传飞书 URL 的读写会按域名自动选账号**(`feishu-route.mjs`,首次探测后记进 `routing.json`),日常不用手动指定账号。

## 多组织:权限统一标准与维护

接了多个飞书组织(一个组织 = 一个应用 = 一个账号)后,各应用的权限容易配得不一样,
导致"同样的命令在 A 组织能跑、在 B 组织报 99991672"。约定如下。

### 目标状态(本仓库的标准)

| 权限面 | 标准 | 说明 |
|---|---|---|
| **应用身份**(tenant) | 云盘 / 文档写 / 评论 / 公开权限 / 知识库 / IM 全给 | 机器人自己办事、openclaw 内置 `feishu_doc/drive/wiki/perm` 依赖它 |
| **用户身份**(user) | 云盘 / 文档写 / 评论 / 公开权限 / 知识库 + `offline_access` | kala-feishu 全程用它;`offline_access` 是 refresh_token 的前提 |
| **通讯录 contact** | **暂不开**(2026-07 决定) | 只在"把 open_id 翻译成同事姓名""@人""按部门共享"时才需要;加协作者用邮箱即可绕过。敏感且需管理员审批,真有需求再补 |

### 统一方法(动静最小)

**不要手工逐个勾选,也不要直接拿一个应用的导出去覆盖别的应用**——用规划器生成「每个应用的目标终态」:

```bash
node scripts/feishu-scope-plan.mjs
```

它会用飞书 `/application/v6/scopes` **精确读出**每个应用已授权的权限,与云文档标准集比对,
在 `~/.kala/feishu/scope-targets/<账号>.json` 生成该应用的**终态清单**,并打印每个应用需新增哪几条。

然后对每个应用:**权限管理 → 导入**(粘它自己那份)→ **创建版本 → 发布 → 管理员审核**。

> **为什么生成「终态」而不是「差量」或「统一一份」**:飞书的导入究竟是**追加**还是**覆盖**并不确定。
> 终态 = 该应用现有权限 ∪ 云文档标准 −(通讯录),所以**无论导入是追加还是覆盖,结果都对、
> 都不会弄丢该应用原有的能力**(例如 bot 的 IM 权限——若拿"纯云文档清单"去覆盖,机器人就废了)。

**agent 做不了的部分**:飞书开放 API **没有**"给应用声明新权限"的接口(那等于应用自我提权),
所以勾选 / 发布 / 审核**只能人在开发者后台点**。agent 能做的到"把该点哪些列清楚 + 生成可粘贴的 JSON"为止。

从零部署一个**新**组织时,直接用 `references/permission-scopes.json`(云文档标准集)导入即可。

> **只补「应用身份」权限时,不需要重新 OAuth 授权**,现有 user token 全部继续有效。
> 只有改动**用户身份**权限才需要重跑 `feishu-oauth.mjs auth`——因为 token 的授权范围在授权那一刻就固定了。

### 维护:一条命令查漂移

```bash
node scripts/feishu-scope-audit.mjs          # 体检所有账号
node scripts/feishu-scope-audit.mjs personal # 只看某个
node scripts/feishu-scope-audit.mjs --no-write   # 只做只读探测
```

它对每个账号用**两种身份**分别实测(不是读配置),打对照表并**自动列出各组织不一致的项**。
接新组织后、或怀疑权限问题时跑一次即可。

## 每台新设备:1:1 还原清单

代码随 git 走;**凭证 / token / routing / targets 不随 git 走**,新设备重新生成。
步骤 1–3(建应用/权限/回调 URL)是**组织级**的、已经做过,换设备**不用重做**。按序:

1. 🤖 装 skill:克隆本仓库 → `./install.sh --dry-run` 预览 → `./install.sh`(Windows:`node install.mjs`,先读 `windows-setup.md`)→ 重启对应 CLI。
2. 🤖→👤 打开 `references/accounts.json` 名册,**逐账号**重复步骤 4–5:
   - `export KALA_FEISHU_ACCOUNT=<账号名>`(Windows:`$env:KALA_FEISHU_ACCOUNT="<账号名>"`)
   - 👤 从开发者后台对应应用重新复制 App Secret 给 agent → 🤖 写凭证(步骤 4)
   - 🤖 发起 `feishu-oauth.mjs auth` → 👤 浏览器点授权(步骤 5)
3. 🤖 逐账号冒烟:`KALA_FEISHU_ACCOUNT=<账号名> node scripts/selftest.mjs`(步骤 6)。
4. 🤖 注册保活:`node scripts/setup-keepalive.mjs`(步骤 8)。
5. 🤖 体检权限一致性:`node scripts/feishu-scope-audit.mjs`——权限配置在飞书后台、跟组织走不跟设备走,理论上与原设备自动一致,跑一次确认即可。

`routing.json`(域名→账号)会在使用中自动重新学习,无需迁移;`targets.json` 是可选的便利项,需要时照步骤 7 重记。文档归你所有,任一已授权设备都能编辑同一批文档。
