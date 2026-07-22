---
title: 02-report 门禁与自证
description: 提测门禁脚本、develop 分支保护（MR 门禁）与 TEST_INFRA 全部自证项完成并留证。
type: report
status: complete
created: 2026-07-22T08:01:49Z
---

# 02-report: 门禁与自证

---

## 执行摘要

成功。提测门禁 `scripts/check-report.ts` 落地并经坏 Report 植入自证拦截；develop 分支保护生效（required status check `test`，enforce_admins）；MR 门禁经故意失败测试的 PR 自证拦截（CI 报红 + 合并被拒）；覆盖率数据经人工统计比对确认准确。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 420a8f6 | test: TEST_INFRA 基建（含 scripts/check-report.ts） |
| c2bcb9b | docs: CONTRIBUTING 测试段补充 |
| f4c48c3 | Merge pull request #1（ci/0002-test-infra → develop） |
| 116a916 | test/0003-gate-selfproof: 故意失败的测试（自证用，已随分支删除，未合并） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 提测门禁 | `scripts/check-report.ts` | 校验 docs/plans 下 `*-report-*.md`：frontmatter（type: report / status / created）、AC 编号（`AC-\d{4}-[NBEF]-\d+`）、commit 引用（7–40 hex）；任一缺失 exit 1 |
| 分支保护 | GitHub repo 设置 | develop：required status check `test`，enforce_admins=true，无必需 review（单 Maintainer） |

### check-report 设计决策

- **Vacuous pass**：无 Report 存在时门禁通过。门禁保证的是"已写 Report 的完整性"；Plan 是否产出 Report 由容器 README 状态表审查保证。
- **跳过 `*-template` 容器**：模板 Report 是写作占位（status: draft、无 commit），不是执行产物。
- **TEST_INFRA 报告的 AC 引用**：本阶段无独立 AC 文档，报告引用其提供基建支撑的适配器 AC 编号；AC 验收本身在 DEVELOP 进行。

---

## 测试摘要

### 自证 1：提测门禁正确拦截（Plan 02 步骤 2）

植入 `docs/plans/0002-test-infra/99-report-bad.md`（frontmatter 齐备但无 AC 编号、无 commit 引用）：

```
[check-report] FAIL — 2 violation(s):
  .../99-report-bad.md: no AC id matching AC-\d{4}-[NBEF]-\d+
  .../99-report-bad.md: no commit reference (7-40 hex)
EXIT=1
```

删除后恢复 vacuous pass：`OK — 0 report(s) validated (vacuous pass, none exist yet)`。

### 自证 2：MR 门禁正确拦截（Plan 02 步骤 4）

分支 `test/0003-gate-selfproof`（commit 116a916，故意失败测试 `expect(1+1).toBe(3)`）→ PR #2：

- CI 报红：run 29902198447（failure）https://github.com/vlln/harness-adapter/actions/runs/29902198447/job/88865250627
- `gh pr checks 2` → `test  fail`
- `gh pr view 2` → `mergeStateStatus: BLOCKED`
- `gh pr merge 2 --merge` 被拒：`Pull request #2 is not mergeable: the base branch policy prohibits the merge.`（exit 1）
- 随后关闭 PR、删除远程+本地分支，未合并。

注：PR #2 首次创建时 CI 未触发——当时工作流文件尚未随 PR #1 合并到 develop（pull_request 工作流取自 base 分支）。先合并 PR #1 后 synchronize 触发，自证顺序相应调整，结论不受影响。

### 自证 3：覆盖率数据准确（Plan 02 步骤 5）

对 `src/schema/usage.ts` 人工统计 vs v8 报告：

| 指标 | 人工统计 | v8 报告 | 结论 |
|------|---------|---------|------|
| branches | 0（无任何条件/分支结构） | 0 | 一致 |
| functions | 0（纯声明式 zod 定义，无函数体） | 0 | 一致 |
| statements | 逻辑语句 10（1 import + 1 const 声明 + 8 个属性初始化调用链） | 15 | 粒度差异：v8 按子表达式段计数（每个调用链计多段）；覆盖判定（100%）两者一致 |

覆盖率采集与人工统计的语义结论一致，无失真。develop 基线：四项指标 100%（132 statements / 0 branches / 0 functions）。

### 自证 4：系统测试冒烟（Plan 02 步骤 6）

`npm run test:e2e`（vite-node 运行 test/e2e/smoke.ts）本地与 CI 均通过。deviation：ADR/Plan 原文为"vite-node 运行 examples/ahs-report.ts 对 fixture 归档"——该 CLI 在未合并的 spike 分支上，故按 devloop 规则以框架级冒烟占位（框架须在空用例下可启动），真实 CLI 用例随适配器在 DEVELOP 落地。

---

## 验收结果

TEST_INFRA 门禁表（phase-test-infra）逐项：

| 门禁项 | 结果 | 证据 |
|--------|------|------|
| 测试基建 ADR 全部 proposed | 通过 | docs/adr/0004-test-infra.md status: proposed |
| CONTRIBUTING.md 测试段已填写 | 通过 | c2bcb9b |
| CI 流水线可运行 | 通过 | run 29901827795 / 29902033763（success） |
| MR 门禁正确拦截 | 通过 | 自证 2（PR #2 报红 + 合并被拒） |
| 提测门禁正确拦截 | 通过 | 自证 1（植入坏 Report exit 1） |
| 覆盖率数据准确 | 通过 | 自证 3 |
| 系统测试框架可跑冒烟 | 通过 | 自证 4 |
| 部署底座可通 | N/A | 库项目无服务部署（ADR-0004 决策表） |
| Mock 返回正确 / 付费依赖 / 沙箱账号 | N/A | 零网络调用、零付费依赖（ADR-0004） |
| 系统测试脚本对齐 AC | N/A（本阶段） | 真实系统测试用例属 DEVELOP；届时逐条对齐 AC-0001 ~ AC-0004 |
| 所有执行容器已创建 | 通过 | docs/plans/0002-test-infra/ |
| 一次性基建 Plan 全部 done | 通过 | 容器 README 状态表（本 commit） |

本 Plan 为适配器 AC（如 AC-0001-N-1、AC-0002-B-1、AC-0003-E-1、AC-0004-N-1）提供门禁与自证基建；AC 验收本身属 DEVELOP 阶段。

---

## 遗留问题

- 分支保护启用后，直接 push develop 被 required status check 阻断（含 docs-only 提交）——后续所有 develop 变更（含文档）一律走 PR。
- check-report 的 frontmatter 解析为简易实现（非完整 YAML），当前模板格式下足够；若 frontmatter 复杂化需引入 YAML parser。
