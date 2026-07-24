---
title: Report 01 系统测试：真实 e2e + 统一 sweep
description: TEST_INFRA 占位冒烟替换为 4 适配器全链路 CLI e2e（适配器→归档→ahs-report），统一真实数据 sweep 1,331 session / 353,644 record 零错误，usage 对账 0 失配，无失败、无阻塞级缺陷。
type: report
status: complete
created: 2026-07-22T12:30:00Z
---

# 01-report: 系统测试

---

## 执行摘要

成功。两项工作均完成：

1. **真实 e2e**：`test/e2e/adapter-chains.ts` 对 4 个正式适配器各跑全链路——适配器读仓库内合成 fixture → `exportSessions` 导出 AHS 归档到 temp → 以真实 CLI 子进程（vite-node）运行 `examples/ahs-report.ts` → 断言退出码 0、stdout 含 transcript 结构（tool-call 行、spawned 子 session 缩进渲染）、`total:` 聚合数字与 record 级独立求和完全一致。原 smoke 保留为框架活性检查；`npm run test:e2e` = smoke + adapter-chains，CI 本已执行该脚本，无需改 workflow。
2. **统一 sweep**：临时脚本（用后已删除，未提交任何真实数据）对 4 个 Harness 本机真实存储快照全量投影——1,331 个 session、353,644 条 record，**0 zod 错误、0 不变量错误、usage 对账 0 失配**。无失败，无需分类；无阻塞级缺陷。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| da572ba | test(e2e): real adapter-to-archive-to-report chains for all adapters（test/0008-system-test，PR #15 合并为 fc9e11e） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 真实 e2e | test/e2e/adapter-chains.ts | 4 适配器全链路 CLI 用例（vite-node 脚本，非 vitest） |
| smoke（保留） | test/e2e/smoke.ts | 框架活性检查；过期占位注释已更新 |
| npm 脚本 | package.json `test:e2e` | `vite-node smoke.ts && vite-node adapter-chains.ts`；CI（.github/workflows/ci.yml）原样执行 |
| sweep 脚本 | （临时，已删除） | scripts/sweep-0008-tmp.ts，对快照目录投影；未提交 |

---

## e2e 结果（逐适配器）

每个用例断言：退出码 0；stdout 含 `# <sessionId> [<harness> …]` 头、tool-call 行（`→ name(...)`）与 tool-result 行（`⤷`）；有子代理的 fixture 断言子 session 以 `  # <childId>` 缩进渲染；`== cost summary (N session(s)) ==` 的 N 等于 spawned_by 图可达 session 数；`total:` 行的 input/output/cacheRead/cacheWrite/reasoning 五项与测试内独立解析 records.jsonl 的 record 级求和逐项相等。

| 适配器 | 根 session | spawned 子 session | 额外结构断言 | 结果 |
|--------|-----------|-------------------|-------------|------|
| claude-code | 22222222-…（fixture B） | abc123（Task 锚定） | `→ Task(`、子代理任务文本 | PASS |
| codex | 019f8000-…a1 | 019f8000-…b2（thread_spawn 锚定） | `→ spawn_agent(` | PASS |
| kimi-code | 11111111-…5555 | …/agent-0（无 toolCallId 锚，排在父记录后） | 子 session 缩进头 | PASS |
| devin | sunny-forest | 无（sibling_attempt 不入聚合，符合设计） | tool-call/result 行 | PASS |

4/4 PASS。e2e 只使用仓库内合成 fixture，无任何真实数据。

---

## 统一真实数据 sweep

方法：先将 4 个存储快照到 temp（`~/.claude/projects`、`~/.codex/sessions`、`~/.kimi-code/sessions` 整树复制；`~/.local/share/devin/cli/sessions.db` 复制文件）——本机 kimi-code 处于活跃写入状态（本次执行本身即产生会话），快照消除投影过程中的 live-file 增长。投影在快照上进行，结束后快照与脚本一并删除。指标：`collectSessions` 全量收集 → zod 逐条校验（ManifestSchema/AhsRecordSchema）→ `validateSessions` 层二不变量 → usage 对账（record 级求和 vs `manifest.stats.totalUsage`，三 JSONL 适配器均定义其为 record 求和，必须逐项相等）。

| Harness | Sessions | Records | zod 错误 | 层二不变量错误 | usage 对账（含 stats 的 session 数 / 字段失配数） |
|---------|----------|---------|---------|--------------|--------------------------------|
| claude-code | 175 | 66,299 | 0 | 0 | 165 / 0 |
| codex | 235 | 207,656 | 0 | 0 | 149 / 0 |
| kimi-code | 869 | 77,464 | 0 | 0 | 833 / 0 |
| devin | 52 | 2,225 | 0 | 0 | 22 / 0 |
| **合计** | **1,331** | **353,644** | **0** | **0** | **1,169 / 0** |

Token 总量（record 级求和 = stats 求和，逐项一致）：

- claude-code：input 1,807,790,717 / output 7,210,632 / cacheRead 2,345,094,903 / cacheWrite 154,939,033
- codex：input 5,542,124,955 / output 18,572,879 / cacheRead 5,253,921,664 / reasoning 3,484,260
- kimi-code：input 90,044,843 / output 9,275,127 / cacheRead 1,976,470,925
- devin：input 15,049 / output 548,740 / cacheRead 80,569,504 / cacheWrite 3,071,947；会话级 credit cost 按设计仅挂在 manifest（`metadata.total_credit_cost` → stats.totalUsage.cost），6 个 session 合计 0 credit，不参与 record 级对账

---

## 失败原因分类

无失败。e2e 4/4 一次通过；sweep 0 zod 错误、0 不变量错误、0 对账失配。无 基建缺陷 / 设计缺陷 / 局部 bug 需记录。

## 阻塞级缺陷判定

**无阻塞级缺陷。** 4 个适配器在合成 fixture 与本机真实数据上均满足四层验收，系统测试通过，SYSTEM_TEST 阶段完成判据全部满足。

---

## 测试摘要

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：**147 tests 全绿**（13 文件）；覆盖率 **97.96% stmts / 86.22% branch / 100% funcs / 97.96% lines**（阈值 ≥80%）
- `npm run test:e2e`：smoke OK + 4 条适配器链路 OK
- CI：PR #15 status check `test` 绿，mergeStateStatus CLEAN 后合并
- `node scripts/check-report.ts`：通过

---

## 验收结果

| AC | 结果 | 证据 |
|----|------|------|
| AC-0001-N-1（zod 合法） | PASS | 统一 sweep：353,644 条 record + 1,331 个 manifest 全过 zod，0 错误 |
| AC-0002-N-1/N-2/N-6（树/关系/工具配对不变量） | PASS | 统一 sweep：validateSessions 对 4 家全量真实投影 0 错误 |
| AC-0002-N-4（usage 记账） | PASS | 统一 sweep：record 级求和与 stats.totalUsage 逐项相等，1,169 session 0 失配 |
| AC-0004-N-1（消费可用） | PASS | e2e：ahs-report CLI 子进程仅读归档渲染 4 家 fixture transcript，聚合数字与独立求和一致（在单测 test/ahs-report.test.ts 与各 *-report.test.ts 之上补足真实 CLI 链路） |
