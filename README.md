# Harness Adapter

编码 Agent Harness 的中立通用抽象库。一次开发适配器，调度、评测、可视化全生态共享。

## 问题

Codex、Claude Code、Kimi Code、Devin、Grok、Qwen Code……各厂商的编码 Agent Harness 相互封闭，上层工具（调度、评测、可视化、迁移）需要为每个 Harness 重复开发专属适配层。

## 方案

构建一个中立的通用抽象库，兼容各个 Harness 的：

- **历史数据**：读取会话记录（消息、工具调用、token 用量）
- **Meta 信息**：查询会话元数据（模型、时间、工作目录、状态）
- **操作 Harness**：启动、恢复、停止会话；动态注入 Agent Profile

## 调研进度

### 已完成

| 领域 | 文档 | 覆盖 |
|------|------|------|
| 概念定义 | [Agent 工程概念](docs/research/agent-engineering-concepts.md) | Agent=Model+Harness, Scaffold, Hooks, Loop vs Harness |
| 项目动机 | [动机与愿景](docs/research/harness-adapter-motivation.md) | 碎片化问题、统一抽象、AHS 标准 |
| 存储 Schema | [schemas/](docs/research/schemas/) | 9 个 Harness 的会话存储结构 |
| Schema 对比 | [schema-comparison.md](docs/research/schemas/schema-comparison.md) | 跨 Harness 对比总表 |
| 交互接口 | [interfaces/](docs/research/interfaces/) | 每个 Harness 的 CLI + ACP transport |
| ACP 协议 | [acp-protocol.md](docs/research/interfaces/acp-protocol.md) | 官方 ACP 规范调研 |
| 动态能力注入 | [dynamic-capabilities.md](docs/research/interfaces/dynamic-capabilities.md) | Skills/MCPs/Tools/Prompt/Hooks/Agents 对比 |
| 版本锁定 | [versions.md](docs/research/versions.md) | 所有 Harness 版本及源码仓库 |

### 已调研 Harness

| Harness | 存储 | 接口 CLI | 接口 ACP | Agent Profile |
|---------|------|---------|---------|---------------|
| Pi Agent | JSONL Tree | ✅ | 适配器 | Extension |
| Claude Code | JSONL Graph | ✅ | 适配器 | `--agent`/`--agents` |
| Kimi Code | State + Wire | ✅ | ✅ `kimi acp` | ❌ |
| Codex | JSONL Stream | ✅ | 适配器 | ❌ |
| Qwen Code | JSONL Tree | ⚠️ 未安装 | ✅ 原生 | ❌ |
| OpenCode | 无持久化 | ⚠️ 未运行 | ✅ 原生 | ❌ |
| Devin | SQLite Forest | ✅ | ✅ `devin acp` | `--agent-config` |
| Cursor | SQLite + Cloud | ❌ (IDE) | ✅ 原生 | IDE 内置 |
| Grok | JSONL + SQLite | ✅ | ✅ `grok agent stdio` | `--agent-profile` |

### 待调研

- 统一 AHS (Agent History Standard) Schema 设计
- 适配器接口定义与实现
- 各 Harness 的实际 ACP 交互验证

## 结构

```
docs/research/
├── agent-engineering-concepts.md
├── harness-adapter-motivation.md
├── versions.md
├── schemas/
│   ├── pi-agent-schema.md
│   ├── claude-code-schema.md
│   ├── kimi-code-schema.md
│   ├── codex-schema.md
│   ├── qwen-schema.md
│   ├── opencode-schema.md
│   ├── devin-schema.md
│   ├── cursor-schema.md
│   ├── grok-schema.md
│   └── schema-comparison.md
└── interfaces/
    ├── pi-agent.md
    ├── claude-code.md
    ├── kimi-code.md
    ├── codex.md
    ├── qwen-code.md
    ├── opencode.md
    ├── devin.md
    ├── cursor.md
    ├── grok.md
    ├── acp-protocol.md
    └── dynamic-capabilities.md
```

## 概念速览

```
Agent = Model + Harness
Harness = ReAct(Tools + Prompt + Hooks)

Scaffold: 模型看到的东西（进上下文）
Harness:  模型看不到的东西（ReAct 循环、Hooks）

Harness Engineering: 优化 Agent 内部（Tools/Hooks/Prompts）
Loop Engineering:   以 Agent 为基本单元构建工作流
```