# ADR 目录

## 决策列表

| 编号 | 标题 | 状态 | 关联 Spec |
|------|------|------|-------------|
| [0001](0001-lossy-projection.md) | 有损投影：AHS 是交换/消费格式而非备份 | accepted | [0001-ahs](../spec/0001-ahs.md) |
| [0002](0002-session-relation-model.md) | Session/Relation 两实体模型 | superseded | [0001-ahs](../spec/0001-ahs.md) |
| [0003](0003-typescript-zod.md) | 技术选型：TypeScript strict + zod v4 | accepted | [0001-ahs](../spec/0001-ahs.md) |
| [0004](0004-test-infra.md) | 测试基建：vitest + golden + e2e | accepted | [0001-ahs](../spec/0001-ahs.md) |
| [0005](0005-linear-sessions.md) | 线性 Session 与两维关系 | superseded | [0001-ahs](../spec/0001-ahs.md) |
| [0006](0006-multi-branch-directory.md) | 多分支 Session 目录模型 | accepted | [0001-ahs](../spec/0001-ahs.md) |

## 状态说明

| 状态 | 含义 |
|------|------|
| draft | 草稿，编写中 |
| proposed | 编写完成，待门禁审查 |
| accepted | 审查通过，当前生效 |
| superseded | 被新版 ADR 替代 |
| deprecated | 已废弃，不再适用 |