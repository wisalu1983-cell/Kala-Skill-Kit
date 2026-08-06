# 无飞书能力时的待发布纪要包

## 目的

让内容生成、视觉审阅和飞书发布解耦。没有 OAuth、权限或 `kala-feishu` 时仍能完成可审核纪要，但必须明确发布尚未发生。

## 默认目录

### 当前位于项目中

```text
<项目根>/.meeting-minutes/<YYYY-MM-DD>-<会议主题>/
```

先检查项目文档治理规则；已有会议记录目录时优先遵守项目约定。默认不提交 Git，除非用户或项目规则明确要求。

### 不在项目中

```text
Windows: %USERPROFILE%\Documents\Kala\MeetingMinutes\<YYYY-MM-DD>-<会议主题>\
macOS:   ~/Documents/Kala/MeetingMinutes/<YYYY-MM-DD>-<会议主题>/
```

目录名需去除系统不允许的字符，主题过长时保留最有辨识度的短标题。

## 必需结构

```text
<meeting-package>/
├── meeting-minutes.md
├── source-map.json
├── preview.html
├── publish-plan.json
├── qa-report.md
└── visuals/
    ├── ...svg
    ├── ...png
    └── ...json
```

### `meeting-minutes.md`

使用 `assets/meeting-minutes-template.md`。正文是内容事实源；图片路径使用相对路径。

### `source-map.json`

保存关键结论、待办、开放问题和金句与原文的对应关系。推荐结构见 `content-workflow.md`。发布后仍保留，不把它写入面向读者的正文。

### `preview.html`

基于 `assets/preview-template.html` 生成。模拟栏目顺序、宽度、字体、卡片、图片和留白，用于在无飞书环境下先做视觉 QA。它不需要复刻飞书应用 chrome，只复刻文档阅读区。

### `publish-plan.json`

记录以后发布到飞书的操作意图：

- 目标 URL、账号或待确认状态；
- 每个操作的 `replace`、`insert`、`append`、`preserve` 或 `delete`；
- 目标锚点策略和已知值；
- 内容类型与相对资产路径；
- 必须保留的关系、尺寸或原块；
- 是否需要用户删除确认。

所有资产路径必须相对纪要包，不能写本机绝对路径。

### `qa-report.md`

分别记录内容 QA、视觉 QA、本地包验证和未执行的飞书 QA。没有真实飞书渲染时明确写“待发布后验证”。

### `visuals/`

保存：

- 原始白板或截图的副本/引用说明；
- 生成的 SVG 和兼容 PNG；
- 飞书原生画板的节点规格 JSON；
- 图形来源、尺寸和版本说明。

不要把 OAuth token、App Secret、飞书缓存或其他凭证放入纪要包。

## 验证

运行：

```bash
node <kala-meeting-minutes>/scripts/validate-package.mjs <meeting-package>
```

只有返回 `"ok": true` 才能称为“本地待发布包验证通过”。这不代表内容语义和视觉已经自动通过，仍需按 `qa-rubric.md` 审阅。

## 换设备继续

在具备 `kala-feishu` 的设备上：

1. 读取本包全部文件；
2. 运行验证器；
3. 检查目标 URL 与账号权限；
4. 读取目标文档现有块树；
5. 将 `publish-plan.json` 的锚点与实际块匹配；
6. 若目标结构变化，更新发布计划并重新取得删除确认；
7. 按计划发布，不重新总结正文；
8. 完成飞书回读和视觉 QA；
9. 把发布 URL、实际 block/token 和最终 QA 状态回写进 `qa-report.md`。

若纪要包需要跨设备同步，使用项目已有 Git/云盘规则；Skill 不自动上传敏感会议内容。
