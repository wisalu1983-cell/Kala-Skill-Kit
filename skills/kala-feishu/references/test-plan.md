# kala-feishu 测试方案

首选一键自动化;手动分步用于排错或单点复现。

## 一键自动化(推荐)

```bash
node scripts/selftest.mjs
```

- 前置:已有可用 user token(`node scripts/feishu-oauth.mjs status` 显示有效)。无 token 会直接提示并退出,不产生误导性 FAIL。
- 全部测试对象建在隔离容器 `__kala_selftest__<时间戳>`,跑完自动清理(删除进回收站,可恢复)。
- 退出码:必需项(P0–P2、P5)全绿 = 0;有必需项 FAIL = 1。知识库项(P3–P4)本机无条件时记 SKIP,不影响退出码。

### 用例覆盖

| # | 能力 | 必需? |
|---|---|---|
| P0 | 部署自检(user token 就位) | 是 |
| P1.1–1.5 | 云盘:建文档 / 全元素写入 / 读回校验 / 追加 / 全量重写 | 是 |
| P1.6 | 云盘:图片插入 | 否(需可访问图片主机) |
| P2.1–2.3 | 云盘:建子文件夹 / 上传 / 移动 | 是 |
| P2.4 | 云盘:设公开权限 | 否(租户策略可能限制) |
| P3.1–3.5 | 知识库:列空间+建节点 / 写入 / URL 自动解析 / 读回 | 否(条件门) |
| P4.1–4.2 | 知识库:重命名 / 树内移动 | 否(条件门) |
| P5.1 | token 强制刷新 | 是 |
| P5.2 | 错误码映射(无效 token → 9999166x) | 是 |
| P13.1–13.4 | 增量更新:原地改(block_id 不变) / 插入删除后顺序 / 零改动 / CLI 闸门 | 是 |
| P14.1 | 读取全文:全元素渲染成 Markdown | 是 |
| P14.2 | 读取全文:不可转换块(画板等)渲染占位,不报错 | 否(依赖画板权限) |
| P14.3–14.4 | 读取全文:CLI 传 URL / --out 存文件 | 是 |
| P14.5–14.6 | 读取全文:电子表格/多维表格分发(--type)+ 默认空白网格/字段/记录裁剪 | 是 |
| P14.7 | 读取全文:知识库节点按底层类型(docx/sheet/bitable)自动分发 | 否(条件门,同 P3/P4) |
| P14.8 | 读取全文:docx 嵌入多维表格/电子表格块展开(resolveEmbed 端到端接线 + 无 resolver 时占位回退) | 是 |

### 知识库条件门

P3–P4 需要:① 应用已开 `wiki:wiki` 权限并发布审核;② 存在一个你可写的知识库空间。
缺任一 → selftest 记 `SKIP` 并打印原因(无空间 / 列空间失败)。补齐后重跑即可转绿。

## 离线自检:增量更新的差异计算

```bash
node scripts/patch-selftest.mjs
```

不碰网络、不需要 token。用内存里的假文档跑「建文档 → 改 Markdown → patch」,校验两条性质:
patch 后文档的块序列必须等于新 Markdown;标 keep / update 的块必须保住 block_id。
重点覆盖多处同时改动——那是下标最容易漂的地方(执行必须按下标从大到小)。
改动 `feishu-doc-patch.mjs` 后先跑这个,再跑 `selftest.mjs --only P13` 验真实 API。

想看「某种情况下它到底会怎么动」,跑 `node scripts/patch-demo.mjs`:把四条边界(表格改一格、
嵌套列表改子项、换图、文档里有画板、超 499 cells 的大表)各演示一遍,打印真实计划。同样离线。

## 手动分步(排错用)

```bash
# 前置
node scripts/feishu-oauth.mjs status

# 云盘
node scripts/feishu-drive.mjs root
node scripts/feishu-drive.mjs mkdir __manual_test__
node scripts/feishu-drive.mjs list                         # 拿到上面文件夹的 token
# 建文档(用 doc-writer 的 create 能力或走 SKILL.md 里的组合)
echo "# 手测\n\n| a | b |\n|---|---|\n| 1 | 2 |" > /tmp/t.md
node scripts/write-md-to-feishu.mjs <doc_token> /tmp/t.md
node scripts/feishu-doc-writer.mjs read <doc_token>
# 增量更新:改一个字后先看计划,再执行
echo "# 手测改了\n\n| a | b |\n|---|---|\n| 1 | 2 |" > /tmp/t2.md
node scripts/write-md-to-feishu.mjs <doc_token> /tmp/t2.md --patch --dry-run
node scripts/write-md-to-feishu.mjs <doc_token> /tmp/t2.md --patch --yes
node scripts/feishu-drive.mjs delete <doc_token> docx       # 清理

# 知识库
node scripts/feishu-wiki.mjs spaces
node scripts/feishu-wiki.mjs nodes <space_id>
node scripts/feishu-wiki.mjs create <space_id> "手测节点"    # 返回 node_token + obj_token
node scripts/write-md-to-feishu.mjs "https://x.feishu.cn/wiki/<node_token>" /tmp/t.md   # 验证自动解析
node scripts/feishu-wiki.mjs delete <node_token>            # 清理(先确认)
```

## 跨设备复现(验证「从零部署」)

在一个干净目录(模拟新机),只放 skill + 一份新 `~/.kala/feishu/<account>.config.json`,
走 setup-guide 步骤 4–5(写凭证 + `auth` 授权一次)后跑 `selftest.mjs`,应达到与本机相同的绿。
