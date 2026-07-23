# 0013-pi-adapter 执行容器

对应分支：`feat/0013-pi-adapter`。阶段：DEVELOP。依据：spec v2、interface/0001、ac v2（均 active）。共享层已就绪。调研：docs/research/schemas/pi-agent-schema.md（最简单的 harness）。移植蓝本：obsidian-harness-frontend importer `_parse_pi`。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| 01-plan-pi.md | Pi Agent 适配器（最简 tree，含 cost） | pending | — |

## 适配器要点

- 存储：`~/.pi/agent/sessions/--<cwd>--/<iso-ts>_<ulid>.jsonl`（单文件，protocol version 3）
- Tree（parentId）→ 线性化；首条 `session` record → Manifest（cwd、id、时间）
- `model_change` / `thinking_level_change` → model_change record（thinkingLevel 丢弃）
- usage 最全的一家：含 `cost` 明细 → Usage.cost（唯一有 cost 的 harness，验证 cost 映射的标杆）
- 双时间戳（record ISO + message Unix ms）→ 统一 ISO
