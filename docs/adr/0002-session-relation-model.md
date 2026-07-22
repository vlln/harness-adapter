---
title: ADR-0002 Session/Relation 两实体模型
description: AHS 只有 Session 和 Relation 两个实体；Session = agent profile 的实例化、单根 tree 历史；subagent 建模为独立 session + spawned_by 关系。
type: adr
status: draft
created: 2026-07-21T11:48:45Z
---

# ADR-0002: Session/Relation 两实体模型

---

## 背景

调研的 9 个 Harness 呈现五种不同的存储模型（Tree / Graph+sidechain / Forest / Temporal stream，见 [research/schemas/schema-comparison.md](../research/schemas/schema-comparison.md)）。AHS 需要一个能统一归一化这五种模型的概念结构，同时不过度建模（实体越多，适配器映射分歧越大）。

关键张力：subagent 的表示。Claude 的 sidechain 内联在同一文件、Kimi 的 wire.jsonl 天然分离、Devin 的森林有多个竞争 root——各家机制差异大。

---

## 决策内容

AHS 只有 **Session** 和 **Relation** 两个核心实体：

- **Session = 一个 agent profile（声明）的一次实例化**。profile 可显式（Claude `--agents`、Grok `--agent-profile`）或默认（Codex、Kimi 无 profile 机制）。
- **Session 的历史是一棵单根 tree**：record 以 `parentId` 链接（单父，分叉允许多子），`seq` 保时序。线性历史是退化 tree。record 只有 `parentId` + `seq` 两个结构字段，无其他图结构。
- **Subagent 不是特殊对象，就是另一个 session**，通过 `spawned_by` Relation 与父 session 关联；`toolCallId` 锚点可选（Kimi 只有 agent 级 `parentAgentId`）。
- Relation 三种类型：`spawned_by`（子代理）、`forked_from`（fork/rewind）、`sibling_attempt`（Devin 森林竞争分支，配合 Manifest `isMainChain` 标记胜出者）。
- 跨 session 聚合（如任务总代价）交给消费方沿关系图走，Manifest.stats 只存本 session 独占值。

---

## 备选方案

### 方案 A: 三实体（Session / Agent / Record）

- 优点：Agent（profile 声明）作为一等公民，可跨 session 聚合同一 agent 的统计
- 缺点：无 profile 机制的 harness（Codex、Kimi）被迫合成伪 Agent 实体；实体间映射分歧增大

### 方案 B: Subagent 内联为父 session 的特殊 record

- 优点：单文件自包含，读取简单
- 缺点：subagent 历史有独立的因果结构，内联会污染父 tree；usage 归属混乱；与 Kimi/Devin 的天然分离结构相悖

---

## 选择理由

两实体是能覆盖全部五种源模型的最小结构：Tree/Stream 直译单根 tree，Claude sidechain 拆 session，Devin 森林用 sibling_attempt 表达。Subagent 独立成 session 使"任务总代价 = 沿 spawned_by 递归聚合"成为统一口径，usage 归属无歧义。

---

## 验证

| 验证项 | 复现步骤 | 结论 | 经验 | 验证 Branch |
|--------|---------|------|------|------------|
| Claude sidechain 拆分 | spike 适配器投影含 subagent 的 Claude 会话，验证 sidechain → 独立 session + spawned_by(toolUseId 锚点) 无信息损失 | **通过**（2026-07-21，80 个子 session，relation/锚点不变量 0 错误） | 见下 | spike/0001-adapter-prototypes |
| Kimi 多 wire | spike 适配器投影含子 agent 的 Kimi 会话，验证每个 wire.jsonl → 一个 session、parentAgentId → spawned_by（无 toolCallId）可行 | **通过**（2026-07-21，189 个子 session，0 不变量错误） | 见下 | 同上 |
| Devin 森林 | spike 适配器投影多 root 的 Devin 会话，验证 sibling_attempt + isMainChain 能还原主链 | 待验证 | — | 同上 |

**Claude Code 验证经验**：

