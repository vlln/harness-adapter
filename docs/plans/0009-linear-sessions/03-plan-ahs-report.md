---
title: Plan 03 关系存储 + ahs-report 双视图 + 统一 sweep
description: src/ahs 派生 relations.jsonl（双向边 + 组指针 + 传递闭包）；ahs-report 支持 Task 视图（HEAD 链 + 前缀拼接）；统一 sweep 对照 0008 基线。
type: plan
status: pending
created: 2026-07-23T05:40:00Z
---

# Plan 03: 关系存储 + ahs-report + 统一 sweep

## Context

Plan 01+02 已合并。ADR-0005 验证表剩余项：关系存储派生、fork-of-subagent 传递继承、facade 线性直读、统一 sweep 复跑。

## Request

1. `src/ahs/relations.ts`：从归档 manifests + tool_result.sessionId 派生 `relations.jsonl`——双向边表（spawn/fork 两个方向）、组指针 { groupId, mainSessionId }（源端胜者或最近活跃启发式）、传递闭包（fork-of-subagent 的 invocation 继承）；纯派生，可删可重建（AR-005）
2. `examples/ahs-report.ts`：Task 视图——默认渲染组 HEAD 链（沿 lineage 回溯拼接前缀 + 本 session 后缀），子 session 沿 invocation 递归缩进；`--all` 显示组内全部 fork/attempt；聚合无双计
3. e2e 链条测试更新（test/e2e/adapter-chains.ts）
4. **统一 sweep 复跑**（临时脚本，用后删除）：4 家真实数据，对照 0008 Report 基线——0 zod 错误、0 不变量错误、usage 对账 0 偏差；B-4 实证（Devin 两时刻投影）

## Output Format

代码 + 测试（分支 refactor/0009c-ahs-report），PR 过门禁。Report：03-report-ahs-report.md（含 sweep 对照表与 ADR-0005 验证表回填所需的全部数据）。

## Constraints

- 不改 active 契约；关系存储内容必须纯派生
- sweep 不留真实数据

## Checkpoint

CI 绿（含 e2e）、sweep 对照达标、Report 完整。
