# 0005-codex-adapter 执行容器

对应分支：`feat/0005-codex-adapter`（从 develop 拉出，PR 合并后删除）

阶段：DEVELOP。依据：spec/0001-ahs.md、interface/0001-harness-adapter.md、ac/0001-adapter-ac.md（均 active）。共享层：0003-ahs-core（已完成）。参考底稿：spike/0001-adapter-prototypes 的 `src/adapters/codex/`（参考重写，不合并 spike）。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-codex.md](01-plan-codex.md) | Codex 正式适配器（stream 合成链 + 冗余去重） | done | [01-report-codex.md](01-report-codex.md) |

## 适配器要点

- 存储：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- 去重：response_item 为内容规范表示；event_msg 仅取 token_count/生命周期/compaction/goal；token_count 总量未变时跳过
- thread_spawn → spawned_by 子 session；lineage 祖先 → forked_from；developer 角色 → harness_message；thread_goal_updated → goal_update；turn_aborted → turn_boundary end
- encrypted reasoning 丢弃；last_token_usage 语义（全量快照）注意防重复计数
