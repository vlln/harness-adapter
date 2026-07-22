# 0006-kimi-code-adapter 执行容器

对应分支：`feat/0006-kimi-code-adapter`（从 develop 拉出，PR 合并后删除）

阶段：DEVELOP。依据：spec/0001-ahs.md、interface/0001-harness-adapter.md、ac/0001-adapter-ac.md（均 active）。共享层：0003-ahs-core（已完成）。参考底稿：spike/0001-adapter-prototypes 的 `src/adapters/kimi-code/`（参考重写，不合并 spike）。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-kimi-code.md](01-plan-kimi-code.md) | Kimi Code 正式适配器（多 wire → 多 session） | done | [01-report-kimi-code.md](01-report-kimi-code.md) |

## 适配器要点

- 存储：`~/.kimi-code/sessions/wd_*/session_*/`（state.json + agents/*/wire.jsonl + plans/）
- 每条 wire = 一个 session；subagent wire → spawned_by（无 toolCallId，AC-0002-B-3）
- origin.kind：user → user_message；injection/system_trigger/background_task/skill_activation → harness_message
- goal.create → goal_update pending（带 goalId）；goal.update 判定 → met/unmet；进度遥测丢弃
- plans/*.md 保留为文本块（文件侧投影）；cwd 为 hash 不可还原（留空）、harnessVersion "unknown"
- 去重：turn.prompt 不发射（append_message 已含内容）；session-scope usage 丢弃防重复
