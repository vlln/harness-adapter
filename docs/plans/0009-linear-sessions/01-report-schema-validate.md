---
title: Report 01 schema + validate 重构
description: record 删 parentId；relation → lineage/invocation 两槽；Manifest 删 isMainChain；tool_result +sessionId；validate 按 AC v2 重写（N-1/N-2/N-6/N-7）。155 测试全绿，行覆盖 97.91%。
type: report
status: complete
created: 2026-07-23T11:26:00Z
---

# 01-report: schema + validate 重构

---

## 执行摘要

成功。按 ADR-0005 把 schema 从 tree 模型切到线性 session + 两维关系模型，validate 层二不变量按 AC v2 全部重写；4 个适配器做最小适配（正式重构属 Plan 02），ahs writer/reader 与 examples/ahs-report 做最小适配（正式重构属 Plan 03）。全部 golden 重新生成。`npx tsc --noEmit` 零错误；`npx vitest run --coverage` 13 文件 / 155 测试全过；`npm run test:e2e` 4/4 适配器链路通过。PR #20 过 CI 门禁后 merge 入 develop。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| df0ee4c | refactor(schema)!: linear sessions — drop parentId, lineage/invocation, tool_result.sessionId（refactor/0009a-schema-validate） |
| 689039b | Merge pull request #20（CI 绿后 merge commit 入 develop，分支已删） |

---

## Schema 变更（破坏性，ADR-0005 授权，pre-1.0）

| 文件 | 变更 |
|------|------|
| src/schema/record.ts | BaseRecord 删 `parentId`（`seq` 为唯一结构字段，首条即根）；`tool_result` 增可选 `sessionId`（invocation 正链） |
| src/schema/relation.ts | 重写为两个 schema：`LineageSchema { type: "forked_from" \| "sibling_attempt", sessionId, atRecordId? }` 与 `InvocationSchema { sessionId, atRecordId? }`；`RelationSchema`（spawned_by/forked_from/sibling_attempt 单槽）删除 |
| src/schema/manifest.ts | 删 `relation` 与 `isMainChain`；增可选 `lineage?: Lineage` 与 `invocation?: Invocation` |

---

## Validate API（src/validate/index.ts）

关系检查为跨 session 性质，接口保持面向全集：

- `SessionData { manifest, records }`、`validateSessions(sessions: SessionData[]): InvariantError[]`——每次调用接收完整 session 集（per-session 检查 N-1/N-6 + 跨 session 检查 N-2/N-7）。
- `collectSessions(adapter)` 收集适配器全量输出（manifests + records），供适配器测试一行接入。
- 幂等辅助不变：`stableSerialize`、`checkIdempotency`（AC-0002-N-5）。
- `InvariantError.code` 新集合：`seq-order`、`invocation-session`、`invocation-anchor`、`invocation-mismatch`、`lineage-session`、`lineage-anchor`、`lineage-type`、`tool-result-match`、`not-idempotent`（旧 `single-root`/`parent-resolution`/`relation-*` 随 tree 模型退役）。

---

## 逐 AC PASS 证据

### AC-0002-N-1（线性：无结构字段、seq 严格递增且连续）

- schema 层：`parentId` 已从 BaseRecord 删除，record 上不存在任何 parentId/branch 类结构字段（AR-001 由 zod 结构保证，层 1 测试对全部 fixture 输出逐条 parse 通过）。
- validate 层：`checkLinear` 断言文件序 seq 步长恰为 1（严格递增且连续）；不再有 parent 解析/单根检查（首条即根）。
- 测试证据（test/validate.test.ts）：正向线性 session 通过；seq 倒退（0→0）报 `seq-order`；seq 跳号（0→2，不连续）报 `seq-order`。4 个适配器测试各自断言 seq 从 0 连续（如 claude-code `seq == [0..10]`、kimi-code 逐条 `rec.seq === i`），且全部跑 `validateSessions(collectSessions(adapter))` 零错误。

### AC-0002-N-2（invocation 正回链对账）+ B-3

