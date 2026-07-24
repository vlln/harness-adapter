---
title: Interface-0003 Session Facade 契约
description: langchain 风格的消费方 facade：loadSession/loadTask 双视图、messages 投影、usage 聚合、children 递归；构建在 HarnessAdapter 流式底层之上。
type: interface
status: active
created: 2026-07-23T06:30:00Z
---

# Session Facade

面向交互式消费方的统一读取门面（langchain 式："list → load → 取 messages/metadata"）。构建在 [0001-harness-adapter](0001-harness-adapter.md) 的流式底层之上：facade 做内存物化与投影，底层接口不变（大 session 批量处理仍走 `readRecords` 流）。数据模型见 [spec/0001-ahs.md](../spec/0001-ahs.md)。权威实现：`src/session/`。

## 入口

```typescript
openHarness(name: "claude-code" | "codex" | "kimi-code" | "devin", options?: { basePath?: string }): HarnessFacade

interface HarnessFacade {
  readonly adapter: HarnessAdapter
  listSessions(filter?: SessionFilter): AsyncIterable<Manifest>   // 透传底层
  loadSession(sessionId: string): Promise<AhsSession>             // 存储视角
  loadTask(sessionId: string): Promise<AhsTask>                   // 用户视角（lineage 组 + HEAD）
}
```

## AhsSession（存储视角）

```typescript
interface AhsSession {
  readonly manifest: Manifest
  messages(): ConversationItem[]     // 对话投影（见下）
  events(): StateEvent[]             // 状态事件时间线（turn_boundary/model_change/compaction/goal_update）
  readonly usage: Usage              // 本 session 聚合（records 求和）
  children(): Promise<AhsSession[]>  // invocation 直接子 session（需同 store 内可发现）
}
```

### messages() 投影规则

record → ConversationItem 的映射：

| record | 投影 |
|--------|------|
| `user_message` | `{ kind: "user", content, timestamp }` |
| `assistant_message` | `{ kind: "assistant", content[]（text/thinking/image blocks）, timestamp }` |
| `harness_message` | `{ kind: "harness", content, timestamp }` |
| `tool_call` + 配对 `tool_result` | `{ kind: "tool", call: {name, args}, result?: {content, status}, status, sessionIds? }`（配对在投影内完成；`status: "interrupted"` 时无 result） |
| 状态类 record | 不进 messages()，进 events() |

顺序即 `seq`。线性 session 无分支选择逻辑（ADR-0005）。

### events()

状态类 record 按 seq 原样暴露（turn_boundary / model_change / compaction / goal_update），供时间线展示与统计。

### children()

通过 `invocation` 回链反查（等价于关系存储的 invocation 边），返回直接子 session；递归由消费方自行组合。找不到子 session（未导出/未安装对应 harness）时跳过，不报错。

## AhsTask（用户视角）

```typescript
interface AhsTask {
  readonly groupId: string
  readonly head: AhsSession           // HEAD session（最近活跃或源端胜者）
  readonly members: AhsSession[]      // 组内全部 session（fork/attempt）
  messages(): ConversationItem[]      // HEAD 链拼接：沿 lineage 回溯共享前缀 + HEAD 后缀，线性一条
}
```

- HEAD 判定：与关系存储一致（最近活跃启发式；源端胜者信息不可得于本层）。
- 组解析需扫描 store 内全部 manifest（listSessions includeForks）——大 store 上的成本在文档中声明。

## 错误语义

| 情况 | 行为 |
|------|------|
| `loadSession` 的 sessionId 不存在 | 抛错（SessionNotFoundError），不返回空对象 |
| `loadTask` 的 sessionId 不存在 | 同上 |
| 子 session 不可发现（跨 store/未安装） | `children()` 跳过该边，不报错 |
| 大 session 内存顾虑 | 文档指引走底层 `readRecords` 流式接口 |

## 不变量

- facade 输出只依赖底层契约数据（Manifest + records + 两维回链），不读源存储
- `messages()` 的 tool 配对与 AC-0002-N-6 的 XOR 规则一致
- `AhsTask.messages()` 的共享前缀不重复出现（拼接在锚点处切分）
