---
title: Report 01 Codex 正式适配器
description: Codex 适配器按 active 契约正式化完成；22 测试全绿（全套 73），覆盖率 99.0%/88.3%，真实 sweep 233 session 零不变量错误，usage 对账 100%，全部目标 AC PASS。
type: report
status: complete
created: 2026-07-22T11:05:00Z
---

# 01-report: Codex 适配器

---

## 执行摘要

成功。按 Plan 以 TDD 正式化 Codex 适配器：先写失败测试（import 即红的 red 步），再参考 spike 底稿（`spike/0001-adapter-prototypes:src/adapters/codex/index.ts`）重写实现——spike 未合并、未 cherry-pick。fixture 全部手工合成（`test/fixtures/codex/sessions/`，4 个 rollout 文件 + 审查过的 golden），无任何真实用户数据入库。无新运行时依赖；未触碰 active 契约与 `src/index.ts`。

相对 spike 底稿的三处实质改进：

1. **spawned_by toolCallId 锚点补全**：spike 留为 follow-up。正式版经跨文件关联实现——父文件 `event_msg/sub_agent_activity`（kind "started"）的 `event_id` = 父 session `spawn_agent` function_call 的 `call_id`、`agent_thread_id` = 子线程 id（真实数据验证）。AC-0002-N-2 的锚点断言因此完整可查。
2. **forked_from 落地**：spike 未实现。真实数据验证：多 session_meta 文件按"自身在前、祖先按近到远跟随"排列，且祖先内容**不重放**——取最近祖先（第二条 session_meta）为 forked_from 父；sub-agent 文件也有 lineage 头，但 spawned_by 优先。
3. **时间戳兜底链 + 文件名解析修正**：spike 的 `sessionIdFromFilename` 正则（`^.{8}T.{6}-`）对真实文件名不匹配（T 在索引 10 而非 8），因 session_meta 总是获胜而为潜伏 bug；正式版改为 `\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-` 精确解析。record 时间戳兜底链：行时间戳 → 前行 → 文件名创建时间，均为源端值，不编造。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| e922528 | feat(adapter): codex formal adapter（实现 + 合成 fixture + golden + 22 测试） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 适配器 | src/adapters/codex/index.ts | CodexAdapter（harness "codex"，history "full"，control false，base path 可注入默认 ~/.codex/sessions）；导出 projectRecords / RawLine 供单测 |
| 测试 | test/codex-adapter.test.ts | 22 个测试，四层 AC 全覆盖 |
| 合成 fixture | test/fixtures/codex/sessions/2026/07/{20,21,22}/rollout-*.jsonl | a1 全特性主 session（三重冗余、encrypted reasoning、web_search_call、model_change、custom_tool_call、spawn_agent + sub_agent_activity、compaction 对、goal 判定、未变总量 token_count）；b2 thread_spawn 子 session（含 lineage 头）；c3 续接 session（forked_from、turn_aborted、无 usage、截断尾行）；d4 空 session（跳过） |
| 期望输出 | test/fixtures/codex/golden/sessions.json | stableSerialize(collectSessions) 全量 golden，已逐条人工审查（18+4+4 条 record，usage 附着位置、关系、去重均符合预期） |

---

## 测试摘要

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：**73 tests 全绿**（6 个测试文件，其中 codex-adapter 22 个）；覆盖率 **99.03% stmts / 88.28% branch / 100% funcs / 99.03% lines**（阈值 ≥80%）；适配器文件本身 97.83% stmts / 82.62% branch
- `npm run test:e2e`（smoke）：通过
- `node scripts/check-report.ts`：通过

---

## 验收结果

