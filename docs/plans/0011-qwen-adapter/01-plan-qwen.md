---
title: Plan 01 Qwen Code 正式适配器
description: 按 active 契约实现 Qwen Code 适配器（Google parts[] + 全局 usage join）。本 Plan 为适配器完成后补记（2026-07-24），实际执行记录以 01-report-qwen.md 为准。
type: plan
status: done
created: 2026-07-24T03:03:25Z
---

# Plan 01: Qwen Code 适配器

> 补记说明：本容器执行时走简化流程未留 Plan 文件，本文档为事后补记，内容依据 01-report-qwen.md 的实际执行结果整理，不含未执行的计划项。

## Context

契约冻结（spec v2、interface/0001、ac v2 均 active），共享层已就绪。首家无 spike 底稿的适配器。源格式文档：docs/research/schemas/qwen-schema.md（调研时本机未安装 Qwen，真实数据可能不存在，fixture 按调研文档合成）。实现模板：`src/adapters/claude-code/`（Tree 源模型）。

## Request

`src/adapters/qwen/` 实现 HarnessAdapter（harness "qwen-code"）。源存储：`~/.qwen/projects/-<cwd>-/chats/<uuid>.jsonl` + `<uuid>.runtime.json` + 全局 `usage/token-usage-*.jsonl`（按 sessionId join）。映射要点：

- Tree（parentUuid）线性化：last-leaf 主线启发式，分叉拆 fork session（编辑重发 → forked_from，同 prompt 重答 → sibling_attempt）；functionResponse-only user 行视为并行投递不分叉
- `message.role: "model"` → assistant；`thought: true` part → thinking block
- tool 配对：GenAI parts 内嵌 functionCall/functionResponse，按 part `id` 配对（缺省时确定性回退）；`response.error` → status error
- usage：record 级 usageMetadata → input/output/reasoning/cacheRead（totalTokenCount 为可推导和，丢弃）；全局 token-usage 按 sessionId join，`source != "main"` 行并入 stats.totalUsage（telemetry-only managed subagent 不产生子 session，spec §五），`main` 行仅在无 record 级 usage 时兜底（不双计）；usage_record.jsonl 的 durationMs 求和 → stats.durationMs
- 丢弃（ADR-0001）：attribution_snapshot、file_history_snapshot、ui_telemetry
- runtime.json 仅作 cwd / harnessVersion 回退来源

测试：合成 fixture（多场景含分叉、中断 call、无 usage 缺省）+ AC 全覆盖 + golden + ahs-report 可用性 + e2e 链注册。

## AC 覆盖

AC-0001-N-1/E-1；AC-0002-N-1..N-7、B-1/B-2；AC-0003-N-1；AC-0004-N-1。

## Output Format

代码 + fixture + 测试 + e2e 注册。Report 含：per-AC PASS 表、真实数据结构抽查（本机存在 `~/.qwen` 但按时间预算跳过全量 sweep，遗留发布前补做）、usage 精确对账、映射决策、关联 commit。

## Constraints

- 不修改 active 契约；managed subagent 遥测-only 规则 spec §五已明确，无需补丁
- fixture 全合成手写，禁止真实数据入仓；真实数据只读抽查
- 无新运行时依赖

## Checkpoint

`tsc --noEmit` 通过；vitest 全绿且覆盖率 ≥80%；e2e 链全过；Report 完整。
