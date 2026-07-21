# 飞书 REST API 速查(kala-feishu 用到的)

所有请求前缀:`https://open.feishu.cn/open-apis`。鉴权头 `Authorization: Bearer <token>`。
默认用 **user_access_token**(经 `feishu-oauth.mjs get` 获取);设公开权限等少数接口用 **tenant_access_token**。

脚本已封装以下调用,一般无需手敲;这里备查/排错用。

## 云盘 Drive

| 操作 | 方法 / 路径 | 备注 |
|---|---|---|
| 根目录 token | `GET /drive/explorer/v2/root_folder/meta` | |
| 列目录 | `GET /drive/v1/files?folder_token=&page_size=50` | 省略 folder_token = 根目录 |
| 建文件夹 | `POST /drive/v1/files/create_folder` `{name, folder_token}` | 返回 `token` |
| 上传文件 | `POST /drive/v1/files/upload_all` (multipart) | 字段 file_name/parent_type=explorer/parent_node/size/file |
| 移动 | `POST /drive/v1/files/{token}/move` `{type, folder_token}` | type: docx/file/folder… |
| 删除 | `DELETE /drive/v1/files/{token}?type=` | 进回收站可恢复 |
| 设公开权限 | `PATCH /drive/v1/permissions/{token}/public?type=docx` | 用户拥有的文档用 **user token**(owner);报 1063002 多为组织禁用了外链分享 |

## 文档 Docx(内容)

| 操作 | 方法 / 路径 |
|---|---|
| 创建文档 | `POST /docx/v1/documents` `{title, folder_token?}` → `document.document_id` |
| 读文档元信息 | `GET /docx/v1/documents/{doc}` |
| 列块(翻页) | `GET /docx/v1/documents/{doc}/blocks?page_size=200` |
| 追加子块 | `POST /docx/v1/documents/{doc}/blocks/{doc}/children` `{children, index:-1}` |
| 批量删块 | `DELETE /docx/v1/documents/{doc}/blocks/{doc}/children/batch_delete` `{start_index,end_index}` |
| 表格/嵌套(Descendant) | `POST /docx/v1/documents/{doc}/blocks/{parent}/descendant` |
| 图片上传 | `POST /drive/v1/medias/upload_all` (parent_type=docx_image) |

> 表格靠 Descendant API 一次建整棵(cell*2+1 ≤ 999,即 cells ≤ 499),大表格自动分块——`feishu-doc-writer.mjs` 已处理。

## 知识库 Wiki

| 操作 | 方法 / 路径 | 备注 |
|---|---|---|
| 列空间 | `GET /wiki/v2/spaces?page_size=50` | |
| 列节点 | `GET /wiki/v2/spaces/{space_id}/nodes?parent_node_token=&page_size=50` | 省略父 = 一级节点 |
| 建节点 | `POST /wiki/v2/spaces/{space_id}/nodes` `{obj_type:'docx', node_type:'origin', title, parent_node_token?}` | 返回 `node.node_token` + `node.obj_token` |
| **解析节点** | `GET /wiki/v2/spaces/get_node?token={node_token}` | 返回 `node.obj_token`/`obj_type` ← 写内容前必做 |
| 重命名 | `POST /wiki/v2/spaces/{space_id}/nodes/{node_token}/update_title` `{title}` | |
| 移动节点 | `POST /wiki/v2/spaces/{space_id}/nodes/{node_token}/move` `{target_parent_token?, target_space_id?}` | |
| 云盘文档移入 | `POST /wiki/v2/spaces/{space_id}/nodes/move_docs_to_wiki` `{obj_type, obj_token, parent_wiki_token?}` | |

**核心坑**:wiki 文档 URL `.../wiki/XXXX` 里的 `XXXX` 是 **node_token**,不是 docx token。
写内容前必须 `get_node` 换出 `obj_token`,再把 `obj_token` 当 doc_token 交给写入器。
`write-md-to-feishu.mjs` 传 wiki URL 会自动完成这步。

**删除节点**:本套用「删底层对象」实现——`get_node` 拿 `obj_token`/`obj_type` → `DELETE /drive/v1/files/{obj_token}?type={obj_type}`(进回收站)。

## 常见错误码

| code | 含义 | 处理 |
|---|---|---|
| 99991663 | token 无效/过期 | `feishu-oauth.mjs refresh`;仍失败则 `auth` 重新授权 |
| 99991672 | 应用缺少对应权限 | 后台加 scope + **发布 + 审核** |
| 99991679 | 未开通对应能力/用户未授权该 scope | 检查 OAuth 是否授权了该权限 |
| 1061001 | 文件不存在 | 检查 token |
| 1061002 | 无权限 | 确认 user token 有效、且你对该资源有权限 |
| 1069902 | 频率限制 | 退避重试(写入器已内置分批 + 400ms 间隔) |

> 权限/能力类报错(9999167x)几乎都指向「后台 scope 没配全 / 没发布审核 / OAuth 没授权到」,先回 setup-guide 步骤 2、5 核对。
