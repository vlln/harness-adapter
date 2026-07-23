---
title: Report 02 devin 适配器线性化重构
description: devin 适配器按 ADR-0005 重构：每 root 一线性 session、树内分叉拆 fork session（twin 死支不产 session，去重 forwarding map 删除）、跨 root 共享前缀 message_id 对账锚点、main_chain_id 仅用于组 HEAD（B-4 winner 易主不改 session 集）；真实 sweep 36 session / 1733 record / 0 不变量错误 / usage 逐条精确对账。
type: report
status: complete
created: 2026-07-23T13:30:00Z
---

# 02-report-devin: devin 适配器线性化重构

---

## 执行摘要

成功。devin 适配器从 Plan 01 的最小映射升级为 ADR-0005 完整实现：每个 root 一棵线性 session；树内分叉一律拆 fork session（真实数据 513/513 分叉点是 Devin 的 twin 副本存储怪癖——两个子节点携带同一 assistant message_id 且其一必为死支——twin 死支不产 session，旧的"去重 forwarding map"机制整体删除，"去重"退化为共享前缀规则的自然推论）；跨 root fork 经 message_id 对账锚定共享前缀（类型按锚点 record 角色判定）；`main_chain_id` 只用于 `listSessions` 默认折叠的组 HEAD 选择，session 集合与 winner 完全解耦（AC-0002-B-4 逐字节验证）；组级 credit cost 改放稳定的 base session（原先挂 winner 主链，易主会移动 manifest）。`npx tsc --noEmit` 零错误；`npx vitest run --coverage` 13 文件 / 162 测试全过（行覆盖 97.99%，devin 适配器 100% 行 / 90.19% 分支）；`npm run test:e2e` 4/4 链路通过。真实数据 sweep（活跃 sessions.db 快照）：6 组 / 36 session / 1733 record，0 不变量错误，幂等字节一致，usage 逐条对账 511/511 精确。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| 3ef2f2a | refactor(adapter)!: devin linear sessions + fork synthesis + invocation links（refactor/0009b-devin） |
| （docs commit 见 PR） | docs(plan): 0009-02 devin Report（本文件） |

---

## 真实数据形态勘察（重构依据，临时脚本已删）

对活跃 `~/.local/share/devin/cli/sessions.db` 快照（2026-07-23）的探索结论，修正了任务书与旧代码注释的两处猜想：

- **树内分叉 = twin 副本**：513/513 分叉点恰有 2 个子节点且携带**同一个 assistant message_id**；513/513 其一为死支（无子节点）。"重试"不是旧 fixture 假定的"子节点复制父消息"，而是 Devin 在分叉时把 tip 消息复制成孪生兄弟。**真实 intra-tree fork（双 twin 都延续）= 0**。
- **跨 root 共享前缀的角色是 system**（30/30 有共享的 root），即 AHS 的 harness_message → **forked_from**，不是任务书猜想的 user/sibling_attempt。
- **main_chain_id 恒为 tip 且恒等于所在树的 last leaf**（6/6）——last-leaf 启发式与 winner 标记在观测语料上完全等价。
- 数据规模：6 个可见 session、2250 节点、1192 distinct message_id、52 个 root。

---

## 实现要点（src/adapters/devin/index.ts）

