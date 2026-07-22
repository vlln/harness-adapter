---
title: Plan 01 Claude Code 正式适配器
description: 按 active 契约正式实现 Claude Code 适配器；TDD；合成 fixture；真实数据 sweep 留证。
type: plan
status: pending
created: 2026-07-22T10:20:00Z
---

# Plan 01: Claude Code 适配器

## Context

契约冻结，核心层已就绪（src/validate、src/ahs）。spike 底稿：`git show spike/0001-adapter-prototypes:src/adapters/claude-code/index.ts`（经 173 个真实会话验证，参考重写，不合并 spike）。源格式文档：docs/research/schemas/claude-code-schema.md（注意 ADR-0002 验证段记录的勘误：子代理文件首条 parentUuid=null、compaction 形态为 isCompactSummary）。

## Request

`src/adapters/claude-code/` 实现 HarnessAdapter（harness "claude-code"，history "full"，control false，base path 可注入默认 ~/.claude/projects）。容器 README 记录了映射要点。测试：合成 fixture（含 subagent + goal + compaction + interrupted 案例）+ AC 全覆盖 + golden（AC-0003）。

## AC 覆盖

AC-0001-N-1/E-1；AC-0002-N-1/N-2/N-3/N-4/N-5/N-6、B-1/B-2；AC-0003-N-1；AC-0004-N-1（经归档 + ahs-report）。

## Output Format

代码 + fixture + 测试，PR 过 MR 门禁（CI 绿、覆盖率 ≥80%）。Report 含：per-AC PASS 表、真实 sweep 统计（只读 ~/.claude，不留数据）、关联 commit。

## Constraints

- 不修改 active 契约与 src/index.ts（导出由容器收尾统一接线）；不动其他容器目录
- fixture 一律合成，禁止真实用户数据入仓；真实 sweep 用临时脚本（用完删除）
- 无新运行时依赖

## Checkpoint

CI 绿、覆盖率 ≥80%、Report 完整且 check-report 门禁通过。
