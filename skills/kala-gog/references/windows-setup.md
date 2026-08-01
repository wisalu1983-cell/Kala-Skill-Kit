# kala-gog:Windows 部署指南(给部署 agent)

目标:**部署后与 macOS 效用等价**——同样的两个账号、同样的读写能力、同样的安全开关。

`gog` 是 Go 编译的单文件二进制,本身完全跨平台;skill 也是纯文档(无脚本)。
**真正需要按平台处理的只有三件事:CLI 怎么装、配置/密钥存哪、命令行写法。** 下面逐条给 Windows 做法。

> ⚠️ 本文的 Windows 命令由 macOS 侧编写、**未在 Windows 实机执行过**。首次部署时请按步验证,
> 遇到偏差以实际报错和 `gog auth status` / `gog auth doctor` 的真实输出为准,并回头修订本文。

---

## 平台差异速查

| 项 | macOS | Windows |
|---|---|---|
| 装 CLI | `brew install openclaw/tap/gogcli` | 下 release zip → 解出 `gog.exe` → 加进 PATH |
| 命令名 | `gog` | `gog`(即 `gog.exe`,PowerShell 里不用写后缀) |
| 配置目录 | `~/Library/Application Support/gogcli/` | 预期 `%AppData%\gogcli\`,**以 `gog auth status` 的 `config_path` 为准** |
| 密钥存储 | macOS Keychain | **Windows 凭据管理器**(wincred),`keyring_backend=auto` 自动选 |
| skill 安装器 | `./install.sh`(薄封装) | **`node install.mjs`**(同一份逻辑) |
| Claude Code skills | `~/.claude/skills/` | `%USERPROFILE%\.claude\skills\` |
| Codex skills | `~/.codex/skills/` | `%USERPROFILE%\.codex\skills\` |
| 设环境变量(单次) | `GOG_CLIENT=garena gog …` | `$env:GOG_CLIENT="garena"; gog …` |
| 路径带空格 | 引号 | 引号,且反斜杠在双引号里要留意转义,优先用单引号 |

Google Cloud 控制台那几步(建项目 / 开 API / 同意屏幕 / 建 Desktop 客户端)**完全没有平台差异**,
照 `setup-guide.md` 步骤 1–3 走即可。

---

## 步骤 0 — 前置

```powershell
node -v          # 装 skill 用,需 ≥ 18
git --version
```
没有 Node:`winget install OpenJS.NodeJS.LTS`(装完**重开终端**)。

## 步骤 1 — 装 gog.exe

官方**没有** scoop / winget / npm 分发,就是下 zip 解压加 PATH。

```powershell
# 1) 看架构:AMD64 还是 ARM64
$env:PROCESSOR_ARCHITECTURE

# 2) 去 https://github.com/openclaw/gogcli/releases 下对应的
#    gogcli_<版本>_windows_amd64.zip  或  gogcli_<版本>_windows_arm64.zip

# 3) 解压到一个固定目录
$dest = "$env:LOCALAPPDATA\Programs\gogcli"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path "$env:USERPROFILE\Downloads\gogcli_<版本>_windows_amd64.zip" -DestinationPath $dest -Force

# 4) 永久加进用户 PATH(只需一次;之后重开终端生效)
$old = [Environment]::GetEnvironmentVariable('Path','User')
if ($old -notlike "*$dest*") {
  [Environment]::SetEnvironmentVariable('Path', "$old;$dest", 'User')
}
$env:Path += ";$dest"     # 当前这个终端也立即生效

# 5) 验证
gog --version
```

> Windows 可能对下载来的 exe 加「网络来源」标记而拦截运行。若报安全阻止:
> `Unblock-File "$dest\gog.exe"`。
> 也可能被 SmartScreen 拦一次,选「仍要运行」。

**升级**:重下新 zip,用 `Expand-Archive -Force` 覆盖同一目录即可,配置和 token 不受影响。

## 步骤 2 — 装客户端凭证 + 授权

和 macOS 完全一样,只是路径写法不同:

```powershell
gog --client default auth credentials "$env:USERPROFILE\Downloads\client_secret_xxx.json"
gog --client garena  auth credentials "$env:USERPROFILE\Downloads\client_secret_yyy.json" --domain garena.com

gog --client default auth add wiaslu@gmail.com
gog --client garena  auth add jiaren.lu@garena.com
```

授权会拉起默认浏览器。若在 RDP / 无浏览器环境下不弹窗,用手动流程:

```powershell
gog --client default auth add wiaslu@gmail.com --manual
# 把打印出的 URL 在任意有浏览器的机器打开、点允许,再把跳转后的完整 URL(带 code=)粘回终端
```

凭证与 token 落在 **Windows 凭据管理器**。想确认:

```powershell
gog auth status      # 看 keyring_backend / config_path / credentials_path
gog auth doctor      # 每行 ok/warn/error,末行 status
cmdkey /list | Select-String gog     # 系统侧也能看到条目(只显示名字,不显示密文)
```

## 步骤 3 — 装 skill

```powershell
git clone <你的私库URL> "$env:USERPROFILE\MyProjects\Kala-Skill-Kit"
cd "$env:USERPROFILE\MyProjects\Kala-Skill-Kit"

node install.mjs --list                                  # 看有哪些 skill / 工具
node install.mjs --dry-run --tools claude,codex kala-gog # 预览
node install.mjs --tools claude,codex kala-gog           # 实装
```

装完**重启对应 CLI**。

## 步骤 4 — 冒烟验证

```powershell
gog --version
gog auth list --check --json --no-input
gog auth doctor
gog --account wiaslu@gmail.com     --readonly --no-input --json calendar calendars --max 3
gog --account jiaren.lu@garena.com --readonly --no-input --json calendar calendars --max 3
```

两个账号最后一条都要过。

---

## Windows 特有的坑

- **单引号 vs 双引号**:Gmail 查询串里有 `:` 和空格,PowerShell 下用**单引号**最省事:
  `gog --account <邮箱> --readonly --no-input --json gmail search 'in:inbox newer_than:7d' --max 10`。
  双引号里 `$` 会被 PowerShell 展开,查询串里有 `$` 时务必用单引号。
- **反斜杠路径**:传给 `--body-file` 之类的路径,用双引号包住整体;若路径里有 `$`,同样改单引号。
- **`gog` 找不到**:九成是 PATH 没生效——**重开终端**,或确认第 4 小步真的写进了用户 PATH(`[Environment]::GetEnvironmentVariable('Path','User')`)。
- **凭据管理器被组策略锁**:受管的公司电脑可能禁用凭据管理器。此时 gog 会退到别的 keyring 后端;
  `gog auth doctor` 会报出来。实在不行可用文件后端 + 密码:设 `GOG_KEYRING_BACKEND=file` 与 `GOG_KEYRING_PASSWORD=<口令>`
  (口令从密码管理器取,**不要硬编码进脚本或提交进 git**)。
- **换机不迁移密钥**:不要试图导出凭据管理器条目搬到新机——重跑 `auth add` 授权一遍即可,这是设计如此。
