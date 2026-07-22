---
title: Report 01 Kimi Code 正式适配器
description: Kimi Code 适配器正式化完成；72 测试全绿（本容器 21），覆盖率 96.2%/86.5%；698 个真实 session 目录 sweep 零不变量错误，usage 对账逐项精确相等。
type: report
status: complete
created: 2026-07-22T10:55:00Z
---

# 01-report: Kimi Code 适配器

---

## 执行摘要

成功。按 Plan 以 TDD 正式化：先写合成 fixture + 失败测试（import 即红的 red 步），再参考 spike 底稿（`spike/0001-adapter-prototypes:src/adapters/kimi-code/`，未合并、未 cherry-pick）重写 `src/adapters/kimi-code/`。fixture 全部手工合成（无任何真实用户数据入库）。真实数据 sweep 在 `~/.kimi-code/sessions` 的快照副本上只读执行，临时脚本与快照用后即删。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 7a64417 | feat(adapter): kimi-code formal adapter（代码 + fixture + 层1-4 测试 + golden） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 适配器 | src/adapters/kimi-code/index.ts | KimiCodeAdapter（harness "kimi-code"，history "full"，control false，base path 可注入默认 `~/.kimi-code/sessions`）；多 wire → 多 session；`projectRecords` 纯投影函数单独导出 |
| 合成 fixture | test/fixtures/kimi-code/ | 1 个 session 目录（main + agent-0 两条 wire + plans + goal + compaction + interrupted tool call）+ golden.json（经人工逐行审查的期望输出） |
| 层1/2 测试 | test/kimi-code-adapter.test.ts | 19 个测试：zod 合法、不可映射事件丢弃、全部不变量、幂等、映射行为、错误语义 |
| 层3 测试 | test/kimi-code-golden.test.ts | golden diff（stableSerialize 逐字节比对） |
| 层4 测试 | test/kimi-code-report.test.ts | exportSessions → 纯归档 renderReport：无锚点子 session 渲染 + 跨 session usage 聚合 |

## 关键映射决策（与容器 README 一致）

- 每条 `agents/<name>/wire.jsonl` = 一个 AHS session；main 的 sessionId 为裸 uuid，子 agent 为 `<uuid>/<name>`；子 session `spawned_by` 父 session，**无 toolCallId**（源只有 agent 级 `parentAgentId`，AC-0002-B-3）
- `turn.prompt`/`turn.steer` 不发射（与紧随的 `append_message` 逐字重复，spike 已在真实数据 1814/1814 验证），但仍计入 `stats.turnCount`
- `origin.kind`：user → `user_message`；injection/system_trigger/background_task/skill_activation → `harness_message`（子 agent 任务提示词是 system_trigger，故落 harness_message）
- assistant 输出只存在于 `content.part` 流：连续 part 聚合为单条 `assistant_message`（think → thinking block）
- `goal.create` → `goal_update` pending（带 goalId/objective）；`goal.update` 带 status → 判定（complete→met / blocked→unmet / paused→pending，无 goalId 靠 seq 关联）；`{turnsUsed}/{tokensUsed}` 遥测与 `goal.clear` 丢弃
- `usage.record`：turn 级附着前一条 record（无前置 record 时缓冲到下一条，不丢）；session 级为累计口径，丢弃防重复
- `context.apply_compaction` → 单条 `compaction`（带 summary）；`full_compaction.begin/complete` 为过程标记丢弃
- `plans/*.md` 文件侧投影：按文件名排序追加为末尾 `assistant_message`，时间戳取流末 record（流内位置不可还原）
- tool_call 状态配对后派生：paired → completed/failed，悬空 → interrupted（不合成假 result）；同 toolCallId 多 result 取文件序第一条
- cwd 源端不可得（`wd_<id>` 是 hash）→ `""`；harnessVersion 源端无 CLI 版本 → `"unknown"`；均不编造

---

## 测试摘要

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：**72 tests 全绿**（8 个测试文件，其中本容器 21 个 / 3 个文件）；覆盖率 **96.2% stmts / 86.5% branch / 100% funcs / 96.2% lines**（阈值 ≥80%）
- 适配器文件单文件覆盖率 91.7% stmts / 77.3% branch（未覆盖分支为深度防御性 fallback，如 state.json 与 agents 目录均缺失）

---

## 验收结果

