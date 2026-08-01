# kala-gog 首次部署详解(Google Cloud 后台步骤)

给用户看的图文级步骤;agent 引导时可直接照这里念,并明确「哪几步只能你本人在浏览器/控制台做」。

术语:**OAuth 客户端(client)** = 你在 Google Cloud 控制台建的一个 Desktop 类型凭证,提供 client_id / client_secret,
是这套能力的信任根。所有读写都用**你本人的身份**(user OAuth token),所以看到的就是你自己看到的,不多不少。

**一个账号一个客户端**是本仓库的现状(个人号与 Garena 工作号分属不同组织,见 `accounts.json`)。

---

## 步骤 0 — 装 CLI(agent 做)

| 平台 | 命令 |
|---|---|
| macOS | `brew install openclaw/tap/gogcli` |
| Linux | `brew install openclaw/tap/gogcli`,或从 [releases](https://github.com/openclaw/gogcli/releases) 下 `gogcli_<ver>_linux_<arch>.tar.gz` |
| Windows | 从 releases 下 `gogcli_<ver>_windows_amd64.zip`(ARM 机器用 `_arm64`),解出 `gog.exe` 放进 PATH —— 详见 `windows-setup.md` |

验证:`gog --version`(应打印 `v0.x.y (<commit>)`)。

> ⚠️ **命令名是 `gog`,包名才是 `gogcli`**。`which gogcli` 查不到是正常的,别据此判断没装。

## 步骤 1 — 建 Google Cloud 项目并开 API(只能你做)

对**每个客户端**各做一遍(个人号一个项目、工作号一个项目)。

1. 打开 <https://console.cloud.google.com/> → 新建项目(或复用 `accounts.json` 里登记的项目)。
2. 「API 和服务 → 库」,逐个启用:
   - **Gmail API**
   - **Google Calendar API**
   - **Google Drive API**
   - **Google Docs API**
   - **Google Sheets API**
   - **People API**(通讯录)

   > 只开你要用的即可;没开的 API 调用时会报 `SERVICE_DISABLED`,报错里会带开启链接,到时候再补也行。

## 步骤 2 — 配 OAuth 同意屏幕(只能你做,且有个坑)

1. 「API 和服务 → OAuth 同意屏幕」。
2. 用户类型:
   - **个人 Gmail** → 只能选 **External(外部)**,并把自己加进「测试用户」。
   - **Google Workspace 工作号(garena.com)** → 选 **Internal(内部)**,不需要测试用户。
3. 填应用名、支持邮箱、开发者邮箱即可,不用提交 Google 审核(Desktop 客户端 + 自己用)。
4. ⚠️ **发布状态别停在「测试中」**:External 且处于 Testing 的应用,**refresh token 7 天就过期**,
   届时每周都要重新授权。两条出路:
   - **Workspace 工作号** → 点「设为内部 / Make internal」。Internal 应用不受 7 天限制、不需要验证、没有用户数上限,是工作号的正解。
   - **个人 Gmail**(只能 External)→ 点「发布应用」切到「正式版 / In production」。未经审核仍可用,
     只是授权时多一屏「Google 尚未验证此应用 → 高级 → 继续」,且**未验证应用有 100 用户上限**(自用够了)。

   **本仓库两个项目的状态(2026-08-01 在控制台核对并整改完毕)**:

   | 项目 | 用户类型 | 发布状态 | 用户数 |
   |---|---|---|---|
   | `apt-summer-487208-p3`(个人) | 外部 | **正式版** ✅ | 2 / 100 |
   | `garena-doc-reader-mcp`(工作) | 外部 | **正式版** ✅ | 1 / 100 |

   > **整改记录**:工作号那个原本是 External + **Testing**,且测试名单里只有 `wiaslu@gmail.com`
   > (工作号自己不在名单里却能授权,疑似**项目 Owner 豁免**)——正踩在 7 天过期的配置上,
   > 只是靠一层没有文档保证的机制撑着。2026-08-01 已把 `jiaren.lu@garena.com` 补进测试名单,
   > 并 Push to production。**发布不影响已有 token**,两个账号复验均 `valid: true`、真实 API 正常。
   >
   > 两个项目现在都是 External + 正式版 + 未验证,行为一致:授权时会有一屏「Google 尚未验证此应用」,
   > 且有 100 用户终生上限(自用远远够)。因为用了 Gmail/Drive 这类 restricted scope,
   > Google 将来**可能**要求提交验证——真被要求时再走 Verification Center 即可。
   >
   > **关于工作号项目里的 `wiaslu@gmail.com`**:它出现在测试名单里是 2026-03 建 Doc Reader MCP 时的随手填写
   > (External + Testing 必须至少填一个测试用户),**不是设计**。证据:发布前计数一直是 `1 user (1 test, 0 other)`,
   > 发布后转为按实际授权人数统计变成 `1 user` —— 说明个人 Gmail 挂在名单上但**从未真正授权过这个客户端**。
   > gog 是一账号一客户端(个人走 `default`、工作走 `garena`),个人号本来也不会用到它。
   >
   > **决定(2026-08-01,用户拍板):两个项目都维持 External + 正式版,不改 Make internal。**
   > 技术上工作号项目改内部是可行且无阻碍的(它在 garena.com 组织下,token 不受影响),
   > 但维持 External 让**两个项目配置完全一致**——一种状态、一套排查路径、一份文档,少一个要记的例外。
   > 承担的代价是明确的:授权时多一屏「Google 尚未验证此应用 → 高级 → 继续」,以及 100 用户终生上限。
   >
   > **什么时候该重新考虑改内部**:① Google 真的要求提交验证(restricted scope 的既有风险);
   > ② 用户数逼近 100(自用不可能);③ Garena 收紧策略,把未验证外部应用的绕过口子关掉。
   > 除此之外**不要主动去改**——那是在动一套正常工作的认证配置。

## 步骤 3 — 建 Desktop OAuth 客户端并下载 JSON(只能你做)

1. 「API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID」。
2. 应用类型选 **桌面应用 / Desktop app**(**不是** Web 应用——桌面客户端才有 gog 需要的本地回环回调)。
3. 建好后点「下载 JSON」,文件形如 `client_secret_<client_id>.json`。
4. 把文件路径告诉 agent。**核对 client_id 是否与 `accounts.json` 里登记的一致**——不一致说明建了个新客户端(也能用,但记得回头更新名册)。

> Desktop 客户端的 secret 按 OAuth 规范属于"不保密"的,但仍不要贴进会同步/公开的地方。
> gog 会把它收进系统密钥链,JSON 原件用完可以删。

## 步骤 4 — 装客户端凭证(agent 做)

```bash
# 个人号(默认客户端,不带 --domain)
gog --client default auth credentials ~/Downloads/client_secret_xxx.json

# 工作号(带 --domain,自动写入 client_domains 路由)
gog --client garena auth credentials ~/Downloads/client_secret_yyy.json --domain garena.com
```

自检:`gog auth credentials list`(打印 client / path / SECRET_KEYRING / DOMAINS,**不回显 secret**)。
`SECRET_KEYRING=true` 表示 secret 已进密钥链。

## 步骤 5 — 逐账号 OAuth 授权(agent 发起,你在浏览器点)

```bash
gog --client default auth add wiaslu@gmail.com
gog --client garena  auth add jiaren.lu@garena.com
```

- agent 执行后会弹浏览器 / 给出授权链接,**你本人点「允许」**。个人号会先过一屏「Google 尚未验证此应用」→「高级」→「继续」。
- 成功后 refresh token 存进系统密钥链(键名 `token:<client>:<email>`),access token 约 1 小时,gog 自动续。
- 无图形界面的机器:`--manual`(浏览器在别处打开,把跳转后的完整 URL 粘回来)或 `--remote`(`--step=1` 打印 URL、`--step=2` 交换 code)。

> ⚠️ **Garena 是受管租户**:组织可能限制未审核的第三方 OAuth 应用。若授权页直接报「管理员已阻止此应用」,
> 需要 Workspace 管理员在管理控制台把该 client_id 加进允许列表——这一步 agent 做不了,只能你去提。

## 步骤 6 — 冒烟验证(agent 做)

```bash
gog --version
gog auth list --check --json --no-input      # 两个账号都要 valid:true(会真刷一次 token)
gog auth doctor                              # keyring 可开、token 可读,末行 status ok
gog --account wiaslu@gmail.com     --readonly --no-input --json calendar calendars --max 3
gog --account jiaren.lu@garena.com --readonly --no-input --json calendar calendars --max 3
```

**两个账号各跑一遍最后一条**——只验一个会漏掉「另一个 client 的凭证没装」这种半残状态。

## 步骤 7 — 装 skill 并重启 CLI(agent 做)

```bash
cd <Kala-Skill-Kit 目录>
node install.mjs --dry-run --tools claude,codex kala-gog   # 先预览
node install.mjs --tools claude,codex kala-gog             # 确认后实装
```

**装完重启对应 CLI**(skill 在 CLI 启动时注册)。macOS/Linux 也可用 `./install.sh`(同一份逻辑的薄封装)。

> **不要装到 OpenClaw**:那边已有同源的 `gog` skill,安装器已自动跳过。

---

## 保活:不需要定时器,但别放太久

gog 的 refresh token **没有固定有效期**,正常使用会一直续。会失效的情况:

| 情形 | 后果 | 处理 |
|---|---|---|
| 同意屏幕停在「测试中」 | 7 天过期 | 回步骤 2 发布应用(或改内部),再重新授权。**本仓库两个项目均已是正式版**,见步骤 2 的对照表 |
| 连续 6 个月完全没调用 | Google 主动回收 | 重跑 `auth add` |
| 用户改密码 / 撤销第三方访问 | 立即失效 | 重跑 `auth add` |
| 组织策略变更(工作号) | 立即失效 | 找管理员放行后重跑 `auth add` |

所以**不用像 kala-feishu 那样注册系统定时器**。想主动确认状态,任何时候跑一次
`gog auth list --check --json` 即可(它会真的刷一次 token)。

## 设计约定:为什么一账号一客户端(**别合并**)

技术上,**一个 OAuth 客户端可以被任意多个 Google 账号授权**,gog 也原生支持:

```bash
gog --client default auth add wiaslu@gmail.com
gog --client default auth add jiaren.lu@garena.com   # 同一把钥匙,第二扇门
```

token 分别存成 `token:<client>:<邮箱>`,互不干扰,各自只能访问自己账号的数据。
所以"两个账号合用一个客户端"看起来很诱人:只维护一个 GCP 项目、一套 API、一个同意屏幕,换机省一半事。

**本仓库明确不这么做。** 理由是所有权耦合——OAuth 客户端是"钥匙",谁授权就开谁的门,
但**钥匙本身归它所在的 GCP 项目、也就是那个组织所有**:

| 合并方向 | 硬伤 |
|---|---|
| 两个账号都用**公司**项目的客户端 | 项目归 garena.com 组织,管理员可删可吊销;离职/offboarding 清理项目时,**个人账号的访问跟着一起断** |
| 两个账号都用**个人**项目的客户端 | 对工作号而言这是「外部第三方应用」,要过 Workspace 的「API 控制 → 应用访问权限控制」;Gmail/Drive 属 restricted scope,是管理员最优先锁死的一类,大概率被拦、需提工单加白名单。且**公司数据流经你私人持有的客户端**,合规上说不过去 |

> 注意区分:工作号现在能顺利授权,是因为**客户端就在 garena.com 自己的组织里**(本组织应用默认放行)。
> 换成个人项目的客户端,性质立刻变成外部第三方应用,不是同一回事。

一账号一客户端、各归各的组织,是唯一同时避开这两头的做法。**接新账号时照这个来,不要为了省事合并。**

## 接入新 Google 账号

1. 👤 走步骤 1–3,为新账号建项目 + 客户端(若与已有账号同租户,可复用同一个客户端,跳到第 3 步)。
2. 🤖 装凭证 + 授权:
   ```bash
   gog --client <新客户端名> auth credentials <JSON路径> [--domain <该租户域名>]
   gog --client <新客户端名> auth add <新邮箱>
   ```
3. 🤖 验证:`gog --account <新邮箱> --readonly --no-input --json calendar calendars --max 3`
4. 🤖 把新账号登记进 `references/accounts.json`(邮箱/client/域名/client_id,**不含 secret**)并提交,
   同时在 `SKILL.md` 的账号表里加一行——**不登记,换新机时就不知道要还原它**。

## 每台新设备:1:1 还原清单

Google Cloud 侧的配置(项目、API、同意屏幕、客户端)是**账号级**的、已经做过,换设备**不用重做**。
换设备真正要重做的只有两件:**装 CLI** 和 **逐账号重新授权**(token 不跨设备)。按序:

1. 🤖 装 CLI(步骤 0),`gog --version` 验证。Windows 先读 `windows-setup.md`。
2. 🤖 装 skill:克隆本仓库 → `node install.mjs --dry-run` 预览 → 实装 → 重启对应 CLI(步骤 7)。
3. 👤 从 Google Cloud 控制台「凭据」页,把 `accounts.json` 里登记的**每个客户端**重新下载 JSON 给 agent。
4. 🤖 逐客户端装凭证(步骤 4)→ 🤖→👤 逐账号授权(步骤 5)。
5. 🤖 冒烟验证(步骤 6),**两个账号都要过**。

密钥链内容不迁移、不导出——每台设备各自持有自己的 token,这是设计如此,不是缺陷。
