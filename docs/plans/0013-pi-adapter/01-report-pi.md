---
title: 0013-pi-adapter Report 01 — Pi 适配器
description: Pi Agent（单文件 JSONL + parentId tree，protocol v3）形式化适配器实现报告：AC 覆盖、映射决策、真实数据 sweep、验证结果。
type: report
status: complete
created: 2026-07-23T19:30:00Z
---

# 0013-pi-adapter / 01: Pi 适配器 Report

对应 Plan：README 状态表 01-plan-pi.md。分支：`feat/0013-pi-adapter`。依据：spec v2、interface/0001、ac v2（均 active）。模板：`src/adapters/claude-code/`（tree 源，最简）。调研：docs/research/schemas/pi-agent-schema.md。

## AC 覆盖

| AC | 结果 | 验证位置 |
|----|------|---------|
| AC-0001-N-1（层1 合法） | PASS — 全部 manifest/record 过 zod parse（fixtures + 真实数据 sweep 均 0 错误） | test/pi-adapter.test.ts |
| AC-0001-E-1（不可映射字段丢弃） | PASS — api/responseId/stopReason/errorMessage/thinkingSignature/totalTokens/message 级 Unix-ms 时间戳均无残留，strict parse 通过 | test/pi-adapter.test.ts |
| AC-0002-N-1（线性 seq） | PASS — validateSessions 0 错误；seq 严格递增连续 | src/validate + test |
| AC-0002-N-2（invocation） | PASS（不适用）— 源端无 subagent 机制（调研确认；真实数据 181 文件未见子 session 结构），不产生 invocation；不变量在全会话集上成立 | src/validate |
| AC-0002-N-3（内容无静默丢失） | PASS — user/assistant 条数与源相等，文本/thinking 逐字保留；空内容 error 消息（stopReason:error，content:[]，全零 usage）不产出 record | test/pi-adapter.test.ts |
| AC-0002-N-4（usage 无静默丢失） | PASS — record 级 usage 求和与源总量**精确相等**（真实数据 sweep：input 541269 / output 54033 / cacheRead 1080272 / cacheWrite 0 / reasoning 0 / cost 0，两侧一致） | test + sweep |
| AC-0002-N-5（幂等） | PASS — checkIdempotency 0 错误（投影为文件内容纯函数 + memo） | src/validate |
| AC-0002-N-6（tool 配对） | PASS — 每个 tool_call 恰有配对 result 或 interrupted；同 toolCallId 多 result 取文件序第一条 | src/validate + test |
| AC-0002-N-7（fork 血统） | PASS — 源内分叉（assistant 多 user 子节点 = edit-resend/retry）拆 fork session（只存后缀）；锚点类型判据正确（user_message ⇔ sibling_attempt）；真实数据 sweep 拆出 3 个 fork 且 0 不变量错误 | test/pi-adapter.test.ts + sweep |
| AC-0002-B-1（中断 call） | PASS — fixture D 悬空 call 标 interrupted，无合成 result | test/pi-adapter.test.ts |
| AC-0002-B-2（usage 缺省） | PASS — fixture D assistant 无 usage 字段 → record 无 usage、manifest 无 totalUsage；不丢弃也不伪造 | test/pi-adapter.test.ts |
| AC-0003-N-1（golden diff） | PASS — 6 个 session（4 主 + 2 fork）stableSerialize 逐字节一致；fixture 全合成手写（脱敏） | test/pi-golden.test.ts + test/fixtures/pi/ |
| AC-0004-N-1（可用） | PASS — exportSessions → ahs-report 渲染 transcript（model_change 状态行、tool 调用、fork 折叠、--all 备选版本）；token/cost 聚合精确（cost=0.0051 USD，唯一有 cost 的 harness，验证 cost 聚合路径） | test/pi-report.test.ts + test/e2e/adapter-chains.ts（pi 链） |
| 元标准 | PASS — 未新增字段/record 类型/逃生舱 | — |

## 真实数据 sweep（本机 ~/.pi/agent/sessions，只读）

快照后只读运行（临时脚本，已删除；快照已删除）：

- 181 个 session 文件 → **184 个 AHS session**（3 个 fork 来自 2 个含真实分叉的文件：一个 assistant 消息挂多个 user 子消息，即 edit-resend/retry）
- **1347 条 record，0 schema 错误，0 不变量错误**（validateSessions 全集）
- usage 对账：record 级求和与源精确相等（见 N-4）
- 本机数据全部来自本地 ollama 模型，cost 全为 0 —— 非零 cost 映射路径仅由合成 fixture + golden + AC-0004 覆盖
- `parentSession` 字段在 181 个文件中仅出现 1 次（见下"契约摩擦"）

## 映射决策

- **线性化**：pi 的并行 toolResult 经 parentId 串成链（每个 result 是下一个的父），树实践中近乎线性；多子节点即真实分叉（真实数据证实）。主线 = 最后叶子所在子树（append-only ⇒ 文件序即新旧序），其余子树拆 fork session，无需 claude-code 那样的 artifact 折叠规则。
- **`model_change` → model_change record**（modelId/provider 直译）。
- **`thinking_level_change` → model_change record**（容器映射规则）：携带当前（源生）model/provider，thinkingLevel 丢弃；首个 model_change 之前出现时丢弃（无当前模型，不编造）。
- **usage**：input/output/cacheRead/cacheWrite/reasoning 直译；`cost.total` → `cost { amount, currency: "USD" }`——源端无 currency 字段，pi 定价表以 USD 计，此为文档化假设；`totalTokens` 冗余（分项之和）丢弃。
- **双时间戳统一**：record 级 ISO 字符串为准；message 级 Unix-ms 丢弃。
- **toolResult**：`isError` → status（调研文档漏记此字段，真实数据确认存在）；多 text block 以 "\n" 连接。
- **error assistant 消息**（stopReason:error，空 content，全零 usage）：不产出 record（零 usage 不影响对账），errorMessage 无 AHS 归处按 ADR-0001 丢弃。
- **Manifest**：harnessVersion = 存储协议版本字符串（如 "3"，源端唯一版本）；model/provider 取首个 model_change；无 title/git/profile 机制 → 省略。
- **fork Manifest** 共享文件级 session 记录（cwd/version）与文件首个 model_change。

## 契约摩擦（报告，未绕行）

- **`session.parentSession`（跨文件 continue-from 指针）未映射**：调研文档未记录此字段（真实数据 181 文件中 1 例）。该子文件**重录共享前缀**（与父文件 4 条 record id 重叠）后续写，而 AHS lineage 模型要求 fork 只存后缀——若加 lineage 边，HEAD 链渲染与聚合会对共享前缀双计。故按独立自足 session 投影，parentSession 丢弃。若后续认为该关系属于保留判据，需要 spec 层决策（前缀去重拆分 or 新型跨文件边），不应在适配器内打补丁。
- **cost currency 源端缺失**：schema 要求 currency，源只给数值；按 USD 假设映射（上文），如 spec 层另有约定需修订。

## 验证结果

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：24 文件 275 测试全绿；全仓 statements 97.96% / branches 86.61% / functions 100% / lines 97.96%（≥80% 门槛）；`src/adapters/pi/` 98.88% 行覆盖
- `npm run test:e2e`：7 条适配器链全过（含新增 pi 链：fork 折叠 + --all 备选版本 + usage 独立复算一致）

## 提交

- 代码：`ac1e059` feat(adapter): pi formal adapter
- 文档：本 Report + 容器 README 状态翻转（同分支单独提交）
