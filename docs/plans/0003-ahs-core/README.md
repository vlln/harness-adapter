# 0003-ahs-core 执行容器

对应分支：`feat/0003-ahs-core`（从 develop 拉出，PR 合并后删除）

阶段：DEVELOP。依据：[spec/0001-ahs.md](../../spec/0001-ahs.md)（active）、[interface/0002-archive.md](../../interface/0002-archive.md)（active）、[ac/0001-adapter-ac.md](../../ac/0001-adapter-ac.md)（active）。

定位：**共享基础层**——全部适配器容器（0004+）依赖本容器。参考底稿：spike/0001-adapter-prototypes 的 `src/validate/`、`src/ahs/`、`examples/ahs-report.ts`（原型代码可参考重写，spike 分支本身不合并）。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-ahs-core.md](01-plan-ahs-core.md) | 不变量检查器 + 归档读写 + 报告消费方，TDD 正式化 | pending | — |

## 下游容器

| 容器 | 内容 | 依赖 |
|------|------|------|
| 0004-claude-code-adapter | Claude Code 正式适配器 | 本容器 |
| 0005-codex-adapter | Codex 正式适配器 | 本容器（可与 0004 并行） |
| 0006-kimi-code-adapter | Kimi Code 正式适配器 | 本容器（可并行） |
| 0007-devin-adapter | Devin 正式适配器 | 本容器（可并行） |
