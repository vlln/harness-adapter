---
title: Plan 01 schema + validate 重构
description: record 删 parentId；relation → lineage/invocation 两槽；Manifest 删 isMainChain；tool_result +sessionId；validate 按 AC v2 重写不变量。
type: plan
status: pending
created: 2026-07-23T05:40:00Z
---

# Plan 01: schema + validate 重构

## Context

ADR-0005（accepted）+ spec v2 + AC v2 已传导完成。schema 与 validate 是全部下游（适配器、ahs、report）的基础，必须先独立合并。现模型（tree/parentId/spawned_by/isMainChain）的测试会大量失效，按 AC v2 重写。

## Request

1. `src/schema/record.ts`：BaseRecord 删 `parentId`；`tool_result` 加可选 `sessionId`
2. `src/schema/relation.ts` + `manifest.ts`：`relation` 拆为 `lineage { type: "forked_from" | "sibling_attempt", sessionId, atRecordId? }` 与 `invocation { sessionId, atRecordId? }` 两个可选槽；Manifest 删 `isMainChain`
3. `src/validate/` 按 AC v2 重写：N-1（无结构字段、seq 严格递增连续）、N-2（invocation 回链存在 + atRecordId 指向父中 tool_call + tool_result.sessionId 正回链对账）、N-6（XOR，不变）、N-7（lineage 锚点可解析 + 锚点 role ⇔ 类型判据）、B-4 辅助（两次投影 session 集字节对比工具）。关系检查跨 session 进行，接口相应调整
4. 同步修复受影响的现有测试（builders、ahs-archive、ahs-report 测试）——ahs/report 的正式重构在 Plan 03，本 Plan 仅让它们编译通过、测试适配新 schema

## Output Format

代码 + 测试（分支 refactor/0009a-schema-validate），PR 过门禁。Report：01-report-schema-validate.md（AC-0002-N-1/N-2/N-7 PASS 证据 + commit 引用）。

## Constraints

- 不改 active 契约；发现矛盾停止上报
- 无新运行时依赖；破坏性变更允许（pre-1.0，ADR-0005 即授权）

## Checkpoint

CI 绿、覆盖率 ≥80%、Report 完整。
