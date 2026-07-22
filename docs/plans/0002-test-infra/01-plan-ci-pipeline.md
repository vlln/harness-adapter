---
title: Plan 01 CI 流水线
description: GitHub Actions 工作流：tsc + vitest + v8 覆盖率阈值；固定 Node 22；push/PR 触发。
type: plan
status: pending
created: 2026-07-22T07:33:05Z
---

# Plan 01: CI 流水线

## 步骤

1. `.github/workflows/ci.yml`：on push (develop) + pull_request (develop)；job: checkout → setup-node 22.x + cache npm → `npm ci` → `npx tsc --noEmit` → `npx vitest run --coverage`
2. `vitest.config.mts`（或 package.json 配置）：coverage provider v8，thresholds statements/branches/functions/lines ≥ 80，include `src/**`
3. 安装 `@vitest/coverage-v8` devDependency
4. CONTRIBUTING.md 测试段补充覆盖率命令 `npx vitest run --coverage`
5. 本地验证：coverage 可运行且阈值生效（故意调低覆盖率确认变红——自证项在 Plan 02 统一做）

## 验收

- 本地 `npx vitest run --coverage` 通过且输出阈值报告
- workflow 语法有效（actionlint 或 push 后实际触发验证）
