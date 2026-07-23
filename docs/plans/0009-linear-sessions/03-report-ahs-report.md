---
title: Report 03 关系存储 + ahs-report 双视图 + 统一 sweep
description: src/ahs 派生 relations.jsonl（双向边 + 组指针 + 传递闭包，AR-005 纯派生字节可重建）；ahs-report Task 视图（HEAD 链前缀拼接 + invocation 缩进 + --all 备选版本，聚合无双计）；统一 sweep 对照 0008 基线 0 zod/0 不变量/0 对账失配；B-4 winner 易主仅指针移动。
type: report
status: complete
created: 2026-07-23T15:18:00Z
---

# 03-report: 关系存储 + ahs-report 双视图 + 统一 sweep

---

## 执行摘要

成功。Plan 03 三项工作全部完成，ADR-0005 验证表剩余项全部闭环：

1. **派生关系存储**（`src/ahs/relations.ts`）：`buildRelations` 从 manifests（lineage/invocation 回链）+ records（tool_result.sessionId 正链）派生双向边表（正回链对账去重）、lineage 组（union-find）+ 组 HEAD 指针 `{ groupId, mainSessionId }`（源端 winner 在此层不可得 → 最近活跃启发式 + 确定性 tiebreak）、fork-of-subagent 传递闭包。`writeRelations`/`readRelations` 以 `relations.jsonl` 持久化于归档根（确定性序列化：键排序 + 分节稳定序）。**纯派生（AR-005）**：测试断言删除 relations.jsonl 后从归档重建字节一致。`exportSessions` 默认写出（可 opt-out）。
2. **ahs-report Task 视图**（`examples/ahs-report.ts`）：给定组内任一 session，解析组 + HEAD，渲染 HEAD 链为一条连续线性 transcript（沿 lineage 回链拼接共享前缀至 atRecordId 锚点 + 各 fork 后缀）；invocation 子 session（含闭包继承的 fork-of-subagent）锚定 tool_call 缩进递归，无锚回退排后，环安全。`--all` 列组内 fork/attempt 备选版本（不拼接进 transcript）。聚合 = 各 session 渲染切片 usage 恰好一次（后缀口径，无前缀双计），测试与 record 级独立求和逐项相等。
3. **统一 sweep 复跑**（临时脚本，用后已删，快照先行）：4 家真实数据 1,341 session / 356,827 record，**0 zod 错误、0 不变量错误（含 N-2 两链对账、N-7 锚点判据）、usage 对账 0 失配**；B-4 实证通过（详见专节）。

`npx tsc --noEmit` 零错误；`npx vitest run --coverage` 14 文件 / 180 测试全绿（98.12% stmts / 88.05% branch / 100% funcs / 98.12% lines，阈值 ≥80%）；`npm run test:e2e` 4/4 链路通过；`node scripts/check-report.ts` 通过。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 2be3692 | feat(ahs): derived relations store + task-view report (HEAD chain stitching)（refactor/0009c-ahs-report，PR #27 合并为 66eaca4） |
| （docs commit 见 PR） | docs(plan): 0009 Plan 03 完成（本文件 + 状态翻转） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 派生关系存储 | src/ahs/relations.ts | buildRelations / writeRelations / readRelations + 导航助手（groupOfSession / lineageParentEdge / invocationChildEdges / effectiveInvocation） |
| 归档写出集成 | src/ahs/writer.ts | exportSessions 默认写 relations.jsonl（ExportOptions.relations 可关）；writeArchive 复用重构出的 writeSessionArchive |
| Task 视图消费方 | examples/ahs-report.ts | HEAD 链拼接渲染 + `--all`；renderReport 返回 groupId/headSessionId/alternates |
| 单测 | test/ahs-relations.test.ts（新，9 测试）、test/ahs-report.test.ts（+4 测试） | 含 AR-005 字节重建、fork-of-subagent 闭包、HEAD 启发式 tiebreak |
| e2e | test/e2e/adapter-chains.ts | Task 视图语义下的独立 record 级对账（不依赖 src/ahs/relations 重实现）；devin 断言 fork 折叠 + --all 可见 |
| sweep 脚本 | （临时，已删除） | /tmp 下对 4 家快照投影 + B-4 脚本；未提交，快照与脚本用后均已删除 |

---

## 关系存储：API 与格式

### API