| AC | 结果 | 证据 |
|----|------|------|
| AC-0001-N-1（zod 合法） | PASS | "AC-0001-N-1" 测试：全部 manifest/record 过 ManifestSchema/AhsRecordSchema；真实 sweep 233 session / 206,851 record 0 ZodError |
| AC-0001-E-1（无法映射字段仍过 schema） | PASS | "AC-0001-E-1" 测试：源含 encrypted_content / base_instructions / replacement_history / web_search_call / rate_limits / sandbox_policy，投影序列化中逐一断言无踪迹，输出仍全过 schema |
| AC-0002-N-1（因果：单根/父可解析/seq 单调） | PASS | validateSessions 对 fixture 与真实 sweep（233 session）均 0 错误 |
| AC-0002-N-2（关系完整） | PASS | b2 spawned_by a1 且 toolCallId=call_spwn3 锚定父 session 真实 spawn_agent tool_call；真实 sweep：3 spawned_by 全部带锚点、5 forked_from，父 session 全部可解析，0 relation 错误 |
| AC-0002-N-3（内容无静默丢失） | PASS | "AC-0002-N-3" 测试：user/assistant 消息条数与源 response_item 一致（3/3），文本逐字断言 |
| AC-0002-N-4（usage 无静默丢失） | PASS | fixture：record 级求和 == 源 final total_token_usage（2000/180/400/90）；真实 sweep 对账 201/201 精确一致（见下） |
| AC-0002-N-5（幂等） | PASS | checkIdempotency 两跑字节一致 |
| AC-0002-N-6（tool 配对 XOR） | PASS | fixture 全配对或 interrupted；真实 sweep 0 tool-result-match 错误 |
| AC-0002-B-1（中断无合成 result） | PASS | c3 turn_aborted：call_ccc4 标 interrupted、无 tool_result；turn_aborted → turn_boundary end |
| AC-0002-B-2（源缺 usage 不编造） | PASS | c3 无 token_count：record 无 usage、stats.totalUsage 缺省；真实 sweep 32 个无 token_count 的 session 同形态 |
| AC-0003-N-1（golden diff） | PASS | "AC-0003-N-1" 测试：stableSerialize 与入库 golden 逐字节一致 |
| AC-0004-N-1（可用：archive + ahs-report） | PASS | "AC-0004-N-1" 测试：exportSessions → renderReport 只读归档，子 session 缩进渲染于 `→ spawn_agent(` 锚点之后；聚合 usage = a1+b2 精确（input 2500 / output 260 / cacheRead 500 / reasoning 110），forked_from 的 c3 不计入 |

元标准：实现过程**未被迫新增字段 / record 类型 / 逃生舱**。thread_spawn、forked_from lineage、developer 角色、turn_aborted、thread_goal_updated 均落入现有契约（spawned_by + 可选 toolCallId、forked_from、harness_message、turn_boundary end、goal_update）。

---

## 真实数据 Sweep（只读 ~/.codex/sessions，临时脚本，用后已删）

| 指标 | 数值 |
|------|------|
| rollout 文件 | 233（sweep 期间 232 → 233，有 live session 在写入） |
| 投影 session | 233（无空文件被跳过） |
| 投影 record | 206,851 |
| 层1 ZodError | 0 |
| 层2 不变量错误 | 0（含跨 session 关系断言） |
| 关系分布 | none 225 / forked_from 5 / spawned_by 3（锚点 3/3） |
| 无 token_count 的 session（B-2 形态） | 32 |

**Usage 对账**（投影 record 级求和 vs 源端 final total_token_usage）：199 session 首轮一致；2 个"不一致"（019f887a…、019f896f…）经查证为 sweep 脚本两次读取之间 live 文件继续增长的假象——单快照重算后两者均**精确一致**（去重和 == final total）。有效对账 **201/201 = 100%**。

对账过程中的机理发现：源端会发射 total 不变但 last_token_usage 非零的 token_count（一个文件中 5 次，恰与 3 次 compacted 相邻）——这些是 compaction 边界处的重报事件，"总量未变即跳过"的去重策略正确处理（跳过后求和仍精确等于 final total）。

**与研究文档的出入 / 新观察**（均已在 schema-comparison.md 2026-07-21 勘误段的延伸线上）：

- `response_item/agent_message`（78 条，研究文档未列）：agent 间控制面信封（author/recipient 代理路径 + NEW_TASK 路由头），正文在 encrypted_content 中。按过程机制 + 加密内容丢弃；任务正文在子 session 首条 user message 中另有规范副本，无评审相关内容损失。
- 新 top-level 类型 `world_state`（66 条，环境快照）与 `inter_agent_communication_metadata`（78 条）：过程/机制类，丢弃。
- `event_msg/web_search_end`（287 条）：server_tool_use 同类，丢弃。
- 旧版本 session（32 个）完全无 token_count → B-2 形态，usage 缺省不编造。

---

## 遗留与后续

- AC-0004 的手工渲染冒烟由测试内 renderReport 覆盖；CLI 形态（`vite-node examples/ahs-report.ts <archive> <sessionId>`）未单独手工跑——测试已走同一入口函数，证据等效。
- spawned_by 锚点依赖父文件同目录可扫到；父文件被清理时锚点省略（可选字段，契约允许），本次 sweep 未发生。
