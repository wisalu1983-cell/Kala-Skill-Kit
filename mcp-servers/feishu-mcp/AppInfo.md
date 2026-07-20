# FeiShu MCP 配置说明（去敏版）

## 1) 应用信息

- App ID：`<YOUR_FEISHU_APP_ID>`
- App Secret：`<DO_NOT_PUT_SECRET_IN_MARKDOWN>`

建议仅将真实密钥保存在：
- `FeiShuDoc/keys/FeiShu MCP Client.json`
- 或密码管理器中（如 1Password / Bitwarden）

## 2) 推荐接入方式

直接在仓库根目录运行：

```powershell
.\setup.ps1
```

该脚本会自动生成/更新 `~/.cursor/mcp.json` 里的 `lark-mcp` 配置。

## 3) 手工配置示例（可选）

> 下面是占位示例，不包含真实密钥。

```json
"lark-mcp": {
  "command": "node",
  "args": ["E:/Cursor/MCP/FeiShuDoc/dist/server.js"],
  "env": {
    "FEISHU_APP_CLIENT_JSON": "E:/Cursor/MCP/FeiShuDoc/keys/FeiShu MCP Client.json",
    "FEISHU_USER_ACCESS_TOKEN_PATH": "E:/Cursor/MCP/FeiShuDoc/data/feishu-user-access-token.txt",
    "FEISHU_TOOLS": "wiki.v2.space.getNode,wiki.v1.node.search,docx.v1.document.rawContent,docx.v1.document.get,docx.v1.documentBlock.list,docx.v1.documentBlock.get,docx.v1.documentBlockChildren.get,docx.builtin.search,bitable.v1.appTable.list,bitable.v1.appTableField.list,bitable.v1.appTableRecord.search,sheets.v3.spreadsheet.get,sheets.v3.spreadsheetSheet.query,sheets.v3.spreadsheetSheet.get,sheets.v3.spreadsheetSheet.find,drive.v1.meta.batchQuery,drive.v1.exportTask.create,drive.v1.exportTask.get,drive.v1.media.batchGetTmpDownloadUrl",
    "FEISHU_TOKEN_MODE": "auto",
    "FEISHU_OAUTH": "true"
  }
}
```

## 4) 部署规则:模板 vs 实际运行,一份部署可挂多个账号

**这个目录是模板**:仓库里不装 `node_modules`,不放真实凭证(`keys/`、`data/` 已 gitignore)。实际要用,复制一份到仓库之外的独立目录(例如 `D:/CursorLibrary/MCP/FeiShuDoc/`),在那份目录里 `npm install`,凭证也写在那份目录里——只有换到一台全新机器、或者交给另一个人用,才需要这个"复制模板 + 重新安装"的动作。

**同一台机器、同一份已部署的代码,可以同时服务多个飞书账号/组织**,不需要每加一个账号就复制一份目录、重装一次依赖。区分账号只靠两样东西:

1. 一对独立的凭证文件:`keys/<label>.json` + `data/<label>-token.txt`
2. 一条独立的 MCP server 配置项:`args` 指向同一份 `dist/server.js`,只有 `env` 里的凭证路径不同

示例(账号 A、B 共用同一份部署):

```json
"lark-mcp-orgA": {
  "command": "node",
  "args": ["D:/CursorLibrary/MCP/FeiShuDoc/dist/server.js"],
  "env": {
    "FEISHU_APP_CLIENT_JSON": "D:/CursorLibrary/MCP/FeiShuDoc/keys/orgA.json",
    "FEISHU_USER_ACCESS_TOKEN_PATH": "D:/CursorLibrary/MCP/FeiShuDoc/data/orgA-token.txt",
    "FEISHU_TOOLS": "...",
    "FEISHU_TOKEN_MODE": "auto",
    "FEISHU_OAUTH": "true"
  }
},
"lark-mcp-orgB": {
  "command": "node",
  "args": ["D:/CursorLibrary/MCP/FeiShuDoc/dist/server.js"],
  "env": {
    "FEISHU_APP_CLIENT_JSON": "D:/CursorLibrary/MCP/FeiShuDoc/keys/orgB.json",
    "FEISHU_USER_ACCESS_TOKEN_PATH": "D:/CursorLibrary/MCP/FeiShuDoc/data/orgB-token.txt",
    "FEISHU_TOOLS": "...",
    "FEISHU_TOKEN_MODE": "auto",
    "FEISHU_OAUTH": "true"
  }
}
```

OAuth 本地回调端口(3000)只在实际发起登录时短暂监听(默认 60 秒自动释放,成功回调后 1 秒关闭),多个账号的配置同时挂着不会冲突,除非两边恰好在同一时刻都在走登录。

## 5) 已知组织清单(不含密钥)

新机器部署时先看这张表,不用重新回忆/描述有哪些飞书组织——表里只记不敏感的标识符,**App Secret 和 token 永远不进仓库**,每次部署手动问用户要。

| 标签 | 飞书租户域名 | App ID | 说明 |
|---|---|---|---|
| 休闲游戏New | 具体子域名未记录(2026-07-20 已通过登录各账号核对开发者后台确认组织名称) | `cli_a90443b1d4b85cb1` | 本机在接入 Trumen-COS 之前就已存在的 lark-mcp 配置。凭证文件是旧命名(`keys/FeiShu MCP Client.json`),未按上面的 label 规则命名 |
| Trumen-COS | `dcn3z9j3xb3g.feishu.cn` | `cli_aad7658ef9789d0c` | 2026-07-20 新建,已验证可用 |

新机器部署步骤(配合第 4 节):

1. 读这张表,对每一行问用户要对应的 App Secret
2. 按 `keys/<标签>.json` + `data/<标签>-token.txt` 建凭证文件
3. 按第 4 节示例,在 `.claude.json` 里为每行加一条 `lark-mcp-<标签>` 配置
4. 以后新增组织,在这张表里加一行同步记录

## 6) 标准权限清单(可复用)

`permission-scopes.json` 是从 Trumen-COS 应用导出的云文档只读权限清单,新组织建应用时可以直接在开发者后台「权限管理→批量导入/导出权限」的导入页签里粘贴这份 JSON,不用每次手动逐个搜索勾选(仍需走版本发布+管理员审核才会真正生效)。
