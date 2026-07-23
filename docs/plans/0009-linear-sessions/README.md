# 0009-linear-sessions 执行容器

阶段：DEVELOP（设计变更重构）。依据：[adr/0005-linear-sessions.md](../../adr/0005-linear-sessions.md)（accepted）、spec v2、AC v2。

目标：把代码库从 tree 模型重构到线性 session + 两维关系模型。

## 子任务状态表

| Plan | 内容 | 分支 | 状态 | Report |
|------|------|------|------|--------|
| [01-plan-schema-validate.md](01-plan-schema-validate.md) | schema + validate 按 ADR-0005 重构（先行，下游全部依赖） | refactor/0009a-schema-validate | done | [01-report-schema-validate.md](01-report-schema-validate.md) |
| [02-plan-adapters.md](02-plan-adapters.md) | 4 个适配器线性化重构（worktree 并行） | refactor/0009b-{claude-code,codex,kimi-code,devin} | done | 02-report-{claude-code,codex,kimi-code,devin}.md |
| [03-plan-ahs-report.md](03-plan-ahs-report.md) | 关系存储派生索引 + ahs-report 双视图 + 统一 sweep 复跑 | refactor/0009c-ahs-report | done | [03-report-ahs-report.md](03-report-ahs-report.md) |

## 依赖

01 必须先合并；02 四个适配器在 01 之后可并行；03 最后（依赖 01+02）。

## 完成判据

- ADR-0005 验证表全部通过：fixture/golden/不变量全绿；Devin winner 易主仅指针移动；fork-of-subagent 传递继承正确；统一 sweep 对照 0008 基线（0 不变量错误、usage 0 偏差）
- AC v2 全部场景覆盖（N-1 线性、N-2 两链对账、N-7 历史维、B-4 指针稳定性）