- validate 层 `checkInvocations`（跨 session）：(a) `invocation.sessionId` 必须在 session 集中存在，否则 `invocation-session`；(b) `atRecordId` 存在时须解析到父 session 中的 tool_call record，否则 `invocation-anchor`（解析不到或类型不是 tool_call 均报）；(c) 父中与该 tool_call 配对的 tool_result 必须携带 `sessionId === 子 sessionId`，否则 `invocation-mismatch`。B-3 形态（atRecordId 省略）：跳过锚点与对账检查，父存在性仍查。
- 测试证据（test/validate.test.ts）：正链回链完整对账通过；B-3 无锚通过；父不存在 / 锚点缺失 / 锚点非 tool_call / 正链缺失 / 正链指向错误子 session 五种负向各报对应 code。
- 适配器侧最小适配：kimi-code 子 wire → `invocation { sessionId }`（B-3，源端本就无锚）；claude-code/codex 子 session → `invocation { sessionId }`，atRecordId 锚点与父端正链写入标注 TODO(Plan 02)（见"已知差距"）。

### AC-0002-N-7（lineage 锚点解析 + 类型判据）

- validate 层 `checkLineages`（跨 session）：`lineage.sessionId` 必须存在，否则 `lineage-session`；`atRecordId`（非 null 时）必须解析到父中真实 record，否则 `lineage-anchor`；类型判据：锚点为 user_message ⇔ 必须 `sibling_attempt`，否则必须 `forked_from`，违例报 `lineage-type`。
- 测试证据（test/validate.test.ts）：forked_from 锚 assistant / sibling_attempt 锚 user_message / 从起点重试（无 atRecordId）三个正向通过；父不存在、锚点缺失、类型判据双向错误四个负向各报对应 code。
- 适配器侧：devin 非主 root → `lineage { type: "sibling_attempt", sessionId: <slug> }`（共享前缀锚点为 Plan 02 工作）；codex 文件祖先 → `lineage { type: "forked_from", sessionId }`。

### 其他覆盖

- AC-0002-N-6（tool XOR 配对）：语义不变，6 个用例（配对通过 / interrupted 通过 / 无结果未标 interrupted / interrupted 却有结果 / 多 result / 孤儿 result）全绿。
- AC-0002-N-5（幂等）：`checkIdempotency` 与归档层字节一致（re-export byte-identity）测试全绿；4 适配器幂等测试全绿。
- AC-0003-N-1（golden）：4 套 golden 按新 schema 重新生成（临时脚本用后已删），diff 仅含 parentId/relation/isMainChain 移除与 key 序变化。
- AC-0004-N-1（消费方）：ahs-report 的 spawned_by walk 改为 invocation walk（锚点按 atRecordId → tool_call recordId 匹配），archive round-trip 后不变量仍零错误；e2e 4/4 链路（适配器→归档→report CLI）通过。

---

## 测试与覆盖率

| 指标 | 值 |
|------|-----|
| vitest | 13 文件 / 155 测试全过 |
| 行/语句覆盖 | 97.91%（≥80% 门禁） |
| 分支覆盖 | 86.86% |
| 函数覆盖 | 100% |
| `npx tsc --noEmit` | 零错误 |
| `npm run test:e2e` | 4/4 适配器链路通过 |
| `node scripts/check-report.ts` | 通过 |

---

## 已知差距（有意遗留，后续 Plan 收敛）

- 适配器只做了编译/测试层面的最小适配：claude-code/codex 的 invocation 缺 atRecordId 锚点与父端 tool_result.sessionId 正链（N-2 完全对账待 Plan 02）；devin 的 sibling lineage 缺共享前缀 atRecordId 锚点（N-7 锚点检查待 Plan 02）；Claude 源内分叉尚未拆 fork session（Plan 02）；mainness 组 HEAD 指针（B-4）为 Plan 03 派生层工作。
- ahs-report 的 lineage 前缀拼接（fork 只存后缀的渲染）为 Plan 03 正式重构范围，当前 invocation walk 行为与旧 spawned_by walk 等价。

---

## 失败原因分类

无失败。一处实现决策记录：AC v2 N-1 文本"seq 严格递增且连续"按字面实现为步长恰 1（连续=无跳号），比旧 tree 模型的单调检查更强，4 个适配器的现有发射序天然满足（seq = 发射下标）。
