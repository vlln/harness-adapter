## 执行容器列表

| 编号 | 标题 | 状态 | 创建时间 |
|------|------|------|----------|
| [0001](0001-template/) | 模板（参考用） | template | — |
| [0002](0002-test-infra/) | 测试基建（CI + 提测门禁） | done | 2026-07-22 |
| [0003](0003-ahs-core/) | AHS 共享核心层 | done | 2026-07-22 |
| [0004](0004-claude-code-adapter/) | Claude Code 适配器 | done | 2026-07-22 |
| [0005](0005-codex-adapter/) | Codex 适配器 | done | 2026-07-22 |
| [0006](0006-kimi-code-adapter/) | Kimi Code 适配器 | done | 2026-07-22 |
| [0007](0007-devin-adapter/) | Devin 适配器 | done | 2026-07-22 |
| [0008](0008-system-test/) | 系统测试 | done | 2026-07-22 |
| [0009](0009-linear-sessions/) | 线性 session 重构（ADR-0005） | done | 2026-07-23 |
| [0010](0010-session-facade/) | Session facade | done | 2026-07-23 |
| [0011](0011-qwen-adapter/) | Qwen Code 适配器 | done | 2026-07-23 |
| [0012](0012-grok-adapter/) | Grok 适配器 | done | 2026-07-23 |
| [0013](0013-pi-adapter/) | Pi Agent 适配器 | done | 2026-07-23 |
| [0014](0014-read-manifest/) | readManifest 实现 | pending | 2026-07-24 |

## 状态说明

| 状态 | 含义 |
|------|------|
| pending | 未执行 |
| done | 已执行（无论成功/失败） |


## 规则

- 执行容器由各阶段根据 Spec 模块划分自行创建
- Agent 权限边界见 [AGENTS.md](../../AGENTS.md)
- 状态在执行容器的 README.md 和本 README 中维护，执行容器原地保留