```typescript
buildRelations(sessions: { manifest, records }[]): Relations
// Relations = { edges: RelationEdge[], groups: LineageGroup[], closures: InvocationClosure[] }
// RelationEdge    = { type: "invocation" | "lineage", from, to, atRecordId?, lineageType? }
// LineageGroup    = { groupId, mainSessionId, members[] }   // groupId = 组内最小 sessionId
// InvocationClosure = { sessionId, inheritedFrom, invocation: { sessionId, atRecordId? } }
writeRelations(outDir, relations): Promise<string>  // 归档根 relations.jsonl
readRelations(outDir): Promise<Relations>           // zod 逐行校验
```

### relations.jsonl 格式

一行一个 JSON 对象（键递归排序），三个分节按 edges → groups → closures 顺序、节内排序，重导出字节一致：

```jsonl
{"atRecordId":"root-call","from":"root","kind":"edge","to":"sub","type":"invocation"}
{"atRecordId":"sub-r1","from":"sub","kind":"edge","lineageType":"forked_from","to":"sub/fork-1","type":"lineage"}
{"groupId":"sub","kind":"group","mainSessionId":"sub/fork-2","members":["sub","sub/fork-1","sub/fork-2"]}
{"inheritedFrom":"sub","invocation":{"atRecordId":"root-call","sessionId":"root"},"kind":"closure","sessionId":"sub/fork-1"}
```

### 派生规则要点

- **边**：manifest lineage/invocation 回链 + records 内 tool_result.sessionId 正链（配对 tool_call 的 recordId 为锚）；同一条 invocation 边从两侧各见一次时去重存一份；两端都在归档内才成边（部分归档不产生悬挂边）。
- **组 HEAD**：源端 winner 标记（Devin main_chain_id）不是 session 数据，此层不可得 → 组内末条 record 时间戳最大者，并列取 sessionId 最小（与 codex 适配器同款启发式，确定性）。
- **传递闭包**：fork 的 manifest 不复制 invocation（ADR-0005 §2）；闭包沿 lineage 祖先走（环安全）到首个带 invocation 的祖先，记录其 invocation 与 inheritedFrom。

---

## ahs-report CLI 行为（Task 视图）

```
vite-node examples/ahs-report.ts <archiveRoot> <sessionId> [--all]
```

- **默认**：解析 sessionId 所属 lineage 组 + HEAD 指针，渲染 HEAD 链一条连续 transcript——沿 lineage 回链走到链根，每段渲染到下一代的 atRecordId 锚点（含）；anchor-less（从起点重试）则父段贡献零条；fork 只贡献自己的后缀。段头标注 `(shared prefix, stitched)` / `(task HEAD)`。invocation 子任务（含闭包继承者，按组去重各渲染一次）缩进渲染在锚定 tool_call 之后，无锚/锚在切片外回退排在该 session 记录之后；环以组为单位切断并标注。
- **`--all`**：追加 `== alternate versions (group …) ==` 段，列组内全部 fork/attempt（HEAD 标注、lineage 类型 + 锚点），不拼接进 transcript。
- **聚合**：每个 session 仅其渲染切片的 usage 计一次（fork 只存后缀 → 后缀口径天然无前缀双计）；逐 session `cost (<id>):` 明细 + `total:` 汇总。与 e2e/单测中从 records.jsonl 独立重算的切片求和逐项相等。

已知口径说明：HEAD 链祖段被锚点截断后的"废弃尾巴"不计入聚合（属被折叠的备选版本）；跨树汇流导致的跨 session usage 双计为模型固有边界（02-report-devin 已建档），不在本 Plan 范围。

---

## 逐工作项 PASS 证据

### 1. 派生关系存储（AR-005）

- `buildRelations` 边/组/闭包语义：test/ahs-relations.test.ts 9 测试——正回链去重（root→sub 仅一条）、lineage 类型判据随边、union-find 分组、HEAD 启发式（beta/gamma 同时间戳并列取小 id）、悬挂回链不成边（部分归档）、闭包跨两跳传递（sub/fork-2 经 sub/fork-1 → sub 继承 root 的 invocation）。
- **AR-005 字节重建**：`exportSessions` 导出 → 删除 relations.jsonl → 从归档 sessions 重建 → 与首版**逐字节一致**（测试 "is purely derived (AR-005)"）；write→read 深等于原 build 输出（round-trip 测试）。
- 确定性：输入乱序重跑序列化字节一致；行内键排序（测试 "serializes deterministically"）。
- **fork-of-subagent 闭包测试**（ADR-0005 验证表第 3 行）：test/ahs-relations.test.ts "computes the fork-of-subagent transitive closure"（sub/fork-1、sub/fork-2 均继承 root 的 invocation 且不复制到 manifest）+ test/ahs-report.test.ts "fork-of-subagent: the fork inherits the invocation via the closure and renders once"（消费侧按组去重渲染一次、聚合各计一次）。PASS。