| AC | 结果 | 证据 |
|----|------|------|
| AC-0001-N-1（层1 zod 合法） | PASS | "layer 1" 测试遍历全部 fixture session 的 Manifest + record 逐一 parse；sweep 868 session / 76913 record **0 ZodError** |
| AC-0001-E-1（不可映射字段按规则丢弃） | PASS | "layer 1 (AC-0001-E-1)" 测试：fixture 含 permission.\*/llm.request/tools.\*/plan_mode.\*/full_compaction.\*/goal 遥测/session 级 usage，输出仍全部过 schema 且无 schema 外字段；sweep 中 26 种顶层事件类型（调研文档仅列 13 种）全部按丢弃规则处理 |
| AC-0002-N-1（因果完整） | PASS | "synthesizes a deterministic linear chain" 测试（recordId/parentId/seq/时间戳逐条断言）+ validateSessions 零错误（fixture 与 sweep 双边） |
| AC-0002-N-2（关系完整） | PASS | "multi-wire = multi-session" 测试：子 session 恰好一个、spawned_by 指向存在的父 session；sweep 195 个子 session 全部通过 relation 不变量 |
| AC-0002-N-3（内容无静默丢失） | PASS | dedup 测试：user_message 恰好 1 条且逐字；sweep：AHS user_message **1632 == 源端 user-origin append_message 1632** |
| AC-0002-N-4（usage 无静默丢失） | PASS | manifest stats 测试（1200/90/150/5）；sweep 快照对账：record 级 usage 求和与源端 turn 级总量**逐项精确相等**（input 89,872,382 / output 9,192,644 / cacheRead 1,958,650,509 / cacheWrite 0，diff 全 0）；5 条 session 级累计 usage 已丢弃未重复计 |
| AC-0002-N-5（幂等） | PASS | checkIdempotency 测试（两跑 stableSerialize 字节一致）；实现无 wall-clock 读取，目录枚举全排序 |
| AC-0002-N-6（tool 配对 XOR） | PASS | "derives status completed XOR interrupted" 测试；sweep：26944 tool_call = 26908 paired + 36 interrupted，零 pairing 错误；1 例同 toolCallId 重复 result 按文件序第一条去重 |
| AC-0002-B-1（中断标记） | PASS | fixture 末尾悬空 call_k003 → `status: "interrupted"` 且无合成 result；sweep 36 例同形态 |
| AC-0002-B-2（usage 缺省容忍） | PASS | "a wire without usage.record" 测试：无 usage 的 wire 输出无 usage 字段、stats.totalUsage 缺省，不编造 |
| AC-0002-B-3（无 toolCallId 的 spawned_by） | PASS | 子 session relation 断言 `{type:"spawned_by", sessionId}` 且无 toolCallId 属性；sweep 195 例同形态 |
| AC-0003-N-1（golden diff） | PASS | test/kimi-code-golden.test.ts：collectSessions 输出与 test/fixtures/kimi-code/golden.json 逐字节一致；golden 由适配器输出生成后人工逐行审查（映射规则逐条核对） |
| AC-0004-N-1（可用：渲染 + 聚合） | PASS | test/kimi-code-report.test.ts：exportSessions 后**只读归档**渲染——无锚点子 session 缩进渲染于父 session 记录之后；聚合 usage 1400/110/150/5 与两 session record 级求和精确一致；transcript 含 user/thinking/tool/interrupted/goal/compaction/plan 全部要素 |

---

## 真实数据 sweep（证据）

方法：`cp -R ~/.kimi-code/sessions` 到 /tmp 快照（254 MB）后只读跑临时脚本（源端独立记账 vs 适配器输出对账），脚本与快照用后已删，无任何真实数据入库。

| 指标 | 数值 |
|------|------|
| 源 session 目录 / wire 文件 | 698 / 893 |
| AHS session（main + sub） | 868 = 673 + 195（25 条空 wire 无可投影内容，跳过） |
| AHS record 总数 | 76,913 |
| zod 校验错误 / 不变量错误 | **0 / 0** |
| usage 对账（源 turn 级总量 − AHS record 求和） | **diff 全 0** |
| tool_call 配对 | 26,944 call = 26,908 result + 36 interrupted |
| 记录类型分布 | assistant 18,813 / tool_call 26,944 / tool_result 26,908 / harness_message 2,505 / user_message 1,632 / goal_update 89 / model_change 17 / compaction 5 |

说明：首次直接对活目录 sweep 时 AHS 侧 usage 高出约 0.02%（+15,290 input 等）——原因是本机存在**正在写入的活动会话**，源端记账与适配器读取之间的秒级窗口内 wire 追加新行所致；改用快照后两侧逐项精确相等，确认非适配器缺陷。

### 与调研文档的差异（惊喜点）

- `agents.<id>.type` 实测为 `"main"` / `"sub"`（698/195），印证 ADR-0002 验证段勘误（非 "subagent"）
- 调研文档列 13 种顶层事件，实测 **26 种**；多出 goal.create/update/clear、turn.steer、turn.cancel、swarm_mode.enter/exit、full_compaction.begin/complete、context.apply_compaction、context.undo、forked、llm.request、llm.tools_snapshot、tools.update_store——均按既定映射/丢弃规则处理
- `origin.kind` 实测 5 种，**injection 最多（2,016）** 多于 user（1,632）；全部非 user 来源落 harness_message
- goal 判定状态实测 complete 40 / blocked 3 / paused 1，与映射表（met/unmet/pending）吻合
- 1 例同 toolCallId 重复 tool.result（first-wins 去重生效）；2 例 context.undo（已撤销消息仍留在投影中，已知保真缺口，spike 已记录）；3 例 forked 事件无源 session id，forked_from 不可填充而丢弃（源端不可得，非契约缺口）

---

## 契约摩擦

无。未被迫新增字段 / record 类型 / 逃生舱；frozen 契约足以表达全部映射（含 AC-0002-B-3 的无锚点 spawned_by 与 goal_update 判定语义）。forked 事件无法填充 forked_from 属源端信息缺失，ADR-0002 已 flag。

## 遗留问题

- context.undo（2 例）：已撤销消息仍留在投影中，属有原则的保真缺口（源端 undo 语义 ≠ AHS 删除语义），如后续 harness 版本增多该事件再评估。
- `src/index.ts` 导出接线由另一任务统一处理（本容器按要求未触碰）。
