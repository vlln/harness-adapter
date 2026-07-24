---
title: Plan 01 Codex 正式适配器
description: 按 active 契约正式实现 Codex 适配器；TDD；合成 fixture；真实数据 sweep 留证。
type: plan
status: done
created: 2026-07-22T10:20:00Z
---

# Plan 01: Codex 适配器

## Context

契约冻结，核心层已就绪。spike 底稿：`git show spike/0001-adapter-prototypes:src/adapters/codex/index.ts`（经 230 个真实 rollout 文件验证，参考重写，不合并 spike）。源格式文档：docs/research/schemas/codex-schema.md + schema-comparison.md 的 2026-07-21 勘误段（sub-agent thread_spawn、developer 角色、turn_aborted、thread_goal_updated）。

## Request

`src/adapters/codex/` 实现 HarnessAdapter（harness "codex"，history "full"，control false，base path 可注入默认 ~/.codex/sessions）。容器 README 记录了映射要点（去重策略、thread_spawn、forked_from lineage、usage 防重复）。测试：合成 fixture（含冗余双形态、thread_spawn 子 session、encrypted reasoning 丢弃、model_change、compaction、goal_update、interrupted）+ AC 全覆盖 + golden。

## AC 覆盖

AC-0001-N-1/E-1（encrypted_content 无法映射仍过 schema）；AC-0002-N-1..N-6、B-1/B-2；AC-0003-N-1；AC-0004-N-1。

## Output Format

代码 + fixture + 测试，PR 过 MR 门禁。Report 含：per-AC PASS 表、真实 sweep 统计（只读 ~/.codex）、usage 对账（投影总量 vs 源端 total_token_usage）、关联 commit。

## Constraints

- 不修改 active 契约与 src/index.ts；不动其他容器目录
- fixture 一律合成；真实 sweep 用临时脚本（用完删除）
- 无新运行时依赖

## Checkpoint

CI 绿、覆盖率 ≥80%、Report 完整且 check-report 门禁通过。
