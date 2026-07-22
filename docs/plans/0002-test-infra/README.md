# 0002-test-infra 执行容器

对应分支：`ci/0002-test-infra`（从 develop 拉出，完成后合并回 develop 并删除）

阶段：TEST_INFRA。依据：[adr/0004-test-infra.md](../../adr/0004-test-infra.md)

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-ci-pipeline.md](01-plan-ci-pipeline.md) | GH Actions 工作流 + 覆盖率阈值 + Node 版本固定 | pending | — |
| [02-plan-gates.md](02-plan-gates.md) | 提测门禁脚本 + MR 门禁（分支保护）+ 全部自证 | pending | — |

## 完成判据

TEST_INFRA 门禁表全部通过（见 phase-test-infra）：CI 可运行、MR 门禁正确拦截、提测门禁正确拦截、覆盖率数据准确、系统测试冒烟通过、CONTRIBUTING.md 测试段非空。