### 2. ahs-report Task 视图（AC-0004-N-1）

- HEAD 链拼接：test/ahs-report.test.ts "renders the HEAD chain"——task-root 前缀至锚点 + task-fork 后缀连续渲染，废弃尾巴（"abandoned direction"）不出现；聚合 = 前缀切片（100/10）+ 后缀（30/3）= 130/13，与独立求和一致。
- 从起点重试（anchor-less sibling_attempt）：父段零贡献，fork 自带 prompt 副本只渲染一次（"retry-from-start" 测试）。
- fork-of-subagent 消费侧：组去重渲染一次、锚定缩进、聚合 10+7+5=22（见上）。
- `--all`：备选版本段落列出全部组成员 + HEAD 标注，transcript 不变（"--all lists the group's fork/attempt sessions" 测试）。
- 既有测试保持绿：锚定子 session 缩进、环切断、未知 session 报错。

### 3. e2e 更新

test/e2e/adapter-chains.ts 4/4 PASS。devin 用例：默认视图渲染 HEAD 链（组 HEAD = sunny-forest#root-50，最近活跃启发式；链 = sunny-forest 前缀 [m-sys-0, m-user-1] + root-50 后缀）并**断言 fork 折叠**（stdout 不含 `#fork-16`/`#root-30`/`#root-40`）；`--all` 运行断言 5 个备选版本 + `HEAD: sunny-forest#root-50` 全部可见。usage 对账改由 e2e 内**独立**实现（仅用 manifest + records.jsonl 重算组/HEAD/切片，不经 src/ahs/relations）与 CLI `total:` 逐项相等。codex 用例断言链式 fork 组 {a1,c3,f6} HEAD=f6 渲染。

### 4. 统一 sweep（对照 0008 基线）+ B-4

见下两节。PASS。

---

## 统一 sweep 对照表（真实数据快照，临时脚本用后已删）

方法同 0008：先快照（`~/.claude/projects`、`~/.codex/sessions`、`~/.kimi-code/sessions` 整树复制；devin sessions.db 复制文件——kimi-code 活跃写入，快照消除 live 增长），投影于快照之上。指标：zod 逐条校验 → `validateSessions` 层二全集（N-1 线性 / N-2 invocation 两链对账 / N-6 tool 配对 / N-7 lineage 锚点+类型判据）→ usage 对账（record 级求和 vs stats.totalUsage，五 token 字段逐一）。

| Harness | 0008 基线 sessions/records | 本次 sessions/records | Δ sessions | Δ records | zod 错误 | 不变量错误 | usage 对账（含 stats session 数 / 失配数） |
|---------|---------------------------|----------------------|-----------|-----------|---------|-----------|-----------------------------|
| claude-code | 175 / 66,299 | 195 / 65,580 | +20 | −719 | 0 | 0 | 177 / 0 |
| codex | 235 / 207,656 | 235 / 211,744 | 0 | +4,088 | 0 | 0 | 149 / 0 |
| kimi-code | 869 / 77,464 | 875 / 79,770 | +6 | +2,306 | 0 | 0 | 839 / 0 |
| devin | 52 / 2,225 | 36 / 1,733 | −16 | −492 | 0 | 0 | 24 / 0 |
| **合计** | **1,331 / 353,644** | **1,341 / 356,827** | **+10** | **+3,183** | **0** | **0** | **1,189 / 0** |

派生关系统计（buildRelations）：claude-code 101 边（81 invocation + 20 lineage）/ 175 组；codex 9 边 / 230 组；kimi-code 202 边（全 invocation）/ 875 组（无 lineage，组==session）；devin 30 边（全 lineage）/ 6 组。闭包 0——真实语料未出现 fork-of-subagent（该路径由 fixture 测试锁定，见工作项 1）。

### Δ 解释

