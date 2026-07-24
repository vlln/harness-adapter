---
title: Report 02 claude-code 适配器线性化重构
description: 主文件线性化（同 uuid 重日志去重 / message.id 段链 / 结果投递链内 / 状态事件链内 → 真分叉拆 fork session）；invocation 两链（meta.toolUseId 锚 + tool_result.sessionId 正链）；sweep 195 session 0 不变量错误、usage 逐 token 精确对账。
type: report
status: complete
created: 2026-07-23T14:05:00Z
---

# 02-report: claude-code 适配器线性化重构

---

## 执行摘要

成功。claude-code 适配器按 ADR-0005 完成线性化重构。关键认知：**源 parentUuid 图的多子节点绝大多数不是用户分叉，而是存储重写工件**——真实 sweep（95 文件）中裸图有 1,773 个多子点，归一化后只剩 20 个真分叉。四类工件各归其位：(a) 同 uuid 重日志去重（结构取首次、usage 取末次写入）；(b) 同 `message.id` 的 assistant 行是一条逻辑消息的流式分段（块跨行累积、tool_result 交织其间），段永远链内顺序排列；(c) 纯 tool_result 用户行是并行/重复结果投递，永远与其 tool_call 同链；(d) goal/compaction 状态事件是控制面重写，不成叉。归一化后剩余多子点才是真分叉：主线 = 通向最后叶子（文件序最大）的链，其余子树拆 suffix-only fork session。invocation 两链：子 manifest 锚 meta.toolUseId（回退 sourceToolUseID）对应 tool_call 的 recordId，父中配对 tool_result 携带 `sessionId` 正链。真实 sweep：195 session / 65,580 record，0 不变量错误，usage 逐 token 精确对账（record == manifest stats == 源逻辑总量），幂等通过。`npx tsc --noEmit` 零错误；164 测试全绿（行覆盖 97.91%，适配器 99.22%）；e2e 4/4 链路通过。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 6ec0a43 | refactor(adapter)!: claude-code linear sessions + fork synthesis + invocation links（代码 + fixture + 测试 + golden） |

（本报告为紧随其后的单独 docs commit，哈希见 git 历史。）

---

## 源格式关键事实（真实数据核实，~/.claude/projects 95 主文件）

| 事实 | 证据 |
|------|------|
| 裸 parentUuid 图多子点 1,773 个 / 33 文件，其中绝大多数是重写工件而非用户分叉 | 分类扫描：assistant(tool_use)→[assistant,user] 655、tool_call→[tool_result×N] 1,901 等 |
| 同 `message.id` 多 assistant 行 = 一条逻辑消息的**分段**（块跨行累积，如 [thinking]→[text,tool_use]；tool_result 交织在段间） | 13,531 个 mid 多行组；样例 mid 三段 kinds=[thinking]/[tool_use]/[tool_use]，末段 stop_reason 才有值 |
| 分段 usage 是重复的运行值（中间段 input 恒等重复、output=0），仅末段报完整消息 usage | 样例 mid 5 段 input=[44818×4, 8195]、output=[0×4, 235]；summed 全行 input 1.79B vs 逻辑量 430M（4 倍双计） |
| 同 tool_use_id 多投递 = 字节级完全重复（非分叉）；多 tool_use 的结果可分多行投递（并行结果，非同 fork） | 431 组同 id 投递全部字节相同；1,559 组 disjoint-id 并行投递、93 组混合 |
| 同 uuid 重日志行 1,359 组：content 100% 相同，usage 仅 2 组不同（cwd 变更后整区重写） | 全量扫描 content_diff=0 |
| 归一化后真分叉形态：assistant_message→[user,user]（编辑重发，forked_from）、user_message→[assistant×2 / tool_call×2]（重答，sibling_attempt）、tool_result→[assistant×2] 等 | 归一化后 20 fork：19 forked_from + 1 sibling_attempt |
| subagent 锚点可得性：meta.json toolUseId / 首行 sourceToolUseID 命中父 Task tool_call | sweep：81 回链中 75 锚定 + 正链，6 回退 B-3（无锚） |

---

## 实现要点

