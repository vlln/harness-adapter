# CHANGELOG

项目版本变更记录，遵循 [Keep a Changelog](https://keepachangelog.com/) 规范。文档与代码的变更分别记录，各自独立 Commit，在此汇总。

---

## [0.3.0] - 2026-07-24

HarnessAdapter 接口补全 `readManifest(sessionId)`——O(1) 单 session manifest 查询，不再遍历 listSessions。

### Added

- `HarnessAdapter.readManifest(sessionId): Promise<Manifest>` 接口方法（interface/0001 契约更新）
- 全部 7 个 adapter 实现 readManifest
- `examples/ahs-export.ts` CLI：从 native 存储导出 session 为 AHS 磁盘格式（ahs-report 的逆向）

### Changed

- `writeArchive`：从 listSessions 遍历改为 `adapter.readManifest(sessionId)` 直接调用
- `facade.loadSession` / `facade.loadTask`：同上，不再全量扫描 listSessions
- codex adapter：提取 `projectAllManifests()` 共享于 listSessions 和 readManifest

### 契约文档

- interface/0001：readManifest 方法 + readRecords 签名修正（补 branchName、seq→file order）
- AC-0001-N-2/E-2、AC-0002-N-8 新增 readManifest 验收场景
- 移除 stale AC-0002-N-7 重复（引用退役的 rewound_from/root）

## [0.2.0] - 2026-07-24

ADR-0006 多分支 session 目录模型。从 v0.1.0 的"扁平 session + 跨 session lineage 回链"重构为"session = 目录 + 多分支 JSONL"。

### Changed

**ADR-0006 多分支 session 目录模型（breaking）**

- Session = 目录（`manifest.json` + `records/<branch>.jsonl`），rewind = session 内分支（`branches` 注册表），不再跨 session
- Fork = 新 session 目录，`lineage: { type: "forked_from" }` 为元信息
- `rewound_from` / `sibling_attempt` lineage 类型退役
- `root` 字段退役（session 目录自包含所有分支）
- `relations.jsonl` / group / closure 退役（全部可从 manifest 直读）
- `HEAD` 显式化为 manifest 字段（`{ branch, recordId }`）
- `readRecords(sessionId, branchName?)` 新增分支参数

**Record 退役 `seq` 字段（breaking）**

- 行序即记录序，`seq` 冗余删除
- `checkLinear` 不变量退役

### Fixed

- Pi `parentSession` 跨文件指针映射为 `lineage: forked_from`（ADR-0006 下 fork 的标准模式）
- Pi cost 不再假设 `currency: "USD"`——源端无 currency 时 omit 整个 cost 对象（不留逃生舱）

### 契约文档

- spec v4、ADR-0006 accepted、ADR-0005 superseded、AC 更新
- interface/0003 session facade → active

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
