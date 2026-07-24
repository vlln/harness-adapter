---
title: 0011-qwen-adapter Report 01 — Qwen Code 适配器
description: Qwen Code（Google parts[] + 全局 usage join）形式化适配器实现报告：AC 覆盖、映射决策、验证结果。
type: report
status: complete
created: 2026-07-23T18:45:00Z
---

# 0011-qwen-adapter / 01: Qwen Code 适配器 Report

对应 Plan：01-plan-qwen.md。分支：`feat/0011-qwen-adapter`。依据：spec v2、interface/0001、ac v2（均 active）。模板：`src/adapters/claude-code/`（Tree 源模型）。

## AC 覆盖

| AC | 结果 | 验证位置 |
|----|------|---------|
| AC-0001-N-1（层1 合法） | PASS — 全部 manifest/record 过 zod parse | test/qwen-adapter.test.ts |
| AC-0001-E-1（不可映射字段丢弃） | PASS — attribution_snapshot / file_history_snapshot / ui_telemetry / contextWindowSize / totalTokenCount 无残留，strict parse 通过 | test/qwen-adapter.test.ts |
| AC-0002-N-1（线性 seq） | PASS — validateSessions 0 错误；seq 连续断言 | src/validate + test |
| AC-0002-N-2（invocation） | PASS — 源模型无对话级 subagent（managed subagent 仅遥测，spec §五不产生子 session）；全 fixture 无 invocation，断言成立 | test/qwen-adapter.test.ts |
| AC-0002-N-3（内容无静默丢失） | PASS — user/assistant 条数与源相等，文本逐字保留（含 thought → thinking） | test/qwen-adapter.test.ts |
| AC-0002-N-4（usage 无静默丢失） | PASS — record 级求和 = 全局 main 行求和（精确对账：64413/124/11008/90）；subagent 行并入 stats | test/qwen-adapter.test.ts |
| AC-0002-N-5（幂等） | PASS — checkIdempotency 0 错误（两次运行逐字节一致） | src/validate |
| AC-0002-N-6（tool 配对） | PASS — 每个 tool_call 恰有配对 result 或 interrupted；functionCall/functionResponse 按 id 配对 | src/validate + test |
| AC-0002-N-7（fork 血统） | PASS — 编辑重发 → forked_from（锚 assistant）；同 prompt 重答 → sibling_attempt（锚 user_message）；主线 = 最后叶子链 | test/qwen-adapter.test.ts |
| AC-0002-B-1（中断 call） | PASS — 无配对 result 的 call-0004 标 interrupted，无合成 result | test/qwen-adapter.test.ts |
| AC-0002-B-2（usage 缺省） | PASS — fixture C 无 usage → stats.totalUsage 缺省；存在 usage 不丢弃；record 无 usageMetadata 时全局 main 行兜底（不双计） | test/qwen-adapter.test.ts |
| AC-0003-N-1（golden diff） | PASS — 5 个 session（3 main + 2 fork）stableSerialize 逐字节一致；fixture 全合成手写 | test/qwen-golden.test.ts + test/fixtures/qwen/golden/ |
| AC-0004-N-1（可用） | PASS — exportSessions → ahs-report 渲染 transcript（thinking 折叠、tool_call 内联、interrupted 标注），聚合 input=11300/output=70/cacheRead=300/reasoning=17 与 record 级求和精确一致 | test/qwen-report.test.ts |
| 元标准 | PASS — 未新增字段/record 类型/逃生舱 | — |

## 真实数据 sweep

本机存在 `~/.qwen`（2 个 chat 文件、6 行 token-usage、3 行 usage_record），但按主代理时间预算指示跳过全量 sweep，验证以合成 fixture 为准。真实数据结构抽查（只读）与调研文档一致：parts {text, thought?}、无分叉点、无 functionCall 部分、token-usage 行 `source: "main" | "managed-auto-memory-extractor"`。**遗留**：发布前本地 sweep（含 invariant + usage 对账）仍应补做。

## 映射决策

- **harness id**：`qwen-code`（与 kimi-code / claude-code 命名一致）。
- **role 映射**：`type: "assistant"` 为准（源 `message.role` 为 `"model"`），`thought: true` part → thinking block。
- **tool 配对**：GenAI parts 内嵌 functionCall/functionResponse；toolCallId 取 part `id`，缺省时 call 侧用确定性 `<uuid>/functionCall/<i>`、response 侧回退函数名（GenAI 按名配对）。`response` 含 `error` 键 → status error。
- **usage**：usageMetadata → input=promptTokenCount、output=candidatesTokenCount、reasoning=thoughtsTokenCount、cacheRead=cachedContentTokenCount；totalTokenCount 为可推导和，丢弃。全局 token-usage 按 sessionId join：`source != "main"` 行并入 stats.totalUsage（telemetry-only，无子 session）；`main` 行仅在 session 完全无 record 级 usage 时兜底（不双计）。usage_record.jsonl 的 durationMs 跨条目求和 → stats.durationMs。
- **system 记录**：attribution_snapshot / file_history_snapshot / ui_telemetry 全部按 ADR-0001 丢弃，子记录穿链。
- **线性化**：与 claude-code 相同的 last-leaf 主线启发式；functionResponse-only user 行视为并行投递，留在链内不分叉。
- **runtime.json**：cwd / harnessVersion 的回退来源（record 字段优先）；pid/hostname/started_at 为过程元数据，丢弃。

## 契约摩擦

无。Qwen 树模型 + parts 内容模型完整落入 spec v2；managed subagent 的"遥测-only → 并入 stats"规则 spec §五已明确，无需补丁。

## 验证

- `npx tsc --noEmit`：通过。
- `npx vitest run --coverage`：226 tests 全绿（新增 24：qwen-adapter 22 + golden 1 + report 1）；全仓 98.16% 行覆盖，`src/adapters/qwen` 97.64% 行 / 100% 函数。
- `npm run test:e2e`：5 条 adapter 链全过（含新增 qwen 链）。

## 提交

- `44ff532` feat(adapter): qwen formal adapter（代码 + fixture + golden + 测试 + e2e 注册）
- 文档提交见本文件同分支后续 commit。
