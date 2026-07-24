---
title: 0012-grok-adapter Report 01 — Grok 适配器
description: Grok（xAI CLI，chat_history 规范表示 + events 恢复时间戳/turn 边界）形式化适配器实现报告：AC 覆盖、映射决策、验证结果。
type: report
status: complete
created: 2026-07-23T19:00:00Z
---

# 0012-grok-adapter / 01: Grok 适配器 Report

对应 Plan：README 状态表 01-plan-grok.md。分支：`feat/0012-grok-adapter`。依据：spec v2、interface/0001、ac v2（均 active）。模板：`src/adapters/kimi-code/`（目录制 session + 元数据文件）。调研：docs/research/schemas/grok-schema.md。

## AC 覆盖

| AC | 结果 | 验证位置 |
|----|------|---------|
| AC-0001-N-1（层1 合法） | PASS — 全部 manifest/record 过 zod parse | test/grok-adapter.test.ts |
| AC-0001-E-1（不可映射字段丢弃） | PASS — system 系统提示、encrypted_content、空 summary reasoning、model_fingerprint/reasoning_effort、loop/phase 生命周期事件均无残留，strict parse 通过 | test/grok-adapter.test.ts |
| AC-0002-N-1（线性 seq） | PASS — validateSessions 0 错误；recordId=`<sessionId>:<seq>` 连续断言 | src/validate + test |
| AC-0002-N-2（invocation） | PASS（不适用）— 源端无 subagent 独立存储（调研确认），适配器不产生 invocation；不变量在全会话集上成立 | src/validate |
| AC-0002-N-3（内容无静默丢失） | PASS — user/assistant 条数与源相等，文本逐字保留（reasoning summary → thinking block 并入下一条 assistant_message） | test/grok-adapter.test.ts |
| AC-0002-N-4（usage 无静默丢失） | PASS（按 B-2 处理）— 源端无 record 级 usage block；signals.json 聚合指标（contextTokensUsed 为上下文窗口度量，非请求 input/output 求和）在 AHS Usage 中无诚实归处，不伪造 totalUsage | test/grok-adapter.test.ts |
| AC-0002-N-5（幂等） | PASS — checkIdempotency 0 错误（真实数据 sweep 同为 0） | src/validate |
| AC-0002-N-6（tool 配对） | PASS — 每个 tool_call 恰有配对 result 或 interrupted；同 tool_call_id 多个 result 取文件序第一条 | src/validate + test |
| AC-0002-N-7（fork 血统） | PASS（不适用）— rewind_points.jsonl 检查点无分叉链接（rewind 原地改写本 session 历史），不产生 lineage；includeForks 为 no-op 并有专项测试 | test/grok-adapter.test.ts |
| AC-0002-B-1（中断 call） | PASS — 悬空 call-g003 标 interrupted，无合成 result | test/grok-adapter.test.ts |
| AC-0002-B-2（usage 缺省） | PASS — 全 fixture 无 record 级 usage → 无 usage 字段、无 totalUsage；不丢弃也不伪造 | test/grok-adapter.test.ts |
| AC-0003-N-1（golden diff） | PASS — 2 个 session stableSerialize 逐字节一致；fixture 全合成手写（脱敏） | test/grok-golden.test.ts + test/fixtures/grok/ |
| AC-0004-N-1（可用） | PASS — exportSessions → ahs-report 渲染 transcript（user/harness/thinking/tool/turn boundary/model_change/interrupted 全呈现）；源无 usage 故 token 总计为 0，session slice 正确 | test/grok-report.test.ts + test/e2e/adapter-chains.ts（grok 链） |
| 元标准 | PASS — 未新增字段/record 类型/逃生舱 | — |

## 真实数据 sweep

本机存在 `~/.grok`（9 个 session 目录）。只读 sweep（chat_history.jsonl + summary.json + events.jsonl + signals.json，临时脚本已删除）：

