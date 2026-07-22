---
title: 01-report CI 流水线
description: GitHub Actions CI + v8 覆盖率阈值搭建完成，本地与远程均验证通过，阈值门禁自证变红。
type: report
status: complete
created: 2026-07-22T08:01:49Z
---

# 01-report: CI 流水线

---

## 执行摘要

成功。CI 工作流、v8 覆盖率配置（四项阈值 ≥ 80%）、`@vitest/coverage-v8` 依赖、CONTRIBUTING.md 测试段均完成；本地与 GitHub Actions 上全绿，阈值门禁经强制变红自证生效。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 420a8f6 | test: TEST_INFRA 基建——覆盖率阈值、CI 工作流、e2e 冒烟、提测门禁脚本 |
| c2bcb9b | docs: CONTRIBUTING 测试段补充覆盖率/e2e/提测门禁命令 |
| f4c48c3 | Merge pull request #1（ci/0002-test-infra → develop，merge commit） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| CI 工作流 | `.github/workflows/ci.yml` | push(develop) + PR(develop) 触发；Node 22.x；npm ci → tsc --noEmit → vitest run --coverage → test:e2e |
| vitest 配置 | `vitest.config.mts` | coverage provider v8，include `src/**`，statements/branches/functions/lines 阈值 ≥ 80 |
| 依赖 | `package.json` / `package-lock.json` | `@vitest/coverage-v8@3.2.7`（与 vitest 3.2.7 对齐；v4 与 vitest 3 peer 冲突，故锁 3.x） |
| 库入口测试 | `test/index.test.ts` | 冒烟导入 src/index.ts，使入口与纯类型 store 模块纳入覆盖 |
| CONTRIBUTING | `CONTRIBUTING.md` 第六节 | 覆盖率/e2e/提测门禁命令 + 测试目录表 |

---

## 测试摘要

- 本地 `npx vitest run --coverage`：20 tests passed；覆盖率 **statements 100% / branches 100% / functions 100% / lines 100%**（132 statements, 0 branches, 0 functions —— schema 为纯声明式 zod 定义）。
- 阈值自证：临时将 coverage include 扩到未覆盖的 `scripts/**` → lines/statements 降至 68.39%，vitest 输出 `ERROR: Coverage ... does not meet global threshold (80%)` 并非零退出；恢复后全绿。
- CI 远程验证：
  - PR #1 检查运行（success）：https://github.com/vlln/harness-adapter/actions/runs/29901827795
  - develop 合并后 push 运行（success）：https://github.com/vlln/harness-adapter/actions/runs/29902033763

---

## 验收结果

TEST_INFRA 门禁表对应项：

| 门禁项 | 结果 | 证据 |
|--------|------|------|
| CI 流水线可运行 | [适用] 通过 | 上述两个成功 run |
| CONTRIBUTING.md 测试段已填写 | 通过 | c2bcb9b |
| 系统测试框架可跑冒烟 | 通过 | `npm run test:e2e` 本地与 CI 均 OK；框架占位说明见 test/e2e/smoke.ts 头部注释 |

说明：本 Plan 为适配器验收标准（如 AC-0001-N-1、AC-0002-B-1 等）提供 CI 与覆盖率基建支撑；AC 本身的验收属于 DEVELOP 阶段，不在本报告范围内。

---

## 遗留问题

- `@vitest/coverage-v8` 锁在 3.x（v4 要求 vitest 4）；未来升级 vitest 4 时同步升级。
- 无系统测试真实用例：`test/e2e/smoke.ts` 为框架占位，真实 CLI e2e 用例随适配器与 `examples/ahs-report.ts` 在 DEVELOP 落地（spike 分支不合并）。
