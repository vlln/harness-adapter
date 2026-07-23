---
title: Report 02 codex 适配器线性化重构
description: codex 适配器按 ADR-0005 重构：invocation 两链（sub_agent_activity 对账锚点 + tool_result.sessionId 正链）、lineage 锚点 + 类型判据、includeForks 组 HEAD 折叠；真实 sweep 235 session / 209819 record / 0 不变量错误 / usage 精确对账。
type: report
status: complete
created: 2026-07-23T12:40:00Z
---

# 02-report-codex: codex 适配器线性化重构

---

## 执行摘要

成功。codex 适配器从 Plan 01 的最小映射升级为 ADR-0005 完整实现：thread_spawn 子代理 → invocation 两链（回链锚点经父文件 `sub_agent_activity` 对账：agent_thread_id → event_id = spawn_agent call_id → 父中 tool_call 的 recordId；正链写入父中配对 tool_result 的 `sessionId`）；rollout 文件祖先 lineage header → lineage，锚于父 session 末条 record，类型按锚点 record 角色判定（user_message ⇔ sibling_attempt）；`listSessions` 支持 `includeForks`（默认只出各 lineage 组 HEAD，codex 无 winner 标记，HEAD = 组内最近活跃 session）。`npx tsc --noEmit` 零错误；`npx vitest run --coverage` 13 文件 / 156 测试全过（行覆盖 97.88%，codex 适配器 97.59%）；`npm run test:e2e` 4/4 链路通过。真实数据 sweep（快照 235 个 rollout 文件）：0 不变量错误、usage 对账 203/203 精确（32 个 session 源端无 usage）、幂等字节一致。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 040aa08 | refactor(adapter)!: codex linear sessions + fork synthesis + invocation links（refactor/0009b-codex） |
| （docs commit 见 PR） | docs(plan): 0009-02 codex Report（本文件） |

---

## 实现要点（src/adapters/codex/index.ts）

- **invocation 两链（AC-0002-N-2）**：`projectRecords` 在投影父文件时收集 `sub_agent_activity`（event_id = spawn_agent call_id → agent_thread_id = 子线程 id，文件序首次出现为准），后处理把子 sessionId 写到配对 tool_result 上（正链）。`buildManifest` 经跨 session 上下文（ProjectionContext：全 session 的 sources + records）为子 session 解析回链锚点：父 spawnEvents 中 agent_thread_id == 自己 → call_id → 父 records 中该 tool_call 的 recordId。任一环节源端缺失（父文件不在库、无 sub_agent_activity、call 无配对）→ 省略 atRecordId，回链保留（B-3 形态，源端不可得，非丢弃）。
- **lineage（AC-0002-N-7）**：最近祖先 header（第二个 session_meta）→ lineage，atRecordId = 祖先 session 末条 record 的 recordId（子文件只存分叉后缀，spike 已验证祖先内容不重放）；类型按锚点 record 判定（user_message ⇔ sibling_attempt，否则 forked_from）。祖先文件不在库/无内容 → lineage 保留但不带锚点（见"契约摩擦"）。thread_spawn 子文件也有 lineage headers，invocation 优先、不产生 lineage。
- **includeForks（interface/0001）**：默认 false → 只出各 lineage 组 HEAD。组 = lineage 边 union-find（invocation 维度不参与折叠）；HEAD = 组内最近活跃 session（末条 record 时间戳最大，并列取 sessionId 较小者，确定性）。HEAD 选择在全集上做，cwd 过滤后置于折叠。
- **共享文件最小改动**（4 个适配器 PR 均需要，改动逐字节相同，可干净合并）：`src/store/adapter.ts` SessionFilter 补 `includeForks?`（active 契约 interface/0001 已含，代码补齐）；`src/validate/index.ts` collectSessions 改 `listSessions({ includeForks: true })`（跨 session 不变量需要全集）；`src/ahs/writer.ts` writeArchive 查全集、exportSessions 默认存储视图（归档要全量，调用方 filter 仍可收窄）。