- **session：9，record：161**（user_message 21 / harness_message 19 / assistant_message 23 / tool_call 35 / tool_result 35 / turn_boundary 28）
- **zod 校验错误：0；AC 层2 不变量错误：0；幂等性错误：0**；耗时 237ms
- harnessVersion 正确取自 `~/.grok/version.json`（0.2.106）；title/model/turnCount/durationMs 与 summary.json/signals.json 一致
- usage 对账：源端无 record 级 usage，无可对账项（signals.contextTokensUsed 语义不符，见映射决策）

## 映射决策

- **harness id**：`grok`（源 self-identify 为 Grok；provider 固定 `xai`）。
- **规范表示 = chat_history.jsonl**；updates.jsonl（chunk 流）与 events.jsonl 的 loop/phase/tool 生命周期事件按 ADR-0001 丢弃。
- **时间戳恢复**：chat_history 行无时间戳。events.jsonl `turn_started.conversation_message_count` 经验证是 chat_history 的精确前缀长度（真实数据逐 turn 核对），据此每个 record 继承所在 turn 的开始时间；turn_started/turn_ended 同时发射 turn_boundary record（turnId = turn_number）。events 缺失时回退 summary.created_at，再回退 epoch——全部源端派生，无墙钟读取。
- **provenance 标杆**：`synthetic_reason` 非 null（system_reminder / project_instructions）→ harness_message；缺省 → user_message（首条 user_info 环境注入无标记，按标记忠实投为 user_message）。
- **reasoning**：encrypted_content 不可解密（同 Codex）丢弃；明文 summary[] → thinking block 并入下一条 assistant_message（流序 reasoning→assistant）；空 summary 的 reasoning 整体丢弃。
- **tool_result 实际形态**：真实数据为 `{tool_call_id, content}`（调研文档的 `{result, status}` 旧形态兼容保留）；源无错误标记 → status 默认 success（保真缺口：失败调用不可区分，如实记录）。arguments JSON 字符串解析为 args，解析失败保留原串。
- **model**：Manifest.model 取 summary.current_model_id；后续 assistant model_id 不同则发 model_change（不篡改 manifest 主模型）。
- **stats**：turnCount 取 events turn_started 数（回退 signals.turnCount）；durationMs = signals.sessionDurationSeconds×1000。signals 其余指标（contextTokensUsed、延迟、行数统计）无 AHS 归处，丢弃。
- **无关系边**：subagent 无独立存储、rewind 无分叉链接 → 不产生 lineage/invocation，每 session 即自身 lineage 组 HEAD。
- **harnessVersion**：`<base>/../version.json`，缺失时 "unknown"。cwd 取 summary.info.cwd，缺失回退 URL 解码项目目录名。

## 契约摩擦（如实报告，未绕过）

- **调研文档与真实数据漂移**：文档中 tool_result 形态为 `{tool_call_id, result, status}`，真实数据（0.2.106）为 `{tool_call_id, content}` 且无 status。适配器以真实形态为准并兼容旧形态；建议后续修订 docs/research/schemas/grok-schema.md。
- **Usage 语义缺口**：signals.json 的 token 指标是上下文窗口占用而非请求用量，AHS Usage（input/output/cache 求和口径）无法诚实承接。属于"源端没有保留判据所需信息"，非模型缺陷，未打补丁。
- **chat_history 无逐 record 时间戳**：以 turn 粒度恢复（events 前缀计数），属源端可得的最细粒度；turn 内 record 共享 turn 开始时间。

## 验证

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：21 文件 248 测试全绿；整体覆盖 97.85%，grok 适配器 94.75%（≥80% 门槛）
- `npm run test:e2e`：6 条适配器链（含 grok）全通过
- 真实数据 sweep：见上节，0 错误

## 提交

- 代码：`659792d feat(adapter): grok formal adapter`（src/adapters/grok/、src/adapters/index.ts 导出、test/grok-*.test.ts、test/fixtures/grok/、test/e2e/adapter-chains.ts 增加 grok 链）
- 文档：本 report + 容器 README 状态翻转（同分支单独提交）