- `src/adapters/claude-code/index.ts` 重写为两阶段：`buildTree`（同 uuid 去重 → 结构首现；dropped 行穿透；链重启再锚定到前一保留节点）+ `linearize`（段/投递/状态事件链内，最后叶子定主线，其余子树出 fork spec；显式栈迭代——真实文件链长超调用栈）。fork id `<main>/fork/<分叉根 uuid>`，lineage 锚 = 锚点节点在父 session 的首条投影 record（锚点记录全被去重的极端情形上溯最近已发射祖先）；类型按锚点 record 类型判定（user_message ⇔ sibling_attempt）。
- invocation 两链：两遍法——先投影文件全部 session（主线 + 各 fork + 各子代理），再按 toolCallId 建锚表（call 与配对 result 同 session 才锚，中断调用无正链载体 → B-3 回退），正链写入配对 tool_result。子代理文件自身分叉同样线性化（fork 经传递继承 invocation，不显式复制）。
- usage 流级记账（`computeUsageByUuid`）：每 stream 仅 mid 末段的 uuid 携带 usage；同 uuid 重复行取末次写入值。链级判定在"整区重写"文件（同 mid 跨区域落不同链）会双计，故提到 stream 级。
- `listSessions`：`includeForks` 默认 false → 折叠 lineage 后代（claude 组 HEAD = 主线 session，组内唯一无 lineage 者）；`readRecords` 解析 fork id（`/fork/` 前缀定位主文件，投影按文件 memoize）。
- fixture 新增：66666666（编辑重发 forked_from + 同题重答 sibling_attempt，主线走最后叶子）、77777777（同 mid 兄弟段链内 / 并行结果多行投递 / 重复投递去重 / meta.toolUseId 无命中 → B-3）；golden 经临时脚本（用后已删）重生成，diff 复核仅预期增量（B/C 正链 sessionId、abc123/def456 锚点 atRecordId）。

---

## 逐 AC PASS 证据

### AC-0002-N-1（线性：无 parentId，seq 严格递增且连续）

PASS。record 仅 seq 结构字段（schema 强制）；测试逐 fixture 断言 seq == 发射下标；`validateSessions.checkLinear` 对 fixture 全集与 sweep 195 session 零 `seq-order`（commit 6ec0a43）。

### AC-0002-N-2（invocation 两链对账）

PASS。fixture B：abc123 `invocation = { sessionId: B, atRecordId: "bbbb0002…/tool_use/0" }`，父 tool_result（bbbb0003）携带 `sessionId: abc123`；fixture C：inline sidechain 经 sourceToolUseID 回退锚定，正链落于首条非重复 tool_result（dddd0006 → def456）。`validateSessions.checkInvocations`（父存在 + 锚解析 + 正回链对账）fixture 与 sweep 零错误。sweep：回链 81 / 锚定 75 / 正链 75 / B-3 无锚 6（commit 6ec0a43）。

### AC-0002-N-7（lineage 锚点 + 类型判据）

PASS。fixture F：编辑重发 fork 锚 assistant_message → `forked_from`（atRecordId = 锚点 record），同题重答 fork 锚 user_message → `sibling_attempt`；fork 仅存后缀（首 record 即分叉子行，无共享前缀）。`validateSessions.checkLineages` fixture 与 sweep 零错误；sweep 20 fork 全部锚定（lineageNoAnchor=0），类型分布 19 forked_from / 1 sibling_attempt 与源形态一致（commit 6ec0a43）。

### AC-0002-N-6 / B-1（tool XOR 配对 + 首条重复结果）

PASS。重复投递文件级去重（首条链序获胜）；fixture C 断言同 toolCallId 仅留首条；无结果调用 interrupted 不合成结果（toolu_task03）。sweep 零 `tool-result-match`（重构中期曾因段折叠丢失 tool_call 产生 3,330 个孤儿 result，改为段链内后归零）（commit 6ec0a43）。

### AC-0002-N-5（幂等）

PASS。`checkIdempotency` fixture 通过；sweep 快照（先 cp 后跑）两次全量运行逐字节一致。全部排序来自文件序 + 字典序，无墙钟读取（commit 6ec0a43）。