- 真实数据中 sidechain **全部**以 `<session>/subagents/agent-*.jsonl` 独立文件存在；主文件内联 `isSidechain: true` 记录在 173 会话中出现 0 次（研究文档的"内联"示例实际来自子代理文件）。适配器对内联路径仍保留支持（按 `agentId` 分组）。
- 子代理文件首条记录 `parentUuid: null`——子 session 天然是自包含单根树，跨 session 链接完全由 Relation 承担，模型契合干净。
- 锚点：meta.json 实测字段 `{agentType, description, toolUseId}`（`spawnDepth` 常缺席）；子代理 record 上的 `sourceToolUseID` 可作 toolUseId 回退。
- 真实数据暴露的两个树结构问题（适配器已解决，属源数据怪癖非模型缺陷）：丢弃型记录可作为"链重启"根（需重锚定到链尾）；存在只含 `mode` 行的空会话文件（投影后 0 record，跳过）。
- 发现一项超出模型的源端现实：真实数据有 862 处 tool_call 无配对 tool_result（中断/取消/重发）。这是 AC 层2 配对断言的边界，处理策略（合成占位 result 或显式缺失标记）已列入 Spec 待定。**（2026-07-21 后续：已通过 `tool_call.status` 三态解决，见 Spec 第五节与 AC-0002-N-6）**

**Codex 验证经验（意外收获，2026-07-21）**：

- 研究文档已过时：现行 Codex **有** sub-agent 机制——子线程 rollout 文件的 `session_meta.source` 为 `{subagent:{thread_spawn:{parent_thread_id,...}}}`。适配器将其映射为 `spawned_by` relation（真实数据 3 例，不变量通过）——两实体模型对研究调研之外的新情况同样成立。
- toolCallId 锚点可恢复（父线程 `sub_agent_activity.event_id` 即 `call_*` id），当前 spike 省略，留待正式适配器实现。
- 暴露一个模型边界：`session_meta.id` 是**线程 id** 而非文件 id——恢复/fork 的会话跨多个 rollout 文件，共享线程 lineage。AHS 目前一个文件 = 一个 session，跨文件的同线程分组无表达。已列入 Spec 开放问题（候选：Relation 增加类型，或 Manifest 增加 threadId 分组字段）。

**Kimi Code 验证经验**：

- 多 wire → 多 session 干净利落：887 条 wire 中 189 条是 sub-agent，全部 `parentAgentId: "main"`（语料内无嵌套），每条 wire 产出独立 session + `spawned_by`（无 toolCallId，AC-0002-B-3 路径）。
- 子 agent 的任务 prompt 在子 wire 中以 `system_trigger` 注入——落入 `harness_message`，父子 session 的内容边界清晰，无重复投影。
- 研究文档一处过时：state.json 的 agent type 实测为 `"sub"` 而非 `"subagent"`。

三案例任一无法无损（保留判据内）表达时，退回修订本模型。

---

## 后果

### 正面

- 概念面最小，适配器映射规则统一（spec 第五节归一化表）
- 统计口径统一：stats 独占 + 消费方递归聚合
- fork/subagent/竞争分支三类现实场景都有明确表达

### 负面

- 消费方必须沿关系图走才能算总代价，简单场景也要处理递归
- Agent（profile）非一等实体，跨 session 的 agent 级统计需消费方按 profile 字段自行分组

---

## 约束范围

[spec/0001-ahs.md](../spec/0001-ahs.md) 第三、四节；src/schema/manifest.ts、record.ts、relation.ts；全部适配器的归一化逻辑。

---

## 约束规则

| 规则编号 | 规则 | 适用范围 | 违反时如何检出 |
|----------|------|---------|--------------|
| AR-001 | record 结构字段只有 parentId + seq，不得新增图结构字段 | src/schema/record.ts | schema 审查 |
| AR-002 | subagent 必须产出一个独立 session + spawned_by Relation，不得内联 | 全部适配器 | AC-0002-N-2（关系完整）自动化断言 |
| AR-003 | Manifest.stats 只含本 session 独占聚合，不含子 session | src/schema/manifest.ts + 适配器 | AC 层2 usage 求和断言 |
