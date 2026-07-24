---
title: Plan 01 Pi Agent 正式适配器
description: 按 active 契约实现 Pi Agent 适配器（最简 tree，含 cost 映射）。本 Plan 为适配器完成后补记（2026-07-24），实际执行记录以 01-report-pi.md 为准。
type: plan
status: done
created: 2026-07-24T03:03:25Z
---

# Plan 01: Pi Agent 适配器

> 补记说明：本容器执行时走简化流程未留 Plan 文件，本文档为事后补记，内容依据 01-report-pi.md 的实际执行结果整理，不含未执行的计划项。

## Context

契约冻结（spec v2、interface/0001、ac v2 均 active），共享层已就绪。最简单的 harness。源格式文档：docs/research/schemas/pi-agent-schema.md；移植蓝本：obsidian-harness-frontend importer `_parse_pi`。实现模板：`src/adapters/claude-code/`（tree 源，最简）。本机存在 `~/.pi/agent/sessions`（181 个 session 文件），可做真实数据 sweep。

## Request

`src/adapters/pi/` 实现 HarnessAdapter。源存储：`~/.pi/agent/sessions/--<cwd>--/<iso-ts>_<ulid>.jsonl`（单文件，protocol version 3）。映射要点：

- 线性化：parentId 树实践中近乎线性（并行 toolResult 串成链）；多子节点 = 真实分叉（edit-resend/retry）拆 fork session（只存后缀）；主线 = 最后叶子所在子树；锚点类型判据 user_message ⇔ sibling_attempt
- 首条 `session` record → Manifest（cwd、id、时间）；harnessVersion = 存储协议版本字符串（如 "3"）；model/provider 取首个 model_change；无 title/git/profile 机制则省略
- `model_change` → model_change record；`thinking_level_change` → model_change record（携带当前模型，thinkingLevel 丢弃；首个 model_change 之前出现时丢弃）
- usage：input/output/cacheRead/cacheWrite/reasoning 直译；`cost.total` → `cost { amount, currency: "USD" }`（源端无 currency，USD 为文档化假设）；`totalTokens` 冗余丢弃——唯一有 cost 的 harness，验证 cost 映射路径
- 双时间戳统一：record 级 ISO 为准，message 级 Unix-ms 丢弃
- toolResult：`isError` → status；多 text block 以 "\n" 连接；同 toolCallId 多 result 取文件序第一条；悬空 call 标 interrupted
- error assistant 消息（stopReason:error，空 content，全零 usage）不产出 record；errorMessage 按 ADR-0001 丢弃
- `session.parentSession`（跨文件 continue-from 指针，真实数据 181 文件中 1 例）：因重录共享前缀与 AHS fork 只存后缀模型冲突，按独立自足 session 投影，parentSession 丢弃，作为契约摩擦如实报告

测试：合成 fixture（脱敏，含分叉、中断 call、usage 缺省、非零 cost）+ AC 全覆盖 + golden + ahs-report 可用性（cost 聚合）+ e2e 链注册 + 真实数据只读 sweep（临时脚本与快照，用完删除）。

## AC 覆盖

AC-0001-N-1/E-1；AC-0002-N-1..N-7（N-2 源端不适用）、B-1/B-2；AC-0003-N-1；AC-0004-N-1。

## Output Format

代码 + fixture + 测试 + e2e 注册。Report 含：per-AC PASS 表、真实 sweep 统计（181 文件 → 184 session / 1347 record / 0 错误）、usage/cost 精确对账、契约摩擦（parentSession 未映射、cost currency 假设）如实报告、关联 commit。

## Constraints

- 不修改 active 契约；契约摩擦如实报告，需 spec 层决策的不在适配器内打补丁
- fixture 全合成手写（脱敏），禁止真实数据入仓；真实 sweep 用临时脚本（用完删除）
- 无新运行时依赖

## Checkpoint

`tsc --noEmit` 通过；vitest 全绿且覆盖率 ≥80%；e2e 链全过；真实 sweep 0 错误且 usage 对账精确相等；Report 完整。