### AC-0002-N-3 / N-4（内容/usage 无静默丢失）

PASS。文本逐字（含 slash-command XML）；usage 精确对账（见 Sweep 统计）：record 级求和 == manifest stats 求和 == 源逻辑总量（每 mid 末段 usage，同 uuid 重日志取末次写入），逐 token 相等，0 session 偏差（commit 6ec0a43）。

### AC-0002-B-3（无锚 invocation）

PASS。fixture G 子代理 meta.toolUseId 指向不存在的调用 → `invocation { sessionId }` 无 atRecordId、父端无正链；sweep 6 例同形态（commit 6ec0a43）。

### AC-0002-B-4（指针稳定性）

PASS。session id 与 mainness 解耦：主线恒取裸 sessionId（文件 uuid），fork id 由源 uuid 派生，创建即定型；"谁是主线"（最后叶子启发式）只影响 lineage 归属与默认视图折叠，不重分配任何 id。两次投影同一输入 → 全部 id 逐字节一致（幂等项覆盖）（commit 6ec0a43）。

### AC-0003-N-1（golden）

PASS。golden 全量重生成（含 2 个 fork session，文件名经 sanitizeSessionId 转义 `/`）；逐 diff 复核：A/D 字节不变，B/C 仅 +正链 sessionId，abc123/def456 仅 +atRecordId；golden 测试通过（commit 6ec0a43）。

### AC-0004-N-1（消费方可用）

PASS。claude-code-report 测试（archive → ahs-report：子 session 锚点渲染于 Task tool_call 之下、父子 usage 精确聚合 input=14400/output=350）通过；e2e 4/4 链路通过（commit 6ec0a43）。

---

## Sweep 统计（~/.claude/projects 快照，95 主文件 + subagents）

| 指标 | 值 |
|------|-----|
| session / record | 195 / 65,580 |
| 不变量错误 | 0（AC-0002 全项，含 N-1/N-2/N-6/N-7） |
| usage 对账 | **逐 token 精确相等**（record == manifest stats == 源逻辑总量）：input 430,219,292 / output 5,951,358 / cacheRead 2,028,611,720 / cacheWrite 84,942,501；usageMismatchSessions=0 |
| lineage fork | 20（forked_from 19 / sibling_attempt 1 / 无锚 0） |
| invocation 回链 / 锚定+正链 / B-3 无锚 | 81 / 75 / 6 |
| 幂等 | 两次运行逐字节一致 |

注：sweep 基线"源逻辑总量" = 每 `message.id` 末段 usage（同 uuid 重复行取末次）——中间段为重复运行值，不计（详见"源格式关键事实"）。sweep 脚本为临时脚本（/tmp，用后已删）。

---

## 测试与覆盖率

| 指标 | 值 |
|------|-----|
| vitest | 13 文件 / 164 测试全过（claude-code 适配器 36 + golden 1 + report 1） |
| 行覆盖 | 97.91%（claude-code 适配器 99.22%，≥80% 门禁） |
| `npx tsc --noEmit` | 零错误 |
| `npm run test:e2e` | 4/4 适配器链路通过 |

---

## 契约摩擦（上报，未在适配器打补丁）

1. **无**。本轮重构未被迫新增字段 / record 类型 / 逃生舱：fork 后缀 + lineage 锚、invocation 两链、B-3 回退、HEAD 折叠均被现有契约覆盖。两个高噪音源工件（段、重复投递）的归一化全部落在适配器策略层，模型无需特设。

## 实现决策记录（非摩擦）

1. **段不合并、不折叠**：同 `message.id` 分段各自成 record（assistant_message/tool_call），忠实保留源结构与内容计数；仅 usage 按末段去重——这是源端同值重复，非信息丢失。
2. **fork 锚点上溯**：锚点自身记录全被文件级去重时（理论情形），沿树祖先上溯到最近已发射节点；sweep 未触发（lineageNoAnchor=0）。
3. **invoke 锚定需配对 result 同 session**：Task 调用 interrupted 时无正链载体，锚定会让 `checkInvocations` 对账失败，故回退 B-3——对账优先于锚定完备性。
