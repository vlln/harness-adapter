---
title: AC-0001 适配器验收标准
description: Harness 适配器的四层验收标准（合法/完整/保真/可用）+ 元标准与执行位置，覆盖全部 HarnessAdapter 实现。
type: ac
status: draft
created: 2026-07-21T11:48:45Z
---

# AC-0001: 适配器输出合法（层1）

每个适配器输出的每个 Manifest 和每条 record 都必须通过 AHS zod schema 校验。这是机器可检查的最底层门槛。

## 正常场景

| 编号 | 前置条件 | 操作步骤 | 预期结果 | 验证方式 |
|------|---------|---------|---------|---------|
| AC-0001-N-1 | 源存储中存在至少一个合法会话 | 1. 运行适配器 listSessions + readRecords<br>2. 对每个 Manifest 与每条 record 执行 zod parse | 全部通过校验，无 ZodError | 自动化 |

## 异常场景

| 编号 | 前置条件 | 操作步骤 | 预期结果 | 验证方式 |
|------|---------|---------|---------|---------|
| AC-0001-E-1 | 源会话含适配器无法映射的字段（如 Codex encrypted_content） | 1. 运行适配器<br>2. 校验输出 | 输出仍全部通过 schema 校验；无法映射的信息按 Spec 丢弃规则处理，不产生 schema 外字段 | 自动化 |

## 失败场景

| 编号 | 前置条件 | 操作步骤 | 预期结果 | 验证方式 |
|------|---------|---------|---------|---------|
| AC-0001-F-1 | 源端数据不可得（如云端-only 的 Cursor 消息正文、OpenCode 无持久化） | 1. 运行适配器 listSessions | 能力声明标注 `history: "partial" / "none"`；不伪造数据填充 | 自动化 |

---

# AC-0002: 适配器输出完整（层2，语义不变量，机器可检查）

完整性 = 保留判据内的信息无静默丢失。以下子项均为不变量断言。

## 正常场景

| 编号 | 前置条件 | 操作步骤 | 预期结果 | 验证方式 |
|------|---------|---------|---------|---------|
| AC-0002-N-1 | 任意源会话（因果完整） | 1. 运行适配器<br>2. 检查输出 record 图 | 每 session 恰好一个 `parentId=null` 的根 record；其余 `parentId` 均指向同 session 内存在的 record；`seq` 单调递增 | 自动化 |
| AC-0002-N-2 | 源会话含 subagent 单元（关系完整） | 1. 运行适配器<br>2. 检查 Relation | 源存储中每个 subagent 单元恰好产出一个子 session；`spawned_by` 的 sessionId 存在；`toolCallId` 锚点指向父 session 中真实存在的 `tool_call` record | 自动化 |
| AC-0002-N-3 | 任意源会话（内容无静默丢失） | 1. 运行适配器<br>2. 对比源与输出 | user/assistant 消息条数与源相等；文本逐字保留 | 自动化 |
| AC-0002-N-6 | 任意源会话（tool 配对） | 1. 运行适配器<br>2. 检查 tool_call/tool_result | 每个 `tool_call` 恰有配对 `tool_result`，或 `status === "interrupted"`，二者必居其一；同一 toolCallId 多个 result 时仅保留文件序第一条 | 自动化 |
| AC-0002-N-4 | 源会话含 usage 数据（usage 无静默丢失） | 1. 运行适配器<br>2. 汇总 record 级 usage | record 级 usage 求和 ≈ 源会话总量（容差内） | 自动化 |
| AC-0002-N-5 | 任意源会话（幂等） | 1. 同一输入运行适配器两次 | 两次输出逐字节一致 | 自动化 |

## 边界场景

| 编号 | 前置条件 | 操作步骤 | 预期结果 | 验证方式 |
|------|---------|---------|---------|---------|
| AC-0002-B-1 | 源会话的 tool_call 无对应 tool_result（中断/崩溃） | 1. 运行适配器 | 该 tool_call 标记 `status: "interrupted"`；不得合成占位 tool_result | 自动化 |
| AC-0002-B-2 | 源本身缺失 usage（部分 harness/版本不记录） | 1. 运行适配器<br>2. 汇总 usage | usage 字段缺省/为 null 被允许；但适配器不得丢弃源中存在的 usage | 自动化 |
| AC-0002-B-3 | 源 harness 只有 agent 级父子关系无 toolUseId（如 Kimi） | 1. 运行适配器 | `spawned_by.toolCallId` 省略（可选字段），其余关系断言不变 | 自动化 |

---

# AC-0003: 适配器输出保真（层3）

check-in 的脱敏 fixture + 审查过的期望输出，golden diff 一致。

## 正常场景

| 编号 | 前置条件 | 操作步骤 | 预期结果 | 验证方式 |
|------|---------|---------|---------|---------|
| AC-0003-N-1 | 仓库中存在该 harness 的脱敏 fixture 与审查过的期望输出 | 1. 对 fixture 运行适配器<br>2. 与期望输出 diff | golden diff 完全一致 | 自动化 |

## 异常场景

| 编号 | 前置条件 | 操作步骤 | 预期结果 | 验证方式 |
|------|---------|---------|---------|---------|
| AC-0003-E-1 | fixture 或期望输出未脱敏 / 未经审查 | 1. 提交检查 | 拒绝合入：fixture 必须脱敏，期望输出必须经人审查 | Agent 判定 |

---

# AC-0004: 适配器输出可用（层4）

一个消费方工具只读 AHS 输出（不碰源数据），能把 session 渲染为可读 transcript，并算出含子 session 的总代价。

## 正常场景

| 编号 | 前置条件 | 操作步骤 | 预期结果 | 验证方式 |
|------|---------|---------|---------|---------|
| AC-0004-N-1 | 已有适配器输出的 AHS 数据（含 spawned_by 子 session） | 1. 运行 examples/ 消费方工具<br>2. 渲染 transcript<br>3. 沿 spawned_by 递归聚合 token/cost | transcript 可读完整（含子 session）；总 token/cost 数字与源 harness 自身报告一致 | Agent 判定 |

---

# 元标准

- 适配器实现过程中**未被迫新增字段 / record 类型 / 逃生舱**。
- 出现"属于保留判据但无处安放"的信息 = 模型未定型信号，退回修订 [Spec](../spec/0001-ahs.md) / [ADR](../adr/)，而不是在适配器里打补丁。

# 执行位置

| 层 | 内容 | 执行位置 |
|----|------|---------|
| 层1 合法 | schema 校验 | 常驻 CI |
| 层2 完整 | 语义不变量断言 | 常驻 CI |
| 层3 保真 | golden diff | 经 fixture 进 CI |
| 层4 可用 | 消费方渲染 + 聚合核对 | examples/ 工具手动验证 |
| — | 本机全量真实数据 sweep | 发布前本地检查 |
