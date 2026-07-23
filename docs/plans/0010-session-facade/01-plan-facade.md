---
title: Plan 01 Session Facade 实现
description: 按 interface/0003 实现 src/session/（AhsSession/AhsTask/openHarness），投影 + 聚合 + Task 链拼接，TDD。
type: plan
status: pending
created: 2026-07-23T06:30:00Z
---

# Plan 01: Session Facade

## Context

interface/0003（proposed）定义了 langchain 式 facade。底层已就绪：线性 sessions、两维回链、关系存储（src/ahs/relations.ts 的组/HEAD/闭包逻辑可复用）、4 个适配器。

## Request

1. `src/session/`：`AhsSession`（manifest/messages/events/usage/children）、`AhsTask`（groupId/head/members/messages 前缀拼接）、`openHarness` 注册（4 个适配器 + basePath 注入）
2. 投影实现 interface/0003 的规则表（tool 配对在投影内完成；状态类进 events()）
3. Task：组解析（扫 store manifests）+ HEAD（复用 relations 启发式）+ 锚点切分拼接
4. 测试：契约点全覆盖——投影规则逐行、XOR 配对、interrupted 无 result、children 递归、Task 拼接前缀不重复、SessionNotFoundError、跨 store 子 session 跳过。fixture 用 test/builders.ts 风格手工构造（含 fork 组 + invocation 层级）
5. `src/index.ts` 导出 facade

## Output Format

代码 + 测试（feat/0010-session-facade），PR 过门禁。Report：01-report-facade.md（interface/0003 契约点对照 PASS 表 + commit 引用）。

## Constraints

- interface/0003 为 proposed：实现中发现的契约问题回报，不擅自改契约
- 无新运行时依赖

## Checkpoint

CI 绿、覆盖率 ≥80%、Report 完整、check-report 门禁通过。
