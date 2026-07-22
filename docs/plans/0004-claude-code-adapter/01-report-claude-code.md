---
title: Report 01 Claude Code 正式适配器
description: Claude Code 适配器按 active 契约实现完成，四层 AC 全部 PASS；真实数据 sweep（176 文件 / 175 session）零 schema 错误、零不变量错误、usage 对账零偏差。
type: report
status: complete
created: 2026-07-22T10:57:00Z
---

# Report 01: Claude Code 适配器

---

## 执行摘要

成功。`src/adapters/claude-code/` 实现 HarnessAdapter（harness `claude-code`，history `full`，control `false`，base path 可注入、默认 `~/.claude/projects`）。TDD：先写失败测试与合成 fixture，再实现；参考 spike 底稿重写（未合并 spike 分支）。四层 AC 全覆盖并通过；真实数据 sweep 留证（见下）。无契约摩擦——实现过程未被迫新增字段/record 类型/逃生舱。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| bad6ee9 | feat(adapter): claude-code formal adapter（代码 + fixture + 测试） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 适配器实现 | `src/adapters/claude-code/index.ts` | ClaudeCodeAdapter + projectRecords；graph + sidechain 拆分 |
| 合成 fixture | `test/fixtures/claude-code/-Users-test-Project-demo/` | 5 个手工会话：A goal 生命周期、B subagent 文件+meta+ai-title、C 内联 sidechain+compaction+重复 tool_result+interrupted、D 过程记录丢弃/再锚定+多 tool_use+非字符串 tool_result+usage 缺失、E 纯过程记录（跳过） |
| Golden 期望输出 | `test/fixtures/claude-code/golden/` | 6 个 session 的审查后期望输出（stableSerialize） |
| 测试 | `test/claude-code-adapter.test.ts` | 层1/层2 + 映射断言（31 tests） |
| 测试 | `test/claude-code-golden.test.ts` | 层3 golden diff |
| 测试 | `test/claude-code-report.test.ts` | 层4 归档 + ahs-report 聚合 |

未修改 `src/index.ts`（导出由容器收尾统一接线）；无新运行时依赖。

---

## 测试摘要

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：8 个测试文件、84 个测试全部通过
- 覆盖率（v8）：全仓 statements 100% / branches 92.26% / functions 100% / lines 100%；适配器文件 statements 100% / branches 88.29%（阈值 ≥80%）

---

## 验收结果

| AC | 结果 | 证据 |
|----|------|------|
| AC-0001-N-1 | PASS | `claude-code-adapter.test.ts` "layer 1"：全部 manifest/record 过 zod parse |
| AC-0001-E-1 | PASS | 同上 "layer 1 (AC-0001-E-1)"：fixture D 含 system/mode/attachment/细粒度 usage 层级，输出 strict parse 通过且无丢弃字段痕迹 |
| AC-0002-N-1 | PASS | `validateSessions` 全 fixture 零错误；另有序号/因果链专项断言 |
| AC-0002-N-2 | PASS | fixture B/C：每个 subagent 单元恰好一个子 session；spawned_by 锚点指向父 session 真实 tool_call（meta.toolUseId 与 sourceToolUseID 回退两路径均测） |
| AC-0002-N-3 | PASS | fixture A：user/assistant 消息条数与源一致；文本逐字保留（含 slash-command XML）专项断言 |
| AC-0002-N-4 | PASS | record 级 usage 求和 == 源总量（fixture A/B/C 精确值断言）；真实 sweep 四项计数器零偏差 |
| AC-0002-N-5 | PASS | `checkIdempotency` 两轮输出逐字节一致 |
| AC-0002-N-6 | PASS | tool 配对 XOR interrupted 不变量全 fixture 通过；重复 tool_result 保留文件序第一条专项断言 |
| AC-0002-B-1 | PASS | fixture C：无配对 result 的 tool_call 标 `interrupted`，不合成假 result |
| AC-0002-B-2 | PASS | fixture D：源缺 usage 时 record.usage 缺省不编造 |
| AC-0003-N-1 | PASS | `claude-code-golden.test.ts`：6 个 session golden diff 完全一致；fixture 全合成，期望输出经人工逐行审查 |
| AC-0004-N-1 | PASS | `claude-code-report.test.ts`：exportSessions 归档后 ahs-report 渲染（子 session 内联于锚点 Task 调用之后），聚合 token 与 record 求和精确一致；真实数据上复验一致（见 sweep） |

---

## 真实数据 sweep（只读 ~/.claude/projects，临时脚本，用后已删）

| 指标 | 数值 |
|------|------|
| 源 jsonl 文件 | 176（115,868 行，0 行解析失败） |
| 适配器 session | 175（其中子 session 81） |
| 输出 record | 66,299（assistant_message 22,191 / tool_call 17,908 / tool_result 17,477 / user_message 8,641 / goal_update 49 / compaction 33） |
| schema 错误 | 0 |
| 不变量错误（层2） | 0 |
| usage 对账（源 vs 适配器） | input 1,807,790,717 / output 7,210,632 / cacheRead 2,345,094,903 / cacheWrite 154,939,033 —— 四项 delta 全为 0 |
| 层4 复验 | 随机取含子 session 的真实会话归档渲染：聚合 3 session，report 总量 == record 求和（input 1,094,636 / output 13,614），transcript 可读、子 session 正确内联 |

与调研文档的差异（surprises）：

1. **会话标题行形态已变**：当前版本产生 `{"type":"ai-title","aiTitle":...}` 行（2,711 行、覆盖 34 个 session），调研文档记录的 `type:"summary"` 行在真实数据中已不存在。适配器两种形态都映射到 Manifest.title（summary 优先、aiTitle 回退），真实数据 34/34 个有标题的 session 全部正确映射。
2. 真实数据还出现调研文档未列的记录类型：`agent-name`、`worktree-state`、`agent-setting`、`pr-link`、`file-history-snapshot`——均属过程/遥测，按 ADR-0001 丢弃，丢弃后因果树经再锚定保持单根连通（sweep 零 single-root/parent-resolution 错误）。
3. `queue-operation` 数量（13,254）远超 session 数，确认其为高频过程记录，丢弃正确。

---

## 遗留问题

- 无契约摩擦。唯一调研文档偏差（ai-title）已通过适配器兼容两种形态解决，建议在 research 文档后续补充时记录（research 文档为历史产出，本次未改动）。
