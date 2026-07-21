# Claude Code 交互接口

## Transport: CLI

### 二进制

`claude`（Node.js，全局安装）

### 启动模式

| 模式 | 命令 |
|------|------|
| 交互式 | `claude [prompt]` |
| 非交互式 | `claude -p [prompt]` / `claude --print [prompt]` |
| JSON 输出 | `claude -p --output-format json` |
| 流式 JSON | `claude -p --output-format stream-json` |
| 流式输入 | `claude -p --input-format stream-json` |
| 后台 Agent | `claude --bg [prompt]` |
| Remote Control | `claude --remote-control [name]` |
| 最小模式 | `claude --bare`（跳过 hooks、LSP、插件、auto-memory 等） |

### Session 管理

| 操作 | 命令 |
|------|------|
| 继续最近 | `claude --continue` / `claude -c` |
| 选择恢复 | `claude --resume [id]` / `claude -r [id]` |
| Fork 会话 | `claude --fork-session --resume [id]` |
| 指定 session ID | `claude --session-id <uuid>` |
| 命名会话 | `claude -n <name>` / `claude --name <name>` |
| PR 关联 | `claude --from-pr [number]` |
| 无持久化 | `claude --no-session-persistence`（仅 `--print`） |
| 后台 Agent 管理 | `claude agents [--json]` |

### 模型

| 操作 | 命令 |
|------|------|
| 指定模型 | `claude --model <model>` |
| 努力等级 | `claude --effort <level>`（low/medium/high/xhigh/max） |

### 权限

| 操作 | 命令 |
|------|------|
| 权限模式 | `claude --permission-mode <mode>` |
| 模式选项 | `manual`, `auto`, `acceptEdits`, `bypassPermissions` |
| 跳过危险确认 | `claude --dangerously-skip-permissions` |

### 工具控制

| 操作 | 命令 |
|------|------|
| 白名单 | `claude --allowedTools <tools>` |
| 额外目录 | `claude --add-dir <dirs>` |

### MCP 管理

| 操作 | 命令 |
|------|------|
| 添加 MCP Server | `claude mcp add <name> <commandOrUrl>` |
| 加载 MCP 配置 | `claude --mcp-config <json>` |
| 严格 MCP 配置 | `claude --strict-mcp-config` |

### 配置

`~/.claude/settings.json`（JSON）：

```json
{
  "permissions": { "defaultMode": "bypassPermissions" },
  "env": { "ANTHROPIC_BASE_URL": "...", "API_TIMEOUT_MS": "3000000" },
  "alwaysThinkingEnabled": true,
  "theme": "dark"
}
```

## Transport: ACP

**支持（第三方适配器）。**

Claude Agent 通过 [Zed 的 `claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) 适配器支持 ACP。

---

## 适配器要点

- 非交互式执行：`claude -p --output-format json <prompt>`
- Session 恢复：`claude -p --resume <id> <prompt>`
- 后台 Agent：`claude --bg <prompt>` + `claude agents --json` 监控
- 配置文件：`~/.claude/settings.json`