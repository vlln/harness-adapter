---
title: Plan 01 Devin 正式适配器
description: 按 active 契约正式实现 Devin 适配器；TDD；编程生成 SQLite fixture；真实数据 sweep 留证。
type: plan
status: done
created: 2026-07-22T10:20:00Z
---

# Plan 01: Devin 适配器

## Context

契约冻结，核心层已就绪。spike 底稿：`git show spike/0001-adapter-prototypes:src/adapters/devin/index.ts`（经真实 16MB sessions.db 验证，参考重写，不合并 spike）。源格式文档：docs/research/schemas/devin-schema.md（注意 ADR-0002 验证段勘误：main_chain_id 指向链尾非 root；分支重试复制 message 需去重）。

## Request

`src/adapters/devin/` 实现 HarnessAdapter（harness "devin"，history "full"，control false，db path 可注入默认 ~/.local/share/devin/cli/sessions.db）。node:sqlite 只读打开（Node ≥22.5）。容器 README 记录了映射要点（森林拆分、去重、角色、usage/credits）。测试：编程生成 SQLite fixture（多 root 森林 + 分支重试重复 + tool 配对 + credits）+ AC 全覆盖 + golden。

## AC 覆盖

AC-0001-N-1/E-1；AC-0002-N-1..N-6、B-1/B-2；AC-0003-N-1；AC-0004-N-1。

## Output Format

代码 + fixture + 测试，PR 过 MR 门禁。Report 含：per-AC PASS 表、真实 sweep 统计（复制 sessions.db 到 temp 后只读）、usage 对账、关联 commit。

## Constraints

- 不修改 active 契约与 src/index.ts；不动其他容器目录
- fixture 编程生成（temp dir），禁止真实数据入仓；真实 sweep 用临时脚本（用完删除）
- 无新运行时依赖（node:sqlite 内置）

## Checkpoint

CI 绿、覆盖率 ≥80%、Report 完整且 check-report 门禁通过。
