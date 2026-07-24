---
title: Report 02 kimi-code 适配器线性化重构
description: invocation 正链（Agent tool.result agent_id 头行 → tool_result.sessionId）；includeForks 支持（无 lineage 恒为 HEAD）；AgentSwarm 一对多正链契约摩擦上报。sweep 874 session 0 不变量错误、usage 精确对账。
type: report
status: complete
created: 2026-07-23T12:10:00Z
---

# 02-report: kimi-code 适配器线性化重构

---

## 执行摘要

成功。kimi-code 适配器按 ADR-0005 完成线性化重构：子 wire 维持无锚 invocation 回链（AC-0002-B-3，源端仅 agent 级父子关系），新增 invocation 正链——父 wire 中 `Agent` tool.result 输出的 `agent_id: <name>` 头行识别子 wire，配对 tool_result 携带 `sessionId: <uuid>/<name>`。`listSessions` 支持 `includeForks`（本适配器永不产生 lineage，默认视图恒等于全量，注释说明）。forked 事件维持 source-unavailable（无源 session id）。真实数据 sweep：874 session / 78656 record，0 不变量错误，usage 精确对账，幂等通过。`npx tsc --noEmit` 零错误；158 测试全绿（行覆盖 97.93%）；e2e 4/4 链路通过。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 9b00d3b | refactor(adapter)!: kimi-code linear sessions + fork synthesis + invocation links（代码 + fixture + 测试） |

（本报告为紧随其后的单独 docs commit，哈希见 git 历史。）

---

## 源格式关键事实（真实数据核实）

| 事实 | 证据 |
|------|------|
| `Agent` tool.result 输出以 `agent_id: <name>\n` 头行开头，可识别子 wire | 真实数据 127/127 个 Agent 结果带此头行 |
| `AgentSwarm` tool.result 输出为 `<agent_swarm_result>` 包裹 N 个 `<subagent agent_id="...">`（一次调用 N 个子代理） | 真实数据 12 个 AgentSwarm 调用，样例单次 5 子代理 |
| 子代理无嵌套（parentAgentId 恒为 main/null）；子 wire 内无 Agent/AgentSwarm 调用 | 全量 state.json + 899 wire 扫描 |
| forked 事件仅 `{type, time}`，无源 session id；fork 目录含完整前缀拷贝 + forked 标记 | 3 个 forked 事件（同一会话 main/agent-0/agent-1 各一），fork 会话标题 `Fork: <原标题>` |

---

## 实现要点

- `src/adapters/kimi-code/index.ts`：`projectRecords` 增 `SubAgentLink { rootSessionId, agentNames }` 可选参数；记录 toolCallId→工具名映射，`Agent` 调用的配对结果解析 `agent_id` 头行且命中本会话 agent 名册时，tool_result 携带 `sessionId` 正链。AgentSwarm / 无头行 / 未知名册三类不加链。
- `src/store/adapter.ts`：`SessionFilter` 增 `includeForks?: boolean`（interface/0001 契约已声明，4 个适配器分支共用此小冲突面）。
- `listSessions`：includeForks 空操作（无 lineage → 每 session 即各自组 HEAD），注释说明语义成立的理由。
- fixture：主 wire 增 `Agent` 调用/结果对（call_k002 → agent-0）；golden 经临时脚本（scripts/tmp-gen-kimi-golden.ts，用后已删）重新生成。

---

## 逐 AC PASS 证据

### AC-0002-N-1（线性：seq 严格递增且连续）

PASS。每 wire 合成线性链（seq = 发射下标）；测试逐条断言 `recordId === <sid>:<i>` 且 `seq === i`；`validateSessions` 的 `checkLinear` 对全部 fixture 输出零错误；sweep 874 session 全量 `validateSessions` 零 `seq-order`（commit 9b00d3b）。

### AC-0002-N-2 + B-3（invocation 两链）

PASS。子 manifest `invocation { sessionId }` 无 atRecordId（B-3）；父端 `Agent` 配对 tool_result 携带 `sessionId` 正链。测试证据：fixture 断言 call_k002 的 tool_result `sessionId === <uuid>/agent-0`、内容逐字保留、非 Agent 结果无链；`validateSessions`（`checkInvocations`：父存在性 + B-3 跳锚）fixture 与 sweep 均零错误。sweep：回链 201、正链 127、锚定 0（commit 9b00d3b）。

