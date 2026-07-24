---
title: Plan 01 系统测试：真实 e2e + 统一 sweep
description: 真实 CLI 端到端用例（适配器→归档→ahs-report 全链路），统一真实数据 sweep，失败原因分类，系统测试 Report。
type: plan
status: done
created: 2026-07-22T12:00:00Z
---

# Plan 01: 系统测试

## Context

4 个正式适配器已落地 develop（147 测试全绿，覆盖率 97.96%/86.2%）。TEST_INFRA 的 e2e 当时是框架占位（test/e2e/smoke.ts），现在适配器可用，替换为真实全链路用例。各适配器 Report 已有单家 sweep 证据，本 Plan 做统一复跑 + 失败分类。

## Request

1. **真实 e2e**（test/e2e/）：对 4 个适配器各跑全链路——适配器读 fixture → exportSessions 导出 AHS 归档到 temp → vite-node 运行 examples/ahs-report.ts CLI 子进程 → 断言退出码 0、stdout 含 transcript 结构与聚合数字（与 record 级求和一致）。保留原 smoke（框架启动断言）。
2. **统一 sweep**：临时脚本（用后删除）对 ~/.claude、~/.codex、~/.kimi-code、Devin sessions.db（先复制）全量投影：session/record 计数、zod/不变量错误数、usage 对账。结果写入 Report，不留任何真实数据。
3. **失败原因分类**：任何失败按 基建缺陷/设计缺陷/局部 bug 分类记录；预期无失败。
4. **阻塞级缺陷判定**：明确结论。

## Output Format

- 代码：test/e2e/ 真实用例（test/0008-system-test 分支，PR 过门禁合并）
- Report：docs/plans/0008-system-test/01-report-system-test.md（type: report, status: complete；e2e 结果、sweep 统计表、失败分类、阻塞判定、commit 引用）

## Constraints

- 不修改 active 契约；发现契约问题停止上报
- sweep 不留真实数据；e2e 只用仓库内合成 fixture

## Checkpoint

CI 绿（含新 e2e）、Report 完整、check-report 门禁通过。
