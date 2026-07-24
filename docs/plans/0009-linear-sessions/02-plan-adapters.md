---
title: Plan 02 适配器线性化重构
description: 4 个适配器按 ADR-0005 重构：线性化 + fork 合成 + invocation 两链 + HEAD 指针；worktree 并行；复用 spike/正式版映射知识。
type: plan
status: done
created: 2026-07-23T05:40:00Z
---

# Plan 02: 适配器线性化重构

## Context

Plan 01 已合并（新 schema/validate）。4 个适配器从 tree 输出改为线性 session + fork 合成。映射知识见各适配器现有代码注释与 docs/plans/0004-0007 Report。

## Request（每个适配器一个子任务，worktree 并行）

- **claude-code**：主文件线性化——分叉（编辑重发/重试）拆 fork session（last leaf 主线启发式，锚点 role 定 fork/sibling）；subagent → invocation 回链（锚 toolUseId 对应 record）+ 父中 Task tool_result.sessionId 正链
- **codex**：thread_spawn → invocation 两链；rollout 文件祖先 lineage → forked_from
- **kimi-code**：子 wire → invocation 回链（无 atRecordId，AC-0002-B-3）；forked 事件源端无 id 维持不可得
- **devin**：每 root 一线性 session（去掉树内去重 forwarding map）；root 间 fork/sibling 锚共享前缀（message_id 对账）；main_chain_id → 组 HEAD 指针（上溯 tip→root）

统一要求：listSessions 支持 includeForks（默认只出各组 HEAD）；AC v2 全覆盖（含 N-7、B-4）；真实 sweep 复跑留证（0 不变量错误、usage 对账）。

## Output Format

每适配器：代码 + fixture 更新 + 测试，各自 PR 过门禁。Report：02-report-adapters.md（统一一份，按适配器列 AC PASS 证据 + sweep 统计 + commit 引用）。

## Constraints

- 不改 active 契约与 src/index.ts 以外的共享文件冲突面（worktree 隔离）
- fixture 合成；sweep 临时脚本用后删除

## Checkpoint

4 个 PR 全合并、CI 绿、Report 完整。
