# Cursor 交互接口

## Transport: CLI

Cursor 是 **IDE**（VS Code 分支），无 CLI 工具。交互通过 IDE 内面板完成。

### 交互方式

- **Composer/Chat 面板**：Agent 模式和 Chat 模式
- **Tab 自动补全**：内联代码建议
- **Cmd+K 编辑**：内联代码编辑

### 配置

通过 VS Code 设置系统：
- `~/.cursor/argv.json`
- `~/Library/Application Support/Cursor/User/settings.json`
- `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- `~/Library/Application Support/Cursor/User/globalStorage/storage.json`

## Transport: ACP

**支持（原生）。**

Cursor 在 [ACP 官方 Agents 列表](https://agentclientprotocol.com/overview/agents) 中，文档见 [cursor.com/docs/cli/acp](https://cursor.com/docs/cli/acp)。

---

## 适配器要点

- 无 CLI 可调用
- 无 ACP/MCP 接口
- 仅可读取本地 SQLite 元数据（Tier 2）
- 消息内容需云端 API 访问