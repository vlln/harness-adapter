---
title: ADR-0005 线性 Session 与两维关系（部分 supersede ADR-0002）
description: Session 一律线性（删 tree/parentId）；fork/rewind 一律成 session（lineage + atRecordId 锚点）；invocation 两链（tool_result.sessionId 正链 + manifest 回链）；mainness 去 session 化（组级 HEAD 指针）；Task 为用户视角派生概念。
type: adr
status: proposed
created: 2026-07-23T05:18:21Z
---

# ADR-0005: 线性 Session 与两维关系

> 本 ADR **部分 supersede [ADR-0002](0002-session-relation-model.md)**：被取代的是"session 历史为单根 tree、分叉允许多子节点"、"Relation 三种类型中的 sibling_attempt 旧定义"、Manifest `isMainChain` 字段。被保留的是"subagent 是独立 session"、"存储层只有 Session 和 Relation 两类实体"的精神。

---

## 背景

ADR-0002 的 tree 模型经 4 个适配器验证"能表达"，但暴露了四类摩擦：

1. **分叉住在两个地方**：session 内部 tree 分支（多子节点）与 session 间 relation 并存，是概念冗余。适配器被迫处理 tree 怪癖：Claude 的"链重启"再锚定、Devin 分支重试的去重 forwarding map。
2. **两个正交维度挤在一个字段**：调用关系（spawned_by）与历史关系（forked_from）语义正交，单 `relation` 槽位在 forked-subagent 情形必丢一维。
3. **身份稳定性 bug**：`isMainChain` 作为 Manifest 字段 + "主链拿裸 id"的约定，在 winner 易主（Devin `main_chain_id` 可变）时导致 session-id 被变相重新分配。
4. **概念缺失**：用户视角的"一个会话"（一次业务任务的全部尝试 + 当前位置）与存储视角的 session（一条线性历史）被混用，导致 Codex 跨文件线程、Devin 森林都需要特设表达。

git 提供了现成的参照系：commit 不可变且线性，分支/HEAD 是可变指针，repo 的 DAG 是算出来的视图。

---

## 决策内容

### 1. Session 一律线性

- record **删除 `parentId`**，结构字段只留 `seq`。首条即根。
- 一切分叉（rewind、编辑重发、重试、竞争尝试）**一律产出新 session**，不允许 session 内部分叉。

### 2. lineage（历史维）：单一 fork 机制

```typescript
lineage?: { type: "forked_from" | "sibling_attempt", sessionId: string, atRecordId?: string }
```

- fork session **只存分叉后的后缀**，共享前缀沿 lineage 回溯拼接。
- **sibling_attempt 精确定义**：锚点 `atRecordId` 指向的 record 是 `user_message` 的 fork——该 fork 的使命是"回答这个 prompt"，与兄弟竞争（数据判据，非适配器主观判断）。锚点为 null 表示从起点重试（fork 自带 prompt 副本）。
- fork 的 invocation 沿 lineage **传递继承**（fork-of-subagent 的调起者 = 血统源头的调起者），不显式复制。

### 3. invocation（调用维）：正链 + 回链

- **正链在历史层**：`tool_result` 增加可选字段 `sessionId`（该调用产生的子 session）。tool_call 不可能携带（调用时 id 未存在）；subagent 在历史层就是普通 tool——调用是普通 tool_call、报告是普通 tool_result、唯一特殊性是返回值里有个 session 句柄。
- **回链是 session 级属性**：Manifest `invocation?: { sessionId, toolCallId? }`——"谁调用/创建了我"，使子 session 归档自包含（Kimi 无 toolCallId 时省略）。
- `spawned_by` 作为 relation 类型退役。

### 4. mainness 去 session 化

- session id 与主从**彻底解耦**：竞争组内所有 session 用统一规则的稳定 id，创建即定型。
- "谁是当前主链"是**组级可变指针** `{ groupId, mainSessionId }`，存放于派生层（关系存储），可随投影更新——类比 git HEAD。Manifest **删除 `isMainChain`**。

### 5. Task：用户视角的派生概念

- **Task = lineage 组 + HEAD 指针**，是用户视角的"一个会话"（一次业务任务的全部尝试 + 当前位置）。
- Task **不是存储实体**，由 sessions + lineage 边 + 组指针计算得出。存储层仍只有 Session 和 Relation 两类实体。
- 统一表述：**一切视图（turn、task、主链）都是投影；存储只有线性 session 和边。**
- Codex 跨文件线程、Devin slug 会话，都是 Task 的实例（此前 spec 开放问题的 threadId 方案作废）。

### 6. 关系存储 = 纯派生索引

- 双向边表（父→子经 tool_result.sessionId 正链物化；子→父经 manifest 回链）、组指针、传递闭包、聚合视图——全部由 sessions + manifests 派生，非 authored 数据。

---

## 备选方案

### 方案 A: 保持 ADR-0002 tree 模型

