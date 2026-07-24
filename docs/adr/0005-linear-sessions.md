---
title: ADR-0005 线性 Session 与两维关系（部分 supersede ADR-0002）
description: Session 一律线性（删 tree/parentId）；fork/rewind 一律成 session（lineage + atRecordId 锚点）；invocation 两链（tool_result.sessionId 正链 + manifest 回链）；mainness 去 session 化（组级 HEAD 指针）；Task 为用户视角派生概念。
type: adr
status: superseded
created: 2026-07-23T05:18:21Z
---

# ADR-0005: 线性 Session 与两维关系

> **修订记录（2026-07-23）**：① 正链 `tool_result.sessionId` → `sessionIds: string[]`——支持一次调用产多个子 session（Kimi AgentSwarm 真实数据，单产子写单元素数组）；② `lineage.atRecordId` 三态——有值 = 锚定、`null` = 锚点源端不可得、缺省 = 从起点重试（此前 null 与缺省混用，存在歧义）。

> **修订记录（2026-07-24）**：③ lineage 类型重整：`sibling_attempt` 退役（并入 `rewound_from`）；`forked_from` 重新定义为全量复制/独立 root（`root: true`），`rewound_from` 为共享前缀/结构依赖（`root: false`）；④ Manifest 新增 `root: boolean` 字段，显式表达 session 自包含性。

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
lineage?: { type: "forked_from" | "rewound_from", sessionId: string, atRecordId?: string }
```

- rewind session **只存分叉后的后缀**，共享前缀沿 lineage 回溯拼接（`root: false`，lineage 为结构依赖）。
- fork session 自包含全部历史（`root: true`），lineage 仅为元信息（"我从哪复制来的"），不依赖源。`forked_from` + `root: true` 表示 lineage 是可选元信息；`rewound_from` + `root: false` 表示 lineage 是结构依赖。
- **`sibling_attempt` 退役**：不再独立成类型。它本质就是 `rewound_from` 锚于 `user_message` 的普通情况——锚点位置由 atRecordId 自然表达，不须额外类型区分。
- 锚点 `atRecordId` 三态：有值 = 锚定；`null` = 锚点本应存在但源端不可得；缺省 = 从起点重试（rewind 自带 prompt 副本）。
- rewind 的 invocation 沿 lineage **传递继承**（rewind-of-subagent 的调起者 = 血统源头的调起者），不显式复制。

### 3. invocation（调用维）：正链 + 回链

- **正链在历史层**：`tool_result` 增加可选字段 `sessionId`（该调用产生的子 session）。tool_call 不可能携带（调用时 id 未存在）；subagent 在历史层就是普通 tool——调用是普通 tool_call、报告是普通 tool_result、唯一特殊性是返回值里有个 session 句柄。
- **回链是 session 级属性**：Manifest `invocation?: { sessionId, atRecordId? }`——"谁调用/创建了我"；`atRecordId` 指向父 session 中那次 spawning tool_call 的 recordId（跨 session 引用统一为 recordId 寻址；Kimi 无锚点时省略）。
- `spawned_by` 作为 relation 类型退役。

### 3.5 root 字段（2026-07-24 amend）

- Manifest 新增 `root: boolean` 字段，显式表达 session 是否自包含：
  - `root: true` = 所有历史在本 session 的 records 内（原始 session、fork 全量复制）
  - `root: false` = 需沿 lineage / invocation 回链拼接完整历史（rewind、subagent）
- 替代原有"无 lineage 且无 invocation ⇒ root"的脆弱推断，使 tree 构建和验证逻辑不再依赖隐式规则。

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

### 方案 B: sibling_attempt 并入 rewound_from（不区分类型）

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
| 4 个适配器按新模型重构后，全部 fixture/golden/不变量测试通过 | feat 容器重构 + CI | **通过**（2026-07-23，180 测试全绿，PR #20-#28） | 容器 0009 三个 Plan 的 Report | refactor/0009a/b/c |
| Devin winner 易主不改 session：同一 sessions.db 两个投影时刻，session 集合字节一致、仅组指针移动 | 构造 fixture（两次投影间 main_chain_id 变化） | **通过**（2026-07-23，main_chain_id 18→42，session 集与派生 relations 逐字节一致，仅 HEAD 移动） | 0009 03-report §B-4 | refactor/0009c-ahs-report |
| fork-of-subagent 传递继承：fork 自子代理的 session 不显式复制 invocation，关系存储闭包正确 | 构造 fixture | **通过**（2026-07-23，fixture 锁定；真实语料中无此实例，仅有合成验证） | 0009 03-report | 同上 |
| facade messages() 无分支选择逻辑（线性直读） | interface/0003 实现时静态检查 | **通过**（2026-07-23，ahs-report Task 视图 = lineage 回溯拼接 + 线性渲染，无分支选择；e2e 独立重算断言） | 0009 03-report + test/e2e | 同上 |
| 真实数据 sweep 复跑：4 家不变量 0 错误、usage 对账 0 偏差 | 统一 sweep（对照 0008 Report 基线） | **通过**（2026-07-23，1,341 session / 356,827 records，zod 0、不变量 0、usage 1,189 项 0 偏差） | 0009 03-report §sweep 对照表 | 同上 |

**验证经验（2026-07-23，容器 0009）**：

- 线性化暴露并消除了 tree 模型最大的适配器复杂度：Claude 裸 parentUuid 图的 1,773 个多子点绝大多数是存储重写工件（流式分段、重日志），归一化后仅 20 个真分叉；Devin 的 twin 兄弟副本（513/513 其一必为死支）同理——新模型下这些去重机制全部删除。
- 关系存储的 HEAD 指针采用最近活跃启发式（归档层看不到源端 main_chain_id），与源端胜者可能不同——已在 03-report 记录，属预期行为：HEAD 是"用户最近在哪"的视图，不是源端裁判的镜像。
- 已知模型边界（不阻塞）：Devin 跨树消息汇流导致跨 session 聚合约 +8% output 双计（02-report-devin 定性）；Kimi AgentSwarm 一对多正链超出 tool_result.sessionId 单值槽（待 Spec 决策）。

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
