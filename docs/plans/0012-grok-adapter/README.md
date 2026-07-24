# 0012-grok-adapter 执行容器

对应分支：`feat/0012-grok-adapter`。阶段：DEVELOP。依据：spec v2、interface/0001、ac v2（均 active）。共享层已就绪。调研：docs/research/schemas/grok-schema.md（最详尽的存储：四层表示 + signals.json）。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| 01-plan-grok.md | Grok 适配器（四层表示取 chat_history 为规范） | done | [01-report-grok.md](01-report-grok.md) |

## 适配器要点

- 存储：`~/.grok/sessions/%2F<cwd>/<ulid>/`（chat_history.jsonl + summary.json + signals.json 等）
- 规范表示 = `chat_history.jsonl`；`updates.jsonl`（chunk 流）/`events.jsonl`（生命周期）按 ADR-0001 丢弃；encrypted reasoning 丢弃但明文 `summary[]` → thinking
- `synthetic_reason: "system_reminder"` → harness_message（provenance 显式标记的标杆案例）
- usage：record 级无 usage block——`signals.json` 聚合指标 → Manifest.stats；turn 边界可从 events.jsonl 提取（可选，源端有才发射）
- summary.json：title（generated_title）、model、sandbox_profile；worktrees.db → git 信息
