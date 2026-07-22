---
title: ADR-0003 技术选型：TypeScript strict + zod v4
description: AHS schema 用 TypeScript strict + zod v4 定义（可导出 JSON Schema），适配器接口为 AsyncIterable 只读接口，先行冻结。
type: adr
status: proposed
created: 2026-07-21T11:48:45Z
---

# ADR-0003: 技术选型——TypeScript strict + zod v4

---

## 背景

AHS 需要一份机器可校验的 schema 定义，作为适配器输出合法性（AC 层1）的检查基础，并能导出为语言中立的格式供非 TS 消费方使用。适配器接口需要支持大会话的流式读取，且与"只读投影"（ADR-0001）的架构约束一致。

---

## 决策内容

- **TypeScript strict 模式 + ESM** 作为实现语言。
- **zod v4** 定义全部 AHS schema（Manifest / Record / Relation / Usage / Blob），利用其 JSON Schema 导出能力供非 TS 消费方使用。
- 适配器接口为 **AsyncIterable 只读接口**（`listSessions` / `readRecords`），先行冻结（见 [interface/0001-harness-adapter.md](../interface/0001-harness-adapter.md)）；写接口、控制面接口均不定义。

---

## 备选方案

### 方案 A: 纯 JSON Schema 先行，语言绑定后置

- 优点：语言中立性最强，规范即 JSON Schema
- 缺点：TS 侧需额外代码生成步骤；类型与校验两份事实源易漂移

### 方案 B: Rust / Go 实现核心库

- 优点：性能、单二进制分发
- 缺点：目标生态（obsidian 插件、ACP 工具链、评测脚本）以 TS/Python 为主；Harness 存储格式多为 JSONL，性能非瓶颈

---

## 选择理由

zod 单一事实源同时给出 TS 类型与运行时校验，可导出 JSON Schema 覆盖中立性需求（方案 A 的优势），无代码生成漂移问题。AsyncIterable 天然适配 JSONL append-only 的 record 流，且让"只读"在类型层面可强制（无 write 方法）。TS 与主要消费方生态一致。

---

## 验证

| 验证项 | 复现步骤 | 结论 | 经验 | 验证 Branch |
|--------|---------|------|------|------------|
| schema 骨架可编译、可校验 | `npx tsc --noEmit` + `npx vitest run`（test/schema.test.ts） | 已通过（INIT 时全绿） | zod v4 discriminated union 覆盖全部 record 类型 | —（develop 直接验证） |

---

## 后果

### 正面

- schema、类型、校验单一事实源
- JSON Schema 导出保留语言中立通道
- 只读在类型层面可强制

### 负面

- 非 TS 消费方依赖 JSON Schema 导出质量，需后续验证
- zod 主版本升级（v4 仍较新）有迁移风险

---

## 约束范围

src/ 全部代码；package.json 依赖；[interface/0001-harness-adapter.md](../interface/0001-harness-adapter.md)。

---

## 约束规则

| 规则编号 | 规则 | 适用范围 | 违反时如何检出 |
|----------|------|---------|--------------|
| AR-001 | 全部 schema 用 zod 定义，禁止手写 interface 作为数据契约 | src/schema/ | code review |
| AR-002 | TypeScript strict 不得关闭；不得新增 `any`/`@ts-ignore` | src/、test/ | `tsc --noEmit` + code review |
| AR-003 | 适配器接口只读：HarnessAdapter 不得出现写方法 | src/store/ | 接口审查 |
