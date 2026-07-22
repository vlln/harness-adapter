---
title: Report 01 AHS 核心层（validate + archive + report）
description: 不变量检查器、归档读写、报告消费方正式化完成；51 测试全绿，覆盖率 100%/98.3%（stmts/branch），CI 绿，全部目标 AC PASS。
type: report
status: complete
created: 2026-07-22T10:27:00Z
---

# 01-report: AHS 核心层

---

## 执行摘要

成功。按 Plan 以 TDD 正式化核心层：先写失败测试（import 即红的 red 步），再参考 spike 原型底稿重写实现（spike 分支未合并、未 cherry-pick）。测试不依赖 spike fixture，全部使用手工构建的内存会话（`test/builders.ts` 的 stub HarnessAdapter，同时覆盖 writer 的 adapter 面向 API）。PR #5 CI 绿后 merge 入 develop，分支已删除。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 20c1782 | feat(core): AHS invariant validator, archive writer/reader, report consumer（代码+测试） |
| f219df3 | Merge pull request #5（merge commit，证据链） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 不变量检查器 | src/validate/index.ts | AC-0002 层2 检查：N-1（single-root / parent-resolution / seq-order）、N-2（relation-session / relation-anchor）、N-6（tool-result-match XOR）、N-5（checkIdempotency / stableSerialize / collectSessions） |
| 归档写入 | src/ahs/writer.ts | writeArchive / exportSessions；64 KiB blob 外置（content-addressed + 256 字符 preview）；sanitizeSessionId / desanitizeSessionId 单射可逆；重复导出字节一致 |
| 归档读取 | src/ahs/reader.ts | readManifest / readRecords（zod 校验，非法即抛）/ readBlob（Uint8Array，重哈希完整性校验） |
| 报告消费方 | examples/ahs-report.ts | renderReport：archive-only transcript 渲染（子 session 缩进于锚点 tool_call 下，环防护）+ 跨 session Usage 聚合 |
| Schema 补全 | src/schema/record.ts | 按 spec 最小 record 集补齐 harness_message / goal_update / tool_call.status，ContentBlock 增加 blob_ref 变体 |
| 测试 | test/validate.test.ts（18）、test/ahs-archive.test.ts（10）、test/ahs-report.test.ts（3）、test/builders.ts | 手工内存会话构造器 + 三组 AC 测试 |
| 库入口 | src/index.ts | 增导出 ahs / validate |

---

## 测试摘要

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：**51 tests 全绿**（5 个测试文件）；覆盖率 **100% stmts / 98.3% branch / 100% funcs / 100% lines**（vitest 阈值 ≥80%，远超）
- `npm run test:e2e`（smoke）：通过（库入口 19 个导出）
- ahs-report CLI 手工冒烟（vite-node 跑真实归档目录）：父 session 下子 session 正确缩进渲染于锚点 `→ Task(...)` 之后，聚合 input=8 / output=3 与记录级求和一致
- CI（PR #5, GitHub Actions ubuntu-latest / Node 22）：test job SUCCESS

---

## 验收结果

| AC | 结果 | 证据 |
|----|------|------|
| AC-0002-N-1（因果完整：单根 / parentId 可解析 / seq 单调） | PASS | test/validate.test.ts "AC-0002-N-1" describe：正例 1 + 负例 3（single-root 零根/多根、parent-resolution 悬空、seq-order 非单调），错误码断言精确 |
| AC-0002-N-2（关系完整：spawned_by 锚点可解析） | PASS | test/validate.test.ts "AC-0002-N-2" describe：正例 2（含 toolCallId 锚定 + 省略 toolCallId 的 AC-0002-B-3 形态）+ 负例 2（relation-session 未知 session、relation-anchor 锚点无匹配 tool_call） |
| AC-0002-N-6（tool 配对 XOR） | PASS | test/validate.test.ts "AC-0002-N-6" describe：四情形全覆盖（配对 result / interrupted 无 result 通过；无 result 未标记 / interrupted 却有 result 报错），外加多 result 与孤儿 result 负例 |
| AC-0002-N-5（幂等） | PASS | 两层：validate 层 checkIdempotency 正例（同一 stub adapter 两跑字节一致）+ 负例（输出漂移报 not-idempotent）；归档层 test/ahs-archive.test.ts "re-export over the same outDir is byte-identical"（全目录文件快照逐字节比对） |
| 归档 round-trip | PASS | test/ahs-archive.test.ts：manifest + records 写→读 deep-equal；重读数据过 validateSessions 无错误 |
| blob 外置规则 | PASS | >64 KiB 文本块/tool_result → BlobRef + content-addressed 文件 + readBlob 完整性校验读回一致；恰 64 KiB 保持内联；篡改 blob 内容与篡改 hash 均抛错 |
| sessionId 净化 | PASS | 单射（8 个刁钻输入无碰撞）+ 可逆（desanitize∘sanitize = id，含 `_x41`/`_x5F` 自转义与中文 UTF-8 字节转义）；畸形 `_xHH` 抛错 |
| AC-0004-N-1（可用：渲染 + 聚合） | PASS | test/ahs-report.test.ts：子 session 缩进渲染于锚点 tool_call 之后；totalUsage 精确等于父+子记录级求和（input=127/output=53/reasoning=2/durationMs=500，cost 0.01 USD）；环防护（A↔B 循环报 cycle detected）；未归档 session 抛错；另有 CLI 手工冒烟 |

---

## 遗留问题

- AC-0002-B-1/B-2/B-3（适配器行为边界：interrupted 标记、usage 缺省容忍、无 toolUseId 时省略 toolCallId）由下游适配器容器（0004+）在真实数据上验收；本容器已在检查器中支持对应形态（B-3 正例已测）。
- examples/ 未纳入 vitest 覆盖率统计（vitest.config.mts 仅 include src/**）；ahs-report 的正确性由 test/ahs-report.test.ts 直接驱动 renderReport 覆盖。
