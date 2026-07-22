---
title: Plan 01 Kimi Code 正式适配器
description: 按 active 契约正式实现 Kimi Code 适配器；TDD；合成 fixture；真实数据 sweep 留证。
type: plan
status: pending
created: 2026-07-22T10:20:00Z
---

# Plan 01: Kimi Code 适配器

## Context

契约冻结，核心层已就绪。spike 底稿：`git show spike/0001-adapter-prototypes:src/adapters/kimi-code/index.ts`（经 698 个真实 session 目录验证，参考重写，不合并 spike）。源格式文档：docs/research/schemas/kimi-code-schema.md（注意 ADR-0002 验证段勘误：agent type 为 "sub"）。

## Request

`src/adapters/kimi-code/` 实现 HarnessAdapter（harness "kimi-code"，history "full"，control false，base path 可注入默认 ~/.kimi-code/sessions）。容器 README 记录了映射要点（多 wire、origin.kind、goal、plans、去重）。测试：合成 fixture（state.json + main/sub wire + plans + goal + compaction + interrupted）+ AC 全覆盖 + golden。

## AC 覆盖

AC-0001-N-1/E-1；AC-0002-N-1..N-6、B-1/B-2/**B-3**（无 toolCallId 的 spawned_by）；AC-0003-N-1；AC-0004-N-1。

## Output Format

代码 + fixture + 测试，PR 过 MR 门禁。Report 含：per-AC PASS 表、真实 sweep 统计（只读 ~/.kimi-code）、usage 对账、关联 commit。

## Constraints

- 不修改 active 契约与 src/index.ts；不动其他容器目录
- fixture 一律合成；真实 sweep 用临时脚本（用完删除）
- 无新运行时依赖

## Checkpoint

CI 绿、覆盖率 ≥80%、Report 完整且 check-report 门禁通过。
