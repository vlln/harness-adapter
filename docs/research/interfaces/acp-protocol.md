# ACP (Agent Client Protocol) 调研

> 基于官方规范 [agentclientprotocol.com](https://agentclientprotocol.com/) 和仓库 [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)

## 概述

ACP (Agent Client Protocol) 是 **Zed** 主导的开放标准，标准化代码编辑器与编码 Agent 之间的通信。类似 LSP 标准化了语言服务器，ACP 标准化了 Agent 集成。

- **当前稳定版本**：Protocol v1
- **传输层**：JSON-RPC 2.0 over stdio（newline-delimited）
- **Streamable HTTP**：草案中
- **Schema**：`schema/v1/schema.json`，`schema/v2/schema.json`

## 协议架构

```
┌──────────┐                    ┌──────────┐
│  Client   │  JSON-RPC 2.0     │  Agent    │
│ (Editor)  │◄─────────────────▶│ (Subprocess)│
│           │   over stdio       │           │
└──────────┘                    └──────────┘
```

- **Client**：代码编辑器/IDE，发起 Agent 子进程，管理环境、权限、用户交互
- **Agent**：AI 编码 Agent，作为 Client 的子进程运行
- 每个连接支持多个并发 session

## 生命周期

### 1. 初始化阶段

```
Client → Agent: initialize（协商协议版本和能力）
Client → Agent: authenticate（如果需要认证）
```

### 2. Session 建立

```
Client → Agent: session/new（创建新会话）
Client → Agent: session/load（恢复已有会话，需要 loadSession 能力）
Client → Agent: session/resume（恢复会话但不重放历史，需要 sessionCapabilities.resume）
```

### 3. Prompt Turn

```
Client → Agent: session/prompt（发送用户消息）
Agent → Client: session/update（流式更新：plan, agent_message_chunk, tool_call, tool_call_update）
Agent → Client: session/request_permission（需要权限时）
Client → Agent: session/cancel（用户取消）
Agent → Client: session/prompt response（stopReason: end_turn/max_tokens/cancelled/...）
```

## Agent 方法（Agent 实现）

| 方法 | 类型 | 说明 |
|------|------|------|
| `initialize` | Request | 协商协议版本和能力 |
| `authenticate` | Request | 认证（如需要） |
| `session/new` | Request | 创建新会话 |
| `session/load` | Request | 加载已有会话（需 `loadSession` 能力） |
| `session/resume` | Request | 恢复会话不重放（需 `sessionCapabilities.resume`） |
| `session/prompt` | Request | 发送用户消息 |
| `session/set_mode` | Request | 切换 Agent 模式 |
| `session/close` | Request | 关闭活跃会话（需 `sessionCapabilities.close`） |
| `logout` | Request | 登出 |
| `session/cancel` | Notification | 取消当前操作 |

## Client 方法（Client 实现）

| 方法 | 类型 | 说明 |
|------|------|------|
| `session/request_permission` | Request | 请求工具调用权限 |
| `fs/read_text_file` | Request | 读取文件（需 `fs.readTextFile` 能力） |
| `fs/write_text_file` | Request | 写入文件（需 `fs.writeTextFile` 能力） |
| `terminal/create` | Request | 创建终端（需 `terminal` 能力） |
| `terminal/output` | Request | 获取终端输出 |
| `terminal/release` | Request | 释放终端 |
| `terminal/wait_for_exit` | Request | 等待终端退出 |
| `terminal/kill` | Request | 杀死终端进程 |
| `session/update` | Notification | 会话更新通知 |

## session/update 类型

| sessionUpdate | 说明 |
|--------------|------|
| `plan` | Agent 计划 |
| `agent_message_chunk` | Agent 文本响应（流式 chunk） |
| `agent_thought_chunk` | Agent 思考过程 |
| `user_message_chunk` | 用户消息（重放时） |
| `tool_call` | 工具调用声明 |
| `tool_call_update` | 工具调用状态更新（in_progress/completed） |
| `usage_update` | Token 用量和费用 |

## session/prompt 请求

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [
      {"type": "text", "text": "Can you analyze this code?"},
      {"type": "resource", "resource": {
        "uri": "file:///home/user/main.py",
        "mimeType": "text/x-python",
        "text": "def process_data(items):..."
      }}
    ]
  }
}
```

## session/update 通知

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "messageId": "msg_agent_c42b9",
      "content": {"type": "text", "text": "I'll analyze your code..."}
    }
  }
}
```