- 优点：4 个适配器已实现验证，零返工
- 缺点：背景中四类摩擦永久存在；facade 的 messages() 需"选存活分支"逻辑；isMainChain 身份 bug 须另打补丁

### 方案 B: sibling_attempt 并入 forked_from（不区分类型）

- 优点：类型更少
- 缺点：竞争语义（多 attempt 择一胜出）是聚合与评审的一等信号（"默认视图走胜出路径"），用锚点 role 派生可行但每个消费方都要重做判断；保留类型名成本极低

### 方案 C: invocation 仅正链，无 manifest 回链

- 优点：零冗余
- 缺点：子 session 归档不自包含（孤立归档无法回答"谁创建了我"）；违背 session 自包含原则（Devin sibling 各存共享前缀同理）

---

## 选择理由

概念收支：删去 tree 分支、parentId、isMainChain、spawned_by 类型、Devin 去重 forwarding map、Codex threadId 开放问题；新增 atRecordId 锚点、tool_result.sessionId、组指针。模型净更小，且 forked-subagent、winner 易主、跨文件线程三个原先的特设情形全部变为一般机制的普通实例。

---

## 验证

| 验证项 | 复现步骤 | 结论 | 经验 | 验证 Branch |
|--------|---------|------|------|------------|
| 4 个适配器按新模型重构后，全部 fixture/golden/不变量测试通过 | feat 容器重构 + CI | 待验证 | — | feat/0009+（待创建） |
| Devin winner 易主不改 session：同一 sessions.db 两个投影时刻，session 集合字节一致、仅组指针移动 | 构造 fixture（两次投影间 main_chain_id 变化） | 待验证 | — | 同上 |
| fork-of-subagent 传递继承：fork 自子代理的 session 不显式复制 invocation，关系存储闭包正确 | 构造 fixture | 待验证 | — | 同上 |
| facade messages() 无分支选择逻辑（线性直读） | interface/0003 实现时静态检查 | 待验证 | — | 同上 |
| 真实数据 sweep 复跑：4 家不变量 0 错误、usage 对账 0 偏差 | 统一 sweep（对照 0008 Report 基线） | 待验证 | — | 同上 |

---

## 后果

### 正面

- record 模型极简（seq 唯一结构字段）；facade messages() 无分支逻辑
- Devin 分支重试从"需去重的脏数据"变一等公民；去重 forwarding map 删除
- 用户视角/存储视角分离后，Task、主链、跨文件线程都有自然归属

### 负面

- 主链合成策略：Claude 等无 winner 标记的 harness 需启发式判定 fork 主线（如 last leaf 所在链），属适配器策略层
- session 数量膨胀（每次微重试一个 session）：`listSessions` 默认折叠 lineage 后代，需过滤参数
- 既有 4 适配器 + validate + ahs-report 返工（映射知识已沉淀在各容器 Report，成本可控）

---

## 传导清单（设计变更下游同步）

| 对象 | 变更 |
|------|------|
| ADR-0002 | 追加修订记录：tree/旧 sibling_attempt/isMainChain 条款被本 ADR supersede |
| spec/0001-ahs.md | 概念模型重写（线性 session、两维关系、Task 派生）；record 删 parentId；Manifest 删 isMainChain、relation→lineage/invocation 两槽；tool_result +sessionId；关系存储改派生索引；开放问题移除 threadId 项 |
| ac/0001-adapter-ac.md | N-1 简化（无 parentId 检查，首条即根 + seq 单调）；N-2 重写（lineage 锚点可解析 + invocation 回链与正链对账）；新增 sibling_attempt 判据检查、mainness 组指针检查 |
| interface/0001 | listSessions 默认折叠 lineage 后代 + 过滤参数 |
| interface/0003（拟建） | facade 双视图：loadSession（存储视角）/ loadTask（用户视角 HEAD 链） |
| src/ | schema、validate、4 适配器、ahs-report 重构（feat 容器） |

---

## 约束范围

全部适配器；src/schema、src/validate、src/ahs、examples；spec/AC/interface 契约文档；未来 AHS 标准的概念框架。

---

## 约束规则

| 规则编号 | 规则 | 适用范围 | 违反时如何检出 |
|----------|------|---------|--------------|
| AR-001 | record 不得含 parentId/branch 类图结构字段，仅 seq | src/schema/record.ts | schema 审查 + AC-0002-N-1 |
| AR-002 | 任何分叉必须产出新 session（lineage 边），禁止 session 内分支 | 全部适配器 | AC 不变量 |
| AR-003 | 正链只能经 tool_result.sessionId 表达，tool_call 不得含 sessionId | src/schema/record.ts | schema 审查 |
| AR-004 | session id 与 mainness 解耦；isMainChain 不得出现在 Manifest | src/schema/manifest.ts | schema 审查 |
| AR-005 | 关系存储内容必须可由 sessions + manifests 派生，禁止 authored-only 数据 | src/ahs/ | code review |