- **线性主线（winner 无关）**：每棵树的主线 = root 到子树 last leaf（max created_at，并列 max node_id）的链。刻意不使用 main_chain_id——否则 winner 在树内易主会改变 session 内容，违反 B-4。观测语料上二者一致（见上）。
- **fork 合成**：非主线子节点成为 `<slug>#fork-<起始 nodeId>`；非首 root 成为 `<slug>#root-<root nodeId>`（首 root = 最低 node_id = base，拿裸 slug）。fork 只存后缀：链首与前序 session 记录共享的消息（leading dup run）跳过，末条共享消息为锚（atRecordId = 该消息在其所属 session 的**末条** record，锚必可解析）；无共享前缀的 intra-tree fork 锚于分叉点 record；完全无共享的 root 得 anchor-less lineage `{ sibling_attempt, sessionId: <slug> }`（从起点重试）。类型判据按锚点 record 角色（user_message ⇔ sibling_attempt）。
- **twin 死支 → 不产 session**：死支 fork 的全部节点都在共享前缀里 → 后缀为空 → 跳过。旧的去重/forwarding map 删除。
- **orphan tool_result 丢弃规则**（N-6 边界）：fork 后缀中 toolCallId 属于共享前缀（祖先生成的调用）的 tool_result 不写入 fork——该调用的完成属于锚点所在轮次，父 session 已含其配对；保留必然破坏 N-6 配对断言。观测语料出现 0 次；fixture 锁定该行为。**判断性丢弃，特此报告**。
- **组 HEAD（includeForks 默认折叠）**：HEAD = 发射了 main_chain tip 节点的 session（含 tip 落在被跳过的 twin 副本上时归属性回共享消息所属 session）；不可解析时回退"末条 record 时间戳最大、并列取 sessionId 最小"。HEAD 只影响默认 listSessions 出哪个 manifest，不进任何 session 内容。
- **credit cost 落点**：`total_credit_cost` 是组级聚合，改挂 **base session**（最低 root）——旧实现挂 winner 主链，易主即移动 manifest 违反 B-4；fork manifest 不复制（防重复计数，AC-0004）。B-4 fixture（main_chain_id 18→42 两次投影）验证 session 集逐字节一致、仅默认列出的 HEAD 移动。
- **共享文件零改动**：SessionFilter.includeForks / collectSessions 全集 / writer 全集查找已随 codex (#23)、kimi-code (#22) 合入 develop，rebase 后直接复用。

---

## 逐 AC PASS 证据

### AC-0001-N-1（schema 合法）

全部 7 个 fixture session 的 Manifest + 24 条 record 过 zod parse（test/devin-adapter.test.ts "AC-0001-N-1"）；真实 sweep 全部 36 session / 1733 record 经 validateSessions 层1 前置断言 0 错误。

### AC-0001-E-1（不可映射内容按规则丢弃）

unknown role / 畸形 JSON / 空 assistant / 重复 tool_result / twin 副本均不产 record，输出 parse-再序列化逐字节自洽（测试 "AC-0001-E-1"）。

### AC-0002-N-1（线性）

每 session seq 从 0 连续；首条即根；session 内无分叉（任何分叉已拆 session + lineage 边）（测试 "AC-0002-N-1"，validateSessions "seq-order" 0 错误）。

### AC-0002-N-2（invocation 两链）

Devin CLI 源端无 subagent session 机制（subagent profile 是 system 会话节点，映射为 harness_message）——全部 manifest invocation 缺省，本项**自然空成立**（测试 "AC-0002-N-2"）。真实 sweep：invocations=0。

### AC-0002-N-3（内容无静默丢失）

fixture：组级 user 6 条 / assistant 6 条与源 distinct 消息相等，文本逐字（测试 "AC-0002-N-3"）。真实 sweep：1190/1192 distinct 消息被发射；缺失 2 条均为空 assistant（无内容无 tool_calls，既定丢弃规则），见 AC-0002-N-4 的量化。

### AC-0002-N-4（usage 无静默丢失）

fixture：record 级求和 = 源 metrics（twin 重复 metrics 只计一次）；tool-only 消息 usage 骑在首条 tool_call；组级 cost 7 credit 仅在 base manifest（测试 "AC-0002-N-4"）。真实 sweep **逐条对账**：511/511 被发射的 usage 消息与源 metrics 逐字段精确相等；唯一未发射 usage = 2 条空 assistant 消息（in=4 out=11 cacheRead=101338 cacheWrite=1186 ms=11158），为 0007 容器已建档的有界丢弃。聚合口径：emitted = 源 distinct + 汇流重复 − 空 assistant 丢失（汇流见"契约摩擦"）。

### AC-0002-N-5（幂等）

checkIdempotency fixture 与真实数据均字节一致（测试 "AC-0002-N-5"；sweep idempotency errors=0）。

### AC-0002-N-6（tool 配对 XOR）

fixture：tc-1/tc-2/tc-4 completed、tc-3 interrupted；重复 result 保链序首条；orphan result 不入 fork（测试 "AC-0002-N-6"）。validateSessions "tool-result-match" fixture 与真实数据均 0 错误。

### AC-0002-N-7（lineage 锚点 + 类型判据）

fixture 四形态全覆盖：intra-tree fork `sunny-forest#fork-16` → `{ forked_from, atRecordId: m-asst-15/tool_call/0 }`（只存后缀 2 条）；跨 root 共享 system 前缀 `sunny-forest#root-40` → forked_from 锚 harness_message `m-sys-0`；共享 [system,user] 前缀 `sunny-forest#root-50` → sibling_attempt 锚 user_message `m-user-1`；无共享 `sunny-forest#root-30` → anchor-less sibling_attempt（测试 "AC-0002-N-7"×2）。真实 sweep：30 条 lineage 边（forked_from=13，sibling_attempt=17；anchored=18，anchorless=12），validateSessions "lineage-*" 0 错误。

### AC-0002-B-1 / B-2 / B-3

B-1：悬空 tc-3 标 interrupted，无合成 result。B-2：quiet-pond 无 usage 字段；odd-cove 非法 metadata JSON 不崩。B-3：Devin 无 invocation 维度，不适用（见 N-2）。

### AC-0002-B-4（winner 易主）

同一 fixture 仅 main_chain_id 不同（18 = base tip vs 42 = root-40 tip）两次投影：**session 集合（id + manifest + records）逐字节一致**；默认 listSessions 的 HEAD 从 `sunny-forest` 移到 `sunny-forest#root-40`（测试 "AC-0002-B-4"）。

### AC-0003-N-1（golden）

test/fixtures/devin-golden.json 经脚本 scripts/gen-devin-golden.ts 再生成并逐行人工审查：7 session、锚点/类型/后缀/cost 落点均符合设计（提交 3ef2f2a）。

### AC-0004-N-1（可用）

exportSessions（存储视图全量）→ ahs-report 渲染 base 与 fork session，token 聚合与 record 级对账一致（测试 "AC-0004-N-1"；e2e devin 链路过）。

---

## 真实数据 sweep 留证（快照复跑，临时脚本用后已删）

| 指标 | 值 |
|------|-----|
| 组数 / 默认列出 HEAD | 6 |
| 全量 session（includeForks） | 36 |
| record 总数 | 1733 |
| 不变量错误（validateSessions 全集） | 0 |
| 幂等 | 字节一致 |
| 源节点 / distinct 消息 | 2250 / 1192 |
| 被发射 distinct 消息 | 1190（缺 2 = 空 assistant，既定丢弃） |
| usage 逐条对账 | 511/511 与源 metrics 逐字段精确相等 |
| usage 聚合（emitted） | in=14877 out=475922 cacheRead=77821116 cacheWrite=2493743 ms=9355994 |
| lineage 边 | 30（forked_from=13，sibling_attempt=17；anchored=18，anchorless=12） |
| invocation 边 | 0 |
| 含组级 cost 的 manifest | 6（各组 base session） |

---

## 契约摩擦与观察（未静默绕过）

1. **汇流（reconvergence）双发**：111/1192 消息被多个 session 发射——真实森林的共享**不止公共前缀**（树间在分叉后再次汇流），suffix-only 模型无法对非前缀共享去重；fork 链自带这些消息是自包含性的正确取舍，但跨 session 聚合会双计其 usage（35 条带 usage，本语料 output 口径约 +8%）。属模型固有边界，非适配器缺陷，特此建档。
2. **orphan tool_result 丢弃规则**（见实现要点）：为守 N-6 的判断性丢弃，真实语料 0 次命中；若未来语料出现"双 twin 都延续且锚消息带 tool_calls"，fork 侧该调用的结果内容（可能与父侧不同）会丢——届时应回 Spec 讨论跨 session 配对，而不是在适配器打补丁。
3. **组 HEAD 指针无 schema 落点**：`main_chain_id` 只能体现在 listSessions 默认折叠的选择里（派生层 `{ groupId, mainSessionId }` 指针是 Plan 03 范围）；本次未在任何 session 数据里编码 winner，符合"mainness 去 session 化"。
4. **空 assistant 的 metrics 丢失**（2 条，量化见 N-4）：0007 已建档的既有边界，本模型不变。
5. **任务书两处修正**：重试形态是 twin 兄弟副本（非"子复制父"）；跨 root 锚点角色是 system→forked_from（非 user→sibling_attempt）。均以真实数据为准实现并在此备案。