## Stop Reasons

| StopReason | 说明 |
|-----------|------|
| `end_turn` | 模型正常完成 |
| `max_tokens` | 达到 token 上限 |
| `max_turn_requests` | 超过单轮最大请求数 |
| `refusal` | Agent 拒绝继续 |
| `cancelled` | Client 取消 |

## 与 Grok updates.jsonl 的对应

Grok 的 `updates.jsonl` 格式与 ACP `session/update` 几乎完全对应：

| Grok updates.jsonl | ACP session/update |
|-------------------|-------------------|
| `sessionUpdate: "user_message_chunk"` | ✅ 同名 |
| `sessionUpdate: "agent_thought_chunk"` | ✅ 同名 |
| `sessionUpdate: "agent_message_chunk"` | ✅ 同名 |
| `sessionUpdate: "tool_call"` | ✅ 同名 |
| `sessionUpdate: "tool_call_update"` | ✅ 同名 |

→ **Grok 的 updates.jsonl 实际上就是 ACP 协议的本地持久化**

Grok 将 ACP 作为架构核心——内部 TUI (pager) 与 shell 之间通过 ACP 通信。提供三种传输模式：
- `grok agent stdio`：标准 JSON-RPC over stdio
- `grok agent serve`：WebSocket server
- `grok agent headless`：WebSocket relay

此外，Grok 定义了丰富的 `x.ai/*` 扩展方法（文件系统、Git、搜索、终端、会话管理等），详见 [grok.md](./grok.md)。

## ACP 支持 Harness 列表

基于官方 [Agents 页面](https://agentclientprotocol.com/overview/agents)：

| Harness | ACP 支持 | 方式 |
|---------|---------|------|
| **Kimi Code** | ✅ 原生 | `kimi acp` |
| **Devin** | ✅ 原生 | `devin acp` |
| **OpenCode** | ✅ 原生 | 官方列表 |
| **Qwen Code** | ✅ 原生 | 官方列表 |
| **Cursor** | ✅ 原生 | `cursor.com/docs/cli/acp` |
| **Codex CLI** | ✅ 适配器 | Zed 的 `codex-acp` 适配器 |
| **Claude Agent** | ✅ 适配器 | Zed 的 `claude-agent-acp` 适配器 |
| **Pi Agent** | ✅ 适配器 | 第三方 `pi-acp` 适配器 |
| **Gemini CLI** | ✅ 原生 | 官方列表 |
| **GitHub Copilot** | ✅ 原生 | Public preview |
| **Cline** | ✅ 原生 | 官方列表 |
| **Grok** | ✅ 原生 | `grok agent stdio` + WebSocket server + relay |

## 对统一抽象库的影响

### ACP 是核心 protocol transport

之前将 ACP 视为少数 harness 的特殊协议，但实际上 ACP 是**广泛采用的开放标准**，几乎所有主流 harness 都支持或可通过适配器支持。

### 建议架构

```
HarnessAdapter
├── Transport: CLI
│   └── 非交互式执行（--print/-p）
│       用于不支持 ACP 的 harness 或简单场景
│
└── Transport: ACP
    └── JSON-RPC 2.0 over stdio
        用于支持 ACP 的 harness，提供完整的会话管理、流式更新、权限控制
```

### 优先级

ACP 应作为**主要 transport**，CLI 作为 fallback。因为 ACP 提供：
- 标准化的会话生命周期（new → load/resume → prompt → close）
- 统一的流式更新格式（session/update）
- 权限控制（session/request_permission）
- 能力协商（initialize）
- 跨 harness 兼容性