---
title: Plan 01 AHS 核心层（validate + archive + report）
description: 正式实现不变量检查器、AHS 归档读写（含 blob 外置）、报告消费方；TDD；覆盖率 ≥80%。
type: plan
status: done
created: 2026-07-22T10:10:23Z
---

# Plan 01: AHS 核心层

## Context

契约已冻结。spike 分支的 `src/validate/`、`src/ahs/`、`examples/ahs-report.ts` 是经过 4 个 harness 真实数据验证的原型底稿（可参考重写，不合并 spike）。本 Plan 将核心层正式化，作为全部适配器容器的共享依赖。

## Request

1. `src/validate/`：AC-0002 全部不变量的 harness 无关检查器——N-1 因果完整（单根、parentId 可解析、seq 单调）、N-2 关系完整（spawned_by 锚点）、N-6 tool 配对 XOR、N-5 幂等辅助。错误分级：error（违反不变量）。
2. `src/ahs/`：归档读写，契约见 interface/0002——writeArchive/exportSessions/readManifest/readRecords/readBlob；64 KiB blob 外置（content-addressed + 256 字符 preview + 完整性校验）；sessionId 目录名净化（单射可逆）；重复导出字节一致。
3. `examples/ahs-report.ts`：AC-0004 消费方——transcript 渲染（含 spawned_by 递归缩进、环防护）+ 跨 session Usage 聚合。
4. 测试覆盖 AC-0002 各不变量的正/负例、归档 round-trip、blob 规则、report 聚合正确性。

## Output Format

- 代码 + 测试（test/ 下），PR 过 MR 门禁（CI 绿、覆盖率 ≥80%）
- Report：01-report-ahs-core.md，标注 AC-0002-N-1/N-2/N-5/N-6、AC-0004-N-1 验收结果 + 关联 commit

## Constraints

- 不修改 active 契约文档；发现契约问题停止并上报（退回 DESIGN 流程）
- 不合并/不 cherry-pick spike 分支；代码可参考重写
- 无新运行时依赖（node:crypto / node:fs 即可）

## Checkpoint

CI 绿、覆盖率 ≥80%、全部测试通过、Report 完整且提测门禁脚本通过。
