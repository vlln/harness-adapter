---
title: Plan 01 Grok 正式适配器
description: 按 active 契约实现 Grok 适配器（四层表示取 chat_history 为规范）。本 Plan 为适配器完成后补记（2026-07-24），实际执行记录以 01-report-grok.md 为准。
type: plan
status: done
created: 2026-07-24T03:03:25Z
---

# Plan 01: Grok 适配器

> 补记说明：本容器执行时走简化流程未留 Plan 文件，本文档为事后补记，内容依据 01-report-grok.md 的实际执行结果整理，不含未执行的计划项。

## Context

契约冻结（spec v2、interface/0001、ac v2 均 active），共享层已就绪。源格式文档：docs/research/schemas/grok-schema.md（最详尽的存储：四层表示 + signals.json）。实现模板：`src/adapters/kimi-code/`（目录制 session + 元数据文件）。本机存在 `~/.grok`（9 个 session 目录），可做真实数据 sweep。

## Request

`src/adapters/grok/` 实现 HarnessAdapter（harness "grok"，provider 固定 xai）。源存储：`~/.grok/sessions/%2F<cwd>/<ulid>/`（chat_history.jsonl + summary.json + signals.json + events.jsonl 等）。映射要点：

- 规范表示 = `chat_history.jsonl`；`updates.jsonl`（chunk 流）与 events.jsonl 的 loop/phase/tool 生命周期事件按 ADR-0001 丢弃
- 时间戳恢复：chat_history 行无时间戳，用 events.jsonl `turn_started.conversation_message_count`（chat_history 前缀长度）按 turn 粒度继承开始时间；turn_started/turn_ended 发射 turn_boundary；events 缺失回退 summary.created_at 再回退 epoch（全部源端派生，无墙钟读取）
- provenance：`synthetic_reason` 非 null → harness_message，缺省 → user_message
- reasoning：encrypted_content 不可解密丢弃；明文 summary[] → thinking block 并入下一条 assistant_message；空 summary 整体丢弃
- usage：源端无 record 级 usage block；signals.json 聚合指标（contextTokensUsed 为上下文窗口度量）在 AHS Usage 中无诚实归处，按 B-2 不伪造 totalUsage
- tool_result 真实形态 `{tool_call_id, content}`（兼容调研文档旧形态）；同 tool_call_id 多 result 取文件序第一条；悬空 call 标 interrupted
- model：Manifest.model 取 summary.current_model_id；后续 assistant model_id 不同发 model_change
- stats：turnCount 取 events turn_started 数（回退 signals.turnCount）；durationMs = signals.sessionDurationSeconds×1000
- 无关系边：subagent 无独立存储、rewind 无分叉链接 → 不产生 lineage/invocation，includeForks 为 no-op
- harnessVersion 取 `<base>/../version.json`；cwd 取 summary.info.cwd（回退 URL 解码目录名）；title 取 summary generated_title

测试：合成 fixture（脱敏）+ AC 全覆盖 + golden + ahs-report 可用性 + e2e 链注册 + 真实数据只读 sweep（临时脚本，用完删除）。

## AC 覆盖

AC-0001-N-1/E-1；AC-0002-N-1..N-7（N-2/N-7 源端不适用，需论证不变量成立）、B-1/B-2；AC-0003-N-1；AC-0004-N-1。

## Output Format

代码 + fixture + 测试 + e2e 注册。Report 含：per-AC PASS 表、真实 sweep 统计（9 session / 161 record / 0 错误）、映射决策、契约摩擦如实报告（调研文档 tool_result 形态漂移、Usage 语义缺口、turn 粒度时间戳）、关联 commit。

## Constraints

- 不修改 active 契约；契约摩擦如实报告不打适配器内补丁
- fixture 全合成手写（脱敏），禁止真实数据入仓；真实 sweep 用临时脚本（用完删除）
- 无新运行时依赖

## Checkpoint

`tsc --noEmit` 通过；vitest 全绿且覆盖率 ≥80%；e2e 链全过；真实 sweep 0 错误；Report 完整。