---

## 逐 AC PASS 证据

### AC-0001-N-1（schema 合法）

- 测试 `AC-0001-N-1`：6 个 fixture session 全部 manifest/record 过 zod parse（test/codex-adapter.test.ts）。PASS。
- sweep：235 session / 209,819 record 全部经 validateSessions 检查，0 错误。PASS。

### AC-0001-E-1（无法映射字段按丢弃规则处理）

- 测试 `AC-0001-E-1`：encrypted reasoning、system prompt、rewritten context、web_search_call、rate_limits、sandbox_policy 均不出现在投影中，输出仍全 schema 合法。PASS。

### AC-0002-N-1（线性）

- 全部 fixture + sweep 经 `validateSessions` 的 checkLinear（seq 步长恰 1）+ checkToolPairing + 跨 session 检查：0 错误。PASS。

### AC-0002-N-2（invocation 两链对账）

- 测试 `AC-0002-N-2`：b2 回链 `{ sessionId: a1, atRecordId: <a1 中 call_spwn3 的 tool_call recordId> }`；锚点解析到名为 spawn_agent 的 tool_call；父中配对 tool_result 的 `sessionId === b2`（正链）。validateSessions 跨 session 对账 0 错误。PASS。
- sweep：invocation 3 个，锚点 3/3 解析成功；正链（tool_result.sessionId）42 条。PASS。

### AC-0002-N-3（内容无静默丢失）

- 测试 `AC-0002-N-3`：user/assistant 消息条数与源相等、文本逐字（含新 fixture）。PASS。

### AC-0002-N-4（usage 无静默丢失）

- 测试 `AC-0002-N-4`：a1 record 级 usage 求和 == 源 final total_token_usage（unchanged-total 重复事件已去重），且 == manifest.stats.totalUsage。PASS。
- sweep：203 个有源 usage 的 session 全部精确对账（input/cacheRead/output/reasoning 四字段逐一相等），32 个 session 源端无 token_count（B-2），0 个偏差。PASS。

### AC-0002-N-5（幂等）

- 测试 `checkIdempotency` 两次运行字节一致；sweep 同样两次 collect 字节一致（idempotent: true）。PASS。

### AC-0002-N-6（tool XOR 配对）

- 全部 fixture + sweep 经 checkToolPairing：0 错误；c3 的 turn_aborted 未配对 tool_call 标 `interrupted` 且不合成占位 result（B-1 测试）。PASS。

### AC-0002-N-7（lineage 锚点 + 类型判据）

- 测试 `AC-0002-N-7`：c3 forked_from 锚 a1 末条 record（turn_boundary）；f6 链式 fork 锚 c3 末条；e5 锚 g7 末条 user_message ⇔ sibling_attempt（类型判据双向覆盖）；b2 只带 invocation 不带 lineage。validateSessions 的 checkLineages（父存在 + 锚点解析 + 类型判据）0 错误。PASS。
- sweep：lineage 5 个（全部 forked_from，真实数据中未出现 sibling_attempt 形态），锚点 5/5 解析成功，0 个无锚。PASS。

### AC-0002-B-1 / B-2 / B-3

- B-1：c3 未配对 tool_call → `interrupted`，无合成 result。PASS。
- B-2：c3 源端无 usage → usage 字段缺省而非伪造（sweep 中 32 个同类 session 同样处理）。PASS。
- B-3：codex 正常有锚；锚点对账任一环节源端缺失时省略 atRecordId、回链保留（代码路径与文档注明，sweep 中未触发：3/3 有锚）。PASS。

### AC-0002-B-4（winner 易主指针稳定）

- codex 源端无 winner 标记：session id 与 mainness 天然解耦（id = 源线程 id，创建即定型），HEAD 是 listSessions 默认折叠时的派生选择，不改任何 session 内容；幂等测试 + sweep 字节一致佐证投影稳定。PASS（N/A 项：源端无可易主的 winner）。

