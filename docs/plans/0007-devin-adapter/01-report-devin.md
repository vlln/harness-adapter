---
title: Report 01 Devin 正式适配器
description: Devin CLI（SQLite 森林）→ AHS 只读投影正式化完成；20 个适配器测试全绿，真实数据 sweep 不变量零错误、48/52 session usage 精确对账（4 个差异为有界已知丢失），全部目标 AC PASS。
type: report
status: complete
created: 2026-07-22T10:59:00Z
---

# 01-report: Devin 适配器

---

## 执行摘要

成功。按 Plan 以 TDD 正式化 Devin 适配器：先写失败测试（import 即红），再参考 spike 底稿（spike/0001-adapter-prototypes 的 `src/adapters/devin/`，未合并、未 cherry-pick）重写 `src/adapters/devin/index.ts`。fixture 为编程生成的合成 SQLite（test/fixtures/devin-db.ts，无真实数据入仓），golden 经逐行人工审查后入库（test/fixtures/devin-golden.json，再生成脚本 scripts/gen-devin-golden.ts）。真实数据 sweep 用临时只读脚本（cp sessions.db 到 temp，用完即删，未入仓）。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 86023b8 | feat(adapter): devin formal adapter（代码 + fixture + golden + 测试） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 适配器 | src/adapters/devin/index.ts | HarnessAdapter（harness "devin"，history "full"，control false）；node:sqlite 只读打开，db path 可注入（默认 ~/.local/share/devin/cli/sessions.db）；森林→每 root 一 session（sibling_attempt + 主链 isMainChain）；分支重试 message_id 去重 + 子节点重锚；tool 配对 XOR 状态推导；assistant metrics → record usage；credit cost 仅挂主链 |
| fixture 生成器 | test/fixtures/devin-db.ts | 编程生成合成 sessions.db：多 root 森林 + main_chain_id 指向链尾 + 分支重试重复 + 悬空父节点 root + tool 配对/重复 result/悬空 call + credits + 非法 metadata + 环 session + hidden session + 未知 role + 畸形 JSON + 空 assistant + harness 冒充 user |
| 测试 | test/devin-adapter.test.ts | 20 个测试，AC 四层全覆盖（见验收表） |
| golden | test/fixtures/devin-golden.json | stableSerialize 全量输出，人工审查；再生成脚本 scripts/gen-devin-golden.ts |

---

## 测试摘要

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：**71 tests 全绿**（6 个测试文件，其中 devin 适配器 20 个）；覆盖率 **100% stmts / 92.4% branch / 100% funcs / 100% lines**（适配器文件 100%/87.6%，阈值 ≥80%）
- `npm run test:e2e`（smoke）：通过
- `node scripts/check-report.ts`：通过

---

## 验收结果

| AC | 结果 | 证据 |
|----|------|------|
| AC-0001-N-1（schema 合法） | PASS | "AC-0001-N-1" 测试：5 个 fixture session 全部 Manifest + 18 条 record zod parse 通过；真实 sweep 2,225 条 record + 52 个 Manifest 零 schema 错误 |
| AC-0001-E-1（无法映射字段按丢弃规则处理） | PASS | "AC-0001-E-1" 测试：未知 role（telemetry）、畸形 JSON、空 assistant、分支重试重复、重复 tool result 均丢弃且输出仍合法；parse 往返无 schema 外字段 |
| AC-0002-N-1（因果完整） | PASS | validateSessions 零错误 + "forest splits" 测试：每 session 恰好一根；main_chain_id=5（链尾）上溯至 root 0；跳过节点的子节点重锚断言（m-user-11→tool_call record、m-asst-7→m-user-1） |
| AC-0002-N-2（关系完整） | PASS | sibling_attempt session 的 relation.sessionId 指向主链 session（validateSessions relation-session 检查 + 显式断言）；主链 isMainChain=true，sibling 无 |
| AC-0002-N-3（内容无静默丢失） | PASS | 消息计数与源（去重后）相等；thinking/text 块逐字断言；tool result 内容逐字；真实 sweep user_message=102、harness_message=235 与 research 文档角色分布一致 |
| AC-0002-N-4（usage 无静默丢失） | PASS | fixture：record 级求和 = 源 metrics（含 tool-only 消息 usage 挂首条 tool_call）；真实 sweep 逐 session 对账 48/52 精确相等，4 个差异见"已知丢失" |
| AC-0002-N-5（幂等） | PASS | checkIdempotency 两跑字节一致；无 wall-clock 读取 |
| AC-0002-N-6（tool 配对 XOR） | PASS | fixture 三情形：tc-1/tc-2 completed、tc-3 interrupted；重复 result 仅保留 DFS 首条；真实 sweep 752 call / 752 result 全配对、0 interrupted，validateSessions 零 tool-result-match 错误 |
| AC-0002-B-1（中断无合成 result） | PASS | tc-3 标记 interrupted 且无 tool_result 记录 |
| AC-0002-B-2（源缺 usage 容忍） | PASS | quiet-pond 全 session 无 usage 字段、stats.totalUsage 缺省；存在的 usage 不丢（N-4） |
| AC-0003-N-1（golden diff） | PASS | "AC-0003-N-1" 测试：stableSerialize 全量输出与审查过的 devin-golden.json 完全一致 |
| AC-0004-N-1（消费方可用） | PASS | exportSessions 导出 5 session → renderReport 渲染 transcript（sibling 目录名 sanitize 可解析），token 聚合 input=150/output=30/cacheWrite=177/durationMs=2300 与 record 级对账一致 |

