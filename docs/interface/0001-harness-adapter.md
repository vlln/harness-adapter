---
title: Interface-0001 HarnessAdapter 契约
description: HarnessAdapter 只读投影接口：listSessions / readManifest / readRecords，AsyncIterable 返回 AHS Manifest 与 Record；能力声明与错误语义。
type: interface
status: proposed
created: 2026-07-21T11:48:45Z
---

# HarnessAdapter

从 Harness 原生存储到 AHS 的只读投影契约。适配器是纯投影函数：读取原生历史（`~/.claude/`、`~/.codex/` 等），暴露为 AHS sessions + records；从不写回源存储，不追求无损往返（见 [adr/0001](../adr/0001-lossy-projection.md)）。字段定义见 [spec/0001-ahs.md](../spec/0001-ahs.md) 第四节。权威实现：`src/store/adapter.ts`。

## 契约声明（TypeScript）

```typescript
import type { Manifest } from "../schema/manifest";
import type { AhsRecord } from "../schema/record";

/** Filter criteria for listing sessions. Minimal for now. */
export interface SessionFilter {
  harness?: string;
  cwd?: string;
  /** Include lineage descendants (forks/attempts). Default false: only group heads. */
  includeForks?: boolean;
}

export interface HarnessAdapter {
  /** Harness identifier, e.g. "claude-code", "codex", "kimi". */
  readonly harness: string;

  readonly capabilities: {
    /** "none" when the source has no accessible session data (e.g. cloud-only). */
    history: "full" | "partial" | "none";
    /** Whether the adapter can control sessions (start/stop) — usually false. */
    control: boolean;
  };

  listSessions(filter?: SessionFilter): AsyncIterable<Manifest>;

  /**
   * Read the Manifest for a single session by ID — O(1) direct lookup,
   * no listSessions scan. Throws when sessionId does not exist (consistent
   * with readRecords error semantics).
   */
  readManifest(sessionId: string): Promise<Manifest>;

  /**
   * Read records for a session branch. Defaults to the HEAD branch when
   * branchName is omitted. Records are returned in file (JSONL line) order
   * within the branch.
   */
  readRecords(sessionId: string, branchName?: string): AsyncIterable<AhsRecord>;
}
```

## 接口语义

### listSessions

列出源存储中的会话，流式返回 Manifest。

**请求：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filter.harness` | string | 否 | 按 harness 标识过滤 |
| `filter.cwd` | string | 否 | 按工作目录过滤 |
| `filter.includeForks` | boolean | 否 | 默认 false：只列出各 lineage 组的 HEAD session（用户视角默认视图）；true 时含全部 fork/attempt（评测/回溯视角） |

**响应：** `AsyncIterable<Manifest>`——每个元素是一个 session 的 Manifest（字段见 Spec 第四节 Manifest 字段详表）。

### readManifest

读取单个 session 的 Manifest，O(1) 直接定位（不遍历 listSessions）。适用于已知 sessionId 的单 session 投影场景（writeArchive、facade loadSession 等）。

**请求：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 目标 session 标识（原样保留源 ID 形态，不强制 UUID） |

**响应：** `Promise<Manifest>`——该 session 的 Manifest（字段见 Spec 第四节 Manifest 字段详表）。sessionId 不存在时抛出错误（不返回 undefined 静默成功）。

### readRecords

读取指定 session 的一个分支的全部 record，按文件（JSONL 行）顺序流式返回。`branchName` 省略时默认读 HEAD 分支。

**请求：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 目标 session 标识（原样保留源 ID 形态，不强制 UUID） |
| `branchName` | string | 否 | 分支名（省略时默认 HEAD 分支） |

**响应：** `AsyncIterable<AhsRecord>`——record 级数据（JSONL append-only 语义），类型见 Spec 第四节 Record 类型最小集。

### 能力声明

| 字段 | 取值 | 含义 |
|------|------|------|
| `capabilities.history` | `"full"` | 源端历史完整可读 |
| | `"partial"` | 源端部分不可得（如 Cursor 消息正文在云端） |
| | `"none"` | 源端无可访问会话数据（如 OpenCode 无持久化、Devin 桌面端云端） |
| `capabilities.control` | boolean | 是否能控制会话（启动/停止）——当前阶段恒为 false，控制面走 ACP 不在本契约内 |

## 已知限制与演进方向

- 归档读写契约见 [0002-archive.md](0002-archive.md)。
- session facade（loadSession / loadTask）见 [0003-session-facade.md](0003-session-facade.md)。

## 错误语义

| 情况 | 行为 | 调用方处理 |
|------|------|----------|
| `sessionId` 不存在（readManifest） | Promise reject 抛出错误 | 捕获并视为输入错误 |
| `sessionId` 不存在（readRecords） | AsyncIterable 抛出错误（不作为空流静默返回） | 捕获并视为输入错误 |
| 源端数据不可得 | 不抛错；通过 `capabilities.history` 预先声明，listSessions / readManifest 返回可得部分 | 先读 capabilities 再决定消费策略 |
| 源格式无法映射的字段 | 按 Spec 丢弃规则处理，不产生 schema 外字段 | 无需处理（规范保证） |

## 不变量

输出必须满足 [ac/0001-adapter-ac.md](../ac/0001-adapter-ac.md) 层1（zod 校验通过）与层2（因果/关系/内容/usage 完整、幂等）的机器可检查断言。
