# 0011-qwen-adapter 执行容器

对应分支：`feat/0011-qwen-adapter`。阶段：DEVELOP。依据：spec v2、interface/0001、ac v2（均 active）。共享层已就绪。调研：docs/research/schemas/qwen-schema.md。参考：spike 无（首家无 spike 底稿的适配器）；obsidian-harness-frontend importer 的 `_parse_*` 无 Qwen。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-qwen.md](01-plan-qwen.md) | Qwen Code 适配器（Google parts[] + 全局 usage join） | done | [01-report-qwen.md](01-report-qwen.md) |

## 适配器要点

- 存储：`~/.qwen/projects/-<cwd>-/chats/<uuid>.jsonl` + `<uuid>.runtime.json` + 全局 `usage/token-usage-*.jsonl`（按 sessionId join）
- Tree（parentUuid）→ 线性化（分叉拆 fork session）；`role: "model"` → assistant；`thought: true` part → thinking block
- usage：record 级 `usageMetadata` + 全局文件 per-call 对账；managed subagent（auto-memory-extractor）只有遥测 → 不产生子 session，usage 按 source 并入 stats（spec §五）
- 进程与遥测丢弃：attribution_snapshot、file_history_snapshot、ui_telemetry（ADR-0001）
- 注意：真实数据可能不存在（调研时未安装）——fixture 按调研文档合成；capabilities 与 sweep 以实际为准