- **session 数增长是模型的正确结果**（ADR-0005 后果表已预告）：一切分叉一律成 session。claude-code +20 = 归一化后的 20 个真分叉从 session 内 tree 分支拆为独立 fork session（02-report-claude-code：同快照 195 session 一致）；devin 反向 −16：旧 tree 模型把 twin 副本等怪癖折叠进 52 个 session，新模型 6 组 36 session（twin 死支不产 session、跨 root 前缀只存一次，02-report-devin 逐条建档，同快照 36 一致）；kimi +6 为活跃源数据自然增长（02-report-kimi-code 同日较早快照 874）。
- **records Δ**：claude-code −719（fork 只存后缀，共享前缀不再重复存储）；devin −492（同理 + twin 去双）；codex +4,088 与 kimi +2,306 为源存储在 0008（07-22）与本次（07-23）快照之间的活跃写入增长（codex 02 报告同日较早快照 209,819，本次 211,744，纯源增长）。
- **usage 对账**：含 stats 的 session 数随 fork 拆分上升（fork manifest 各自记账），0 失配维持。devin 组级 credit cost 仍只在 base session manifest，不参与 record 级对账（0008 同口径）。

## B-4 实证（AC-0002-B-4：winner 易主仅指针移动）

devin fixture 同库两投影（`createDevinFixture(dir, 18)` = base tip winner vs `createDevinFixture(dir, 42)` = root-40 tip winner）：

| 断言 | 结果 |
|------|------|
| session 集合（id + manifest + records）逐字节一致 | **true**（stableSerialize 相等） |
| 适配器默认 listSessions HEAD | `sunny-forest` → `sunny-forest#root-40`（**仅指针移动**） |
| 派生 relations.jsonl 字节一致 | **true**（relations 层 HEAD 为最近活跃启发式，winner 无关——组指针 mainSessionId 恒为 `sunny-forest#root-50`） |

结论：session 与 winner 彻底解耦；源端 winner 易主只移动适配器默认视图 HEAD；关系存储层指针由纯派生启发式给出，不受 winner 影响（spec §三"源端有胜者标记则直取，否则取组内最近活跃 session"——归档层无胜者标记，取后者）。

---

## ADR-0005 验证表回填数据

| 验证项 | 结论 | 证据 |
|--------|------|------|
| 4 适配器重构后 fixture/golden/不变量全绿 | 通过 | 02 各报告 + 本次 CI（180 测试、e2e 4/4） |
| Devin winner 易主不改 session，仅组指针移动 | 通过 | 本报告 B-4 节（字节一致 + HEAD 移动） |
| fork-of-subagent 传递继承，闭包正确 | 通过 | 工作项 1 两条测试（闭包跨两跳 + 消费侧按组去重） |
| facade messages() 无分支选择逻辑 | 不适用本 Plan | interface/0003 实现时静态检查（未启动） |
| 统一 sweep：0 不变量错误、usage 0 偏差 | 通过 | 本报告 sweep 对照表 |

---

## 失败原因分类

无失败。实现期两处预期内测试改写（非缺陷）：codex/devin 适配器测试中的 AC-0004 断言从旧"invocation-only 聚合"语义改写为 Task 视图语义（HEAD 链聚合，注释说明口径）；relations.jsonl 首次写出时 outDir 不存在（writeRelations 补 mkdir，单测捕获）。

## 阻塞级缺陷判定

**无阻塞级缺陷。** 契约未改（spec v2 已含 relations.jsonl 磁盘布局与 Task 派生概念）；关系存储内容纯派生（AR-005 测试强制）。

---

## 测试摘要

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：**180 tests 全绿**（14 文件）；覆盖率 **98.12% stmts / 88.05% branch / 100% funcs / 98.12% lines**（阈值 ≥80%）
- `npm run test:e2e`：smoke OK + 4 条适配器链路 OK（含 devin fork 折叠/--all 断言）
- CI：PR #27 status check `test` 绿，mergeStateStatus CLEAN 后合并
- `node scripts/check-report.ts`：通过

---

## 验收结果

| AC | 结果 | 证据 |
|----|------|------|
| AC-0002-N-2（invocation 两链对账） | PASS | 统一 sweep：validateSessions 对 4 家全量真实投影 0 错误；relations 正回链去重单测 |
| AC-0002-N-7（lineage 锚点 + 类型判据） | PASS | 统一 sweep 0 错误；HEAD 链拼接单测（锚点切片、anchor-less 重试） |
| AC-0002-B-4（winner 易主仅指针移动） | PASS | B-4 节：两投影 session 集逐字节一致、仅 HEAD 移动、relations 字节一致 |
| AC-0004-N-1（消费可用） | PASS | ahs-report Task 视图渲染 HEAD 链 + invocation 子任务，聚合与 record 级独立求和一致（单测 + e2e 真实 CLI 链路） |
| AR-005（关系存储纯派生） | PASS | relations.jsonl 删除重建字节一致（单测强制） |