### AC-0002-N-7（lineage 锚点 + 类型判据）

PASS（空真）。kimi 源端 forked 事件无源 session id，适配器不产生任何 lineage（sweep：lineage 0）；`validateSessions` 的 `checkLineages` 在 fixture 与 sweep 全集上零错误。fork 投影为独立完整线性 session（源端即完整前缀拷贝），history 维关联不可得属 source-unavailable，见"契约摩擦"（commit 9b00d3b）。

### AC-0002-N-6 / B-1（tool XOR 配对）

PASS。call_k003 悬空 → interrupted 无合成结果；fixture 与 sweep 零 `tool-result-match`（commit 9b00d3b）。

### AC-0002-N-5（幂等）

PASS。`checkIdempotency` fixture 通过；sweep 快照上两次全量运行逐字节一致，0 错误（commit 9b00d3b）。

### AC-0002-N-3 / N-4（内容/usage 无静默丢失）

PASS。turn.prompt/steer 去重断言不变；sweep usage 精确对账：record 级求和 == 源 turn-scope 求和 == manifest stats 求和（input 91,315,153 / output 9,485,714 / cacheRead 2,010,215,821 / cacheWrite 0），session-scope 累计量仍丢弃不双计（commit 9b00d3b）。

### AC-0003-N-1（golden）

PASS。golden 重新生成，diff 仅含新增 Agent 调用/结果对（含正链 `sessionId`）及 seq 平移；golden 测试通过（commit 9b00d3b）。

### AC-0004-N-1（消费方可用）

PASS。kimi-code-report 测试（archive → ahs-report：父子渲染 + 聚合 usage input=1400/output=110）通过；e2e 4/4 链路通过（commit 9b00d3b）。

---

## Sweep 统计（~/.kimi-code/sessions 快照，899 wire）

| 指标 | 值 |
|------|-----|
| session / record | 874 / 78,656 |
| 不变量错误 | 0（AC-0002 全项，含 N-1/N-2/N-6/N-7） |
| usage 对账 | 精确相等（record == 源 turn-scope == manifest stats） |
| invocation 回链 / 正链 / 锚定 | 201 / 127 / 0（B-3 全无锚） |
| lineage | 0（forked 事件 source-unavailable） |
| 幂等 | 两次运行逐字节一致 |
| 源端 forked 事件 | 3（均投影子 complete 独立 session） |

回链 201 > 正链 127 的差额：AgentSwarm 产生的子代理（一次调用 N 子，无正链，见契约摩擦）+ Agent 结果无 agent_id 头行（失败形态）。

---

## 测试与覆盖率

| 指标 | 值 |
|------|-----|
| vitest | 13 文件 / 158 测试全过（kimi-code 适配器 24 测试） |
| 行覆盖 | 97.93%（kimi-code 适配器 92.09%，≥80% 门禁） |
| `npx tsc --noEmit` | 零错误 |
| `npm run test:e2e` | 4/4 适配器链路通过 |

---

## 契约摩擦（上报，未在适配器打补丁）

1. **AgentSwarm 一对多正链不可表达**：一次 AgentSwarm tool_call 产生 N 个子 session，而 `tool_result.sessionId` 是单值槽位。当前实现不加正链（子端回链仍在）。若模型要覆盖，需 `sessionId` 改为可复数或允许结果级多链——属 Spec 决策，非适配器补丁。
2. **forked 事件无源 session id（维持）**：fork 无法建 lineage；且 fork 目录复制完整前缀，投影后共享前缀在父子 session 双份存储/双计 usage（消费方无法去重）。源端不改进则永久不可得。

---

## 失败原因分类

无失败。两处实现决策记录：(1) 正链解析严格限定 `Agent` 工具名 + `agent_id` 头行 + 命中 agent 名册三重条件，避免误链（AgentSwarm 输出含 agent_id 字样但工具名不同，自然排除）；(2) includeForks 以注释说明的空操作实现，而非通用组 HEAD 推导——本适配器结构上不可能产生 lineage（源端无 fork 源 id），通用推导在此恒等。
