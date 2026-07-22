# 0004-claude-code-adapter 执行容器

对应分支：`feat/0004-claude-code-adapter`（从 develop 拉出，PR 合并后删除）

阶段：DEVELOP。依据：spec/0001-ahs.md、interface/0001-harness-adapter.md、ac/0001-adapter-ac.md（均 active）。共享层：0003-ahs-core（已完成）。参考底稿：spike/0001-adapter-prototypes 的 `src/adapters/claude-code/`（参考重写，不合并 spike）。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-claude-code.md](01-plan-claude-code.md) | Claude Code 正式适配器（graph + sidechain 拆分） | done | [01-report-claude-code.md](01-report-claude-code.md) |

## 适配器要点

- 存储：`~/.claude/projects/<dir>/<uuid>.jsonl` + `<uuid>/subagents/agent-*.jsonl` + `.meta.json`
- sidechain → 独立子 session + spawned_by（toolUseId 锚点，sourceToolUseID 回退）
- `isCompactSummary` → compaction；`type:"summary"` 行 → Manifest.title（generated）；goal_status attachment → goal_update（sentinel→pending，met→met/unmet）
- usage 映射 Anthropic 格式；丢弃 system/mode/permission-mode/queue-operation 等过程记录
