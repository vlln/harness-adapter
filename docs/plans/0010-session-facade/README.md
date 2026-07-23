# 0010-session-facade 执行容器

对应分支：`feat/0010-session-facade`（从 develop 拉出，PR 合并后删除）

阶段：DEVELOP。依据：[interface/0003-session-facade.md](../../interface/0003-session-facade.md)（proposed）、spec v2、ADR-0005（accepted）。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-facade.md](01-plan-facade.md) | src/session/ facade 实现 + openHarness 注册 + 测试 | pending | — |

## 完成判据

- interface/0003 全部契约点有测试覆盖（投影规则、children、Task HEAD 链、错误语义）
- CI 绿、覆盖率 ≥80%
