# 0008-system-test 执行容器

对应分支：`test/0008-system-test`（从 develop 拉出，PR 合并后删除）

阶段：SYSTEM_TEST。依据：ac/0001-adapter-ac.md（active）、0002-0007 全部 Report。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-e2e.md](01-plan-e2e.md) | 真实 CLI 端到端（替换 TEST_INFRA 占位冒烟）+ 统一真实数据 sweep + 失败分类 | done | [01-report-system-test.md](01-report-system-test.md) |

## 完成判据

- develop 全量测试层通过（unit + golden + e2e，CI 绿）
- e2e 覆盖：适配器导出 fixture → AHS 归档 → ahs-report CLI 全链路断言
- 统一 sweep：4 个适配器对本机真实数据全量投影，0 不变量错误，usage 对账，结果留档 Report
- 失败原因分类完成（预期无失败；有则按 基建缺陷/设计缺陷/局部 bug 分类）
- 无阻塞级缺陷
