---
title: Plan-01 readManifest 实现
description: 在全部 7 个 adapter 实现 readManifest(sessionId)，更新 writeArchive/facade 使用 readManifest，新增 ahs-export CLI。
type: plan
status: pending
created: 2026-07-24T15:00:00Z
---

# Plan-01: readManifest 实现

## 目标

实现 interface/0001 契约新增的 `readManifest(sessionId): Promise<Manifest>` 方法。

## AC 覆盖

- AC-0001-N-2: readManifest 返回合法 Manifest（zod parse）
- AC-0001-E-2: readManifest 传入不存在的 sessionId 抛错
- AC-0002-N-8: readManifest 与 listSessions 结果逐字段一致

## 步骤

### 1. 7 个 adapter 实现 readManifest

每个 adapter 的底层存储都是 per-session 的文件/行，`listSessions` 内部已经会读取每个 session 的数据来合成 manifest。`readManifest` 是 O(1) 直接定位单个 session 的数据并合成 manifest。

| Adapter | 存储形态 | readManifest 实现 |
|---------|---------|------------------|
| claude-code | `~/.claude/` 下 per-session JSONL | 找到对应文件，读取合成 manifest |
| codex | `~/.codex/` rollout JSONL | 同上 |
| kimi-code | `~/.kimi/` wire.jsonl per agent | 同上 |
| devin | SQLite | 查询单行 |
| grok | chat_history.jsonl | 找到对应 session |
| qwen | chats/<uuid>.jsonl | 直接读文件 |
| pi | <iso>_<ulid>.jsonl | 直接读文件 |

### 2. 更新 writeArchive

`src/ahs/writer.ts` 的 `writeArchive` 当前遍历 `listSessions({ includeForks: true })` 找 manifest。改为直接调用 `adapter.readManifest(sessionId)`。

### 3. 更新 facade loadSession/loadTask

`src/session/facade.ts` 的 `loadSession`/`loadTask` 同样遍历 listSessions 找 manifest。改为调用 `readManifest`。

### 4. 新增 ahs-export CLI

`examples/ahs-export.ts`：从 native 存储导出单个 session（或全部）为 AHS 磁盘格式。与 `ahs-report.ts` 对称。

```
ahs-export <harness> <sessionId> <outDir>   # 单个 session
ahs-export <harness> <outDir>               # 全部 session
```

### 5. 测试

- 每个 adapter 的现有测试补充 readManifest 用例
- writeArchive/facade 测试验证行为不变（只是不再遍历）
- ahs-export CLI 测试

## Constraints

- readManifest 结果必须与 listSessions 遍历找到的 manifest 逐字段一致（AC-0002-N-8）
- 不存在的 sessionId 必须抛错（AC-0001-E-2），不返回 undefined
- 不改变 listSessions / readRecords 的现有行为

## Checkpoint

- 全部测试通过
- 覆盖率不下降
- 幂等性不变
