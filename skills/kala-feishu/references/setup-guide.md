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

---

## 每台新设备

代码随 git 走;凭证/token 不随 git 走。新设备上:`./install.sh` 装 skill → 重复步骤 4–5(写凭证 + 授权一次)即可。文档归你所有,任一已授权设备都能编辑同一批文档。
