# Agent 工程概念定义

## 核心定义

### Agent

```
Agent = Model + Harness
```

- **Model**：LLM 本身，负责推理和生成
- **Harness**：模型外面的"马具"，负责驱动模型与环境交互

### Harness

```
Harness = ReAct(Tools + Prompt + Hooks)
```

Harness 实现了 ReAct 循环，使 Agent 能够在环境中执行工具调用、观察结果、继续推理。

**ReAct 循环**是 Agent 区别于 Chat Bot 的关键——Chat Bot 只能一问一答，Agent 可以思考→行动→观察→再思考的循环。

### Scaffold vs Harness

这两个概念都在 Agent 内部，但职责不同：

| 概念 | 定义 | 模型是否可见 |
|------|------|-------------|
| **Scaffold** | 模型看到的东西，注入到上下文中（但不属于业务内容） | ✅ 进上下文 |
| **Harness** | 模型看不到的东西，不进上下文 | ❌ 不进上下文 |

**Scaffold 示例：**
- System prompt（系统指令）
- 工具定义（function declarations）
- 注入的上下文信息（user_info、git status、skills 列表等）
- 格式约束（output schema、thinking tags）

**Harness 示例：**
- ReAct 循环本身（调度模型调用→解析工具调用→执行→回传结果）
- 大部分 Hooks（日志、metrics、cost tracking）
- 工具执行引擎（沙箱、超时、重试）
- 会话持久化
- 权限控制

两者共同构成 Agent 的能力体系。

---

## Hooks

Hooks 是在 Agent 生命周期不同阶段的回调函数，分两类：

### 1. 信息注入型 Hook（进上下文）

在特定时机向模型上下文注入额外信息，直接影响模型行为。

```
示例：
- PreToolUse hook：在工具执行前注入提示
- PostToolUse hook：在工具执行后注入结果摘要
- ContextCompaction hook：压缩上下文时注入摘要
```

### 2. 副作用型 Hook（不进上下文）

在特定时机执行副作用操作，不影响模型推理。

```
示例：
- 日志记录
- 用量统计
- 通知发送
- 状态持久化
```

---

## 工程视角

### Harness Engineering（Agent 内部视角）

- **焦点**：优化 Agent 内部组成
- **工作内容**：优化 Tools、Hooks、Prompts
- **目标**：让 Agent 表现出更强的能力
- **基本单元**：Tool Call（行动）

### Loop Engineering（Agent 外部视角）

- **焦点**：以 Agent 为基本单元构建循环
- **工作内容**：定义 Agent 能力边界、设计验证器、设定触发器、构造全局状态、组织 workflow
- **基本单元**：Agent

### 层级关系

```
Loop Engineering（业务层）
    │
    │  以 Agent 为基本单元
    │
    ▼
Harness Engineering（工具层）
    │
    │  以 Tool Call 为基本单元
    │
    ▼
ReAct 循环（执行层）
```

---

## 常见问题

### Q: Loop 是 code reviewer 循环/PR 循环等编程工作中的吗？

A: Loop 本质是工作流，不限定任何任务类型。Code review 循环只是一个具体实例。

### Q: Loop 与以前的 Workflow（例如 Dify）有什么区别？

A: 层级不同。过去的 Workflow 原语是函数/LLM/prompt/知识库等，Loop 的原语是 **Agent**。Agent 是更高层级的抽象，内部封装了完整的 ReAct 能力。