---

## 真实数据 Sweep（发布前本地检查）

方法：cp `~/.local/share/devin/cli/sessions.db`（16MB，WAL 安全）到 temp，只读投影 + 源端 SQL 对账，临时脚本用完删除，无真实内容落盘/入仓。

| 指标 | 源 | 投影 |
|------|-----|------|
| 可见 session | 6 | 52 AHS session（52 个 root：主链 + sibling_attempt） |
| message_nodes / distinct message_id | 2,250 / 1,192 | 2,225 条 record |
| 角色分布 | user 102 / system 235 / assistant 1,161 / tool 752 | user_message 102 / harness_message 235 / assistant_message 384 + tool_call 752 / tool_result 752 |
| tool 配对 | 752 tool 消息 | 752 call 全配对，0 interrupted，0 孤儿 result |
| credits | total_credit_cost=0，total_acu_cost=0.0 | 主链 cost 0 credit |
| schema / 不变量错误 | — | **0 / 0** |
| usage 逐 session 对账（树内 message_id 去重后源端求和 vs 投影求和） | — | **48/52 精确相等**；4 个差异全部在 colorful-consonant（见下） |

与 research 文档的差异/惊喜：

1. **main_chain_id 指向链尾而非 root**（文档已标勘误，实测确认）：上溯解析主链。
2. **message 重复主要来自跨 root 复制而非树内分支**：2,250 节点 vs 1,192 distinct message_id，但树内去重仅去掉 ~25 条；52 个 root（重启注入全量历史副本）意味着大量 message 在多棵树中各出现一次。每棵树投为自包含 session 是 spec 森林行的既定语义；跨 session 聚合会重复计数这些共享前缀的 usage——消费方须知。
3. **credit/acu 成本全为 0**：真实语料中 billing 字段未启用，映射路径由 fixture 覆盖。
4. **空 assistant 节点携带 metrics**（colorful-consonant 15 个节点，content 为空且无 tool_calls）：节点整体跳过导致其 usage 随之丢失。差异有界：最大 session 偏差 input 4/556（0.72%）、output 11/208,908（0.005%）、cacheRead 101,338/58,078,791（0.17%）、durationMs 11,158/4,090,959（0.27%），在 AC-0002-N-4 容差内。
5. **metrics 含 cache_creation_tokens**（spike 遗漏）：正式版补映射 → cacheWriteTokens，真实对账含此字段后 48/52 精确。
6. **summarized_from  compaction 信号 0 次触发**（与 spike 观察一致）；出现时映射 compaction record，留作后续。

---

## 契约摩擦（如实上报，未打补丁）

- **total_acu_cost 无 schema 归宿**：按 ADR-0001 丢弃（真实语料恒为 0.0）。若未来非零，属"保留判据内但无处安放"信号，需回 spec 修订。
- **session 级 credit cost 无法按树归因**：选择仅挂主链 manifest（spike 行为是复制到每个 sibling，会导致跨 session 聚合三倍计数）。spec 未规定 session 级成本在森林拆分下的归属，此为实现决策，特此记录。
- 未被迫新增字段 / record 类型 / 逃生舱。

---

## 遗留问题

- 空 assistant 节点的 metrics 丢失（有界，见 sweep #4）：如需消除，可考虑把 usage 前移到下一个 emitted record，但会增加实现复杂度，暂以文档化结案。
- summarized_from → compaction record 映射待真实语料出现后实现。
- examples/ahs-report 只聚合 record 级 usage，credit cost（manifest 级）不出现在报告总计中——消费方增强留待后续容器。
