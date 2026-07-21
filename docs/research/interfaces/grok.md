# Grok 交互接口

## Transport: CLI

### 二进制

`grok`（Rust 二进制，`~/.grok/bin/grok`）

### 启动模式

| 模式 | 命令 |
|------|------|
| 交互式 | `grok [prompt]` |
| 非交互式 | `grok -p <prompt>` / `grok --single <prompt>` |
| 纯文本输出 | `grok -p --output-format plain` |
| JSON 输出 | `grok -p --output-format json` |
| 流式 JSON | `grok -p --output-format streaming-json` |
| 结构化输出 | `grok -p --json-schema <schema>` |
| Worktree | `grok --worktree [name]` |
| Best-of-N | `grok --best-of-n <N>`（仅 headless） |
| 自验证 | `grok --check`（仅 headless） |

### Session 管理

| 操作 | 命令 |
|------|------|
| 继续最近 | `grok -c` / `grok --continue` |
| 选择恢复 | `grok -r [id]` / `grok --resume [id]` |
| Fork 会话 | `grok --fork-session --resume [id]` |
| 指定 session ID | `grok -s <uuid>` / `grok --session-id <uuid>` |
| 列出会话 | `grok sessions list` |
| 搜索会话 | `grok sessions search <keyword>` |
| 删除会话 | `grok sessions delete <id>` |
| 导出 | `grok export` → Markdown |
| 导入 | `grok import` |
| Trace | `grok trace`（导出/上传 session trace） |

### 模型与推理

| 操作 | 命令 |
|------|------|
| 指定模型 | `grok -m <model>` / `grok --model <model>` |
| 推理努力 | `grok --reasoning-effort <level>` |
| 最大轮数 | `grok --max-turns <N>` |

### 权限

| 操作 | 命令 |
|------|------|
| 允许规则 | `grok --allow <RULE>` |
| 拒绝规则 | `grok --deny <RULE>` |
| 自动批准全部 | `grok --always-approve` |
| 禁用工具 | `grok --disallowed-tools <TOOLS>` |

### 配置

`~/.grok/config.toml`（TOML）

## Transport: ACP

**原生实现，第一优先级 transport。**

Grok 将 ACP 作为架构核心——内部 TUI (pager) 与 shell 之间通过 ACP 通信，`updates.jsonl` 本质上是 ACP `session/update` 的本地持久化。

### 三种 ACP 传输模式

#### 1. stdio（标准 ACP）

```bash
grok agent stdio [options]
```

标准 JSON-RPC 2.0 over stdio，供 IDE 扩展和自动化工具使用。

| 选项 | 说明 |
|------|------|
| `-m, --model <MODEL>` | 指定模型 |
| `--always-approve` / `--yolo` | 自动批准所有工具 |
| `--reauth` | 启动前认证 |
| `--agent-profile <PATH>` | 加载 Agent profile |

#### 2. WebSocket Server

```bash
grok agent serve --bind 127.0.0.1:2419 --secret <token>
```

供远程客户端通过 WebSocket 连接。支持断线重连和会话恢复。

#### 3. WebSocket Relay（Headless）

```bash
grok agent headless --grok-ws-url wss://your-relay.example.com/ws
```

Agent 主动连接到 relay 服务器，供 Web 客户端通过 relay 访问。

### ACP 协议生命周期

```
Client → Agent: initialize（协议版本 + 能力协商）
Client → Agent: session/new（cwd + MCP servers）
Client → Agent: session/prompt（用户消息）
Agent → Client: session/update（流式：agent_message_chunk, tool_call, plan...）
Agent → Client: session/request_permission（如需权限）
Client → Agent: session/cancel（取消）
Agent → Client: session/prompt response（stopReason）
```

### session/update 类型

| sessionUpdate | 说明 |
|--------------|------|
| `agent_message_chunk` | Agent 响应文本流 |
| `agent_thought_chunk` | Agent 内部推理 |
| `tool_call` | 工具调用声明 |
| `tool_call_update` | 工具调用状态更新 |
| `plan` | Agent 执行计划 |

### x.ai 扩展方法

Grok 在标准 ACP 之外定义了 `x.ai/*` 扩展：

| 类别 | 前缀 | 示例 |
|------|------|------|
| 文件系统 | `x.ai/fs/*` | `list`, `exists`, `read_file`, `write_file` |
| Git | `x.ai/git/*` | `status`, `stage`, `commit`, `diffs` |
| Git Worktree | `x.ai/git/worktree/*` | `create`, `remove`, `apply` |
| 搜索 | `x.ai/search/*` | `fuzzy/open`, `content` |
| 终端 | `x.ai/terminal/*` | `create`, `kill`, `output` |
| 会话管理 | `x.ai/session/*` | `fork`, `resolve_local_for_worktree_resume` |
| 对话历史 | `x.ai/*` | `prompt_history`, `rewind/*`, `compact_conversation` |
| 认证 | `x.ai/auth/*` | `get_url`, `submit_code` |

### session/new _meta 选项

```json
{
  "method": "session/new",
  "params": {
    "cwd": "/path/to/project",
    "mcpServers": [],
    "_meta": {
      "rules": "Extra rules...",
      "systemPromptOverride": "Custom system prompt",
      "agentProfile": "profile-name"
    }
  }
}
```

### 与 updates.jsonl 的关系

Grok 的 `updates.jsonl` 格式与 ACP `session/update` 通知**完全相同**。`updates.jsonl` 本质上是 ACP 流式更新的本地持久化：

```
updates.jsonl 中的 session/update       ACP 协议
─────────────────────────────────────    ─────────
sessionUpdate: "agent_message_chunk"  =  agent_message_chunk
sessionUpdate: "agent_thought_chunk"  =  agent_thought_chunk
sessionUpdate: "tool_call"            =  tool_call
sessionUpdate: "tool_call_update"     =  tool_call_update
```

---

## 适配器要点

- **ACP（推荐）**：`grok agent stdio` → JSON-RPC 2.0 over stdio
- **非交互式 CLI**：`grok -p --output-format json <prompt>`
- **Session 列表**：`grok sessions list`
- **Session 恢复**：通过 ACP `session/load` 或 CLI `grok -r <id>`
- **配置**：`~/.grok/config.toml`
- **Leader Socket**：`~/.grok/leader.sock`（内部 IPC）