---
title: Plan 02 门禁与自证
description: 提测门禁脚本、develop 分支保护（MR 门禁）、TEST_INFRA 门禁表全部自证项。
type: plan
status: pending
created: 2026-07-22T07:33:05Z
---

# Plan 02: 门禁与自证

## 步骤

1. `scripts/check-report.ts`：扫描 docs/plans/*/ 的 Report 文件——frontmatter 齐备（type: report）、AC 编号标注（匹配 `AC-\d{4}-[NBEF]-\d+`）、commit 引用存在；任一缺失非零退出
2. 本地验证门禁脚本：构造不达标 Report（缺 AC 标注）确认报错；通过后清理
3. push develop 到 origin；`gh` 配置 develop 分支保护：require status checks（CI job）before merge
4. MR 门禁自证：从 develop 拉临时分支提交一个故意失败的测试 → push → 开 PR → 确认 CI 报红且合并被阻断 → 关闭 PR、删除分支（不合并）
5. 覆盖率准确性自证：对 src/schema 已知基线跑覆盖率，与人工统计比对（记录数字于 Report）
6. 系统测试冒烟自证：vite-node 运行 examples/ahs-report.ts 对 spike fixture 归档（若 spike 未合并，用 test fixtures 现场导出）确认启动成功
7. 写 01-report / 02-report，更新容器 README 状态表

## 验收

- TEST_INFRA 门禁表（phase-test-infra.md）逐项通过并留证
- 分支保护在 GitHub 上可见生效
