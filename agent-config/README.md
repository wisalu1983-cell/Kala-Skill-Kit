# Agent 配置快照

本目录保存 Claude Code、Codex 等 agent 工具的规则文本快照，供多台设备之间比较、审阅和同步。

它不是 skill 目录，不参与 `install.mjs` 的安装和触发扫描；可执行或可触发的 skill 仍只放在 `skills/`。

## 目录约定

```text
agent-config/
├─ machines/<设备标识>/
│  ├─ README.md
│  ├─ claude/
│  │  ├─ CLAUDE.md
│  │  └─ rules/
│  └─ codex/
│     ├─ AGENTS.md
│     └─ rules/
└─ shared/
```

- `machines/<设备标识>/`：保存一台设备的完整规则快照。
- `shared/`：只保存经过人工比较和确认后，明确适用于所有设备的公共规则；当前不自动合并任何机器规则。
- 设备标识使用稳定的主机名；新增设备直接新增一个同级目录，不覆盖已有设备。

## 安全边界

只同步规则和文档文本，不同步 token、密钥、凭证、历史记录、缓存、会话数据或其他运行期私密配置。