### AC-0003-N-1（golden）

- golden 用临时脚本（scripts/gen-codex-golden.ts，用后已删）重新生成；测试 `AC-0003-N-1` golden diff 一致。fixture 全合成、无真实用户数据。PASS。

### AC-0004-N-1（消费方可用）

- 测试 `AC-0004-N-1`：exportSessions 归档全量 6 session；renderReport(a1) 沿 invocation 聚合 [a1, b2]（fork c3/f6 不计入），b2 渲染在 spawn_agent 调用之后缩进显示，usage 聚合 2500/260/500/110 精确。e2e 4/4 适配器链路（adapter → archive → report CLI）通过。PASS。

---

## 真实数据 Sweep（发布前本地检查）

- 基线：`~/.codex/sessions` 快照到 /tmp（235 个 rollout 文件，580MB；快照聚合 sha256 `f1f741e574275fcab89b5db687444753cbf7b7bb2ebdec629936ef89c603bed7`），sweep 全程只读快照，用后删除。临时脚本 scripts/sweep-codex.ts 用后已删。

| 指标 | 值 |
|------|-----|
| sessions（includeForks 全集） | 235 |
| records | 209,819 |
| 默认折叠后 HEAD sessions | 230（5 个 fork 被折叠，与 lineage 计数一致） |
| 不变量错误 | 0 |
| 幂等（两次 collect 字节一致） | true |
| usage 对账 | 精确 203 / 源端无 usage 32 / 偏差 0 |
| lineage | forked_from 5（锚点 5/5），sibling_attempt 0 |
| invocation | 3（锚点 3/3） |
| 正链 tool_result.sessionId | 42 |

观察（非违例）：正链 42 条多于在场子 session 3 个——39 条正链指向库中不存在（已删除/未落盘）的子线程文件。正链是源端 sub_agent_activity 的忠实投影（线程句柄），AC-0002-N-2 从子侧对账，父侧悬空正链不构成不变量违例。

---

## 测试与覆盖率

| 指标 | 值 |
|------|-----|
| vitest | 13 文件 / 156 测试全过（codex 适配器 23 个） |
| 行/语句覆盖 | 97.88%（codex 适配器 97.59%，≥80% 门禁） |
| 分支覆盖 | 86.68% |
| 函数覆盖 | 100% |
| `npx tsc --noEmit` | 零错误 |
| `npm run test:e2e` | 4/4 适配器链路通过 |
| `node scripts/check-report.ts` | 通过 |

---

## 契约摩擦（未绕过，上报）

1. **interface/0001 已 active 且含 `includeForks`，但 Plan 01 未同步代码**：本 PR 在 src/store/adapter.ts 补齐字段，并改 src/validate/index.ts（collectSessions 全集）与 src/ahs/writer.ts（归档存储视图）三处共享文件。4 个适配器 PR 需要逐字节相同的改动；后合者若冲突以本语义为准。
2. **lineage 无锚的语义缝隙**：spec 中 `atRecordId` 省略 = "从起点重试"，但"fork 父已知、锚点源端不可得（祖先文件缺失/无内容）"无表达——当前实现保留 lineage 省略锚点，语义上会被误读为从起点重试。真实 sweep 未触发（5/5 有锚），建议 spec 演进时区分两种情形（如允许锚点缺失的第三种语义或显式标记）。
3. 无其他摩擦：未被迫新增字段 / record 类型 / 逃生舱（元标准满足）。

---

## 失败原因分类

无失败。两处实现决策记录：

- HEAD 判据：codex 无 winner 标记，取"组内末条 record 时间戳最大者"，并列取 sessionId 较小者——纯数据派生、确定性，符合 interface/0001 "源端有胜者标记则直取，否则取组内最近活跃"。
- 锚点对账以父文件 `sub_agent_activity` 为唯一桥（agent_thread_id ↔ call_id）；kind 不限于 "started"（文件序首次出现为准），对真实数据中事件乱序更稳健。
