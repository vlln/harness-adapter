# CHANGELOG

项目版本变更记录，遵循 [Keep a Changelog](https://keepachangelog.com/) 规范。文档与代码的变更分别记录，各自独立 Commit，在此汇总。

---

## [0.1.0] - 2026-07-24

首个发布。定义 AHS（Agent History Standard）格式规范，并提供 7 个 Harness 的只读投影适配器、可选归档层与消费方 facade。

### Added

**AHS 核心（src/schema、src/store、src/validate）**

- AHS zod schema（Manifest / Record / Relation / Usage / Blob，zod v4，可导出 JSON Schema）：线性 session 记录模型（仅 `seq`）、`lineage`/`invocation` 两槽表达历史与调用两维关系、`tool_result.sessionIds` 多值正链、`atRecordId` 三态锚点（ADR-0005）
- `HarnessAdapter` 只读接口（listSessions / readRecords 流式）
- AC v2 不变量校验器（含跨 session 正/回链对账、幂等性检查）

**适配器（src/adapters）**

- 7 个正式只读适配器：claude-code、codex、kimi-code、devin、qwen、grok、pi
- 真实数据 sweep 基线：claude-code / codex / kimi-code / devin 四家 1,341 session / 356,827 records / 0 错误，usage 对账 0 偏差；grok 9 session、pi 184 session、qwen 2 session 均 0 错误

**归档层与消费方（src/ahs、src/session、examples）**

- AHS 归档 writer/reader + relations 派生索引（可选持久化 profile，interface/0002）
- Session facade（interface/0003）：langchain 风格 openHarness / loadSession / loadTask 双视图，messages 投影、usage 聚合、children 递归
- examples/ahs-report：Task 视图 HEAD 链拼接报告 CLI（含 --all）

**工程基建**

- GitHub Actions CI（tsc + vitest + v8 覆盖率 ≥80% + e2e）、develop 分支保护、Report 提测门禁脚本
- 系统测试 e2e：7 条适配器 → 归档 → ahs-report 全链路
- devloop 文档体系：vision / spec / AC / ADR（0001-0005）/ interface（0001-0003）/ 13 个执行容器（Plan + Report）
