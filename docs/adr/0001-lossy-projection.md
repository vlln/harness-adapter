---
title: ADR-0001 有损投影：AHS 是交换/消费格式而非备份
description: AHS 采用有损投影，保留判据为评审者/评测系统理解"发生了什么、花了多少代价"所需的信息；不留 raw/extra 逃生舱；无损性由源数据提供。
type: adr
status: draft
created: 2026-07-21T11:48:45Z
---

# ADR-0001: 有损投影——AHS 是交换/消费格式而非备份

---

## 背景

各 Harness 的原生会话存储包含大量流式日志、过程机制、冗余表示、遥测数据（详见 [research/schemas/](../research/schemas/)）。AHS 若追求无损兼容，要么变成一个承载一切的容器（等于没有标准），要么要求适配器做完美的双向映射（不可行，如 Codex `encrypted_content` 无法解密）。

---

## 决策内容

AHS 定义为**有损但有原则**的投影格式：

- **保留判据**：一个评审者或评测系统理解"发生了什么、花了多少代价"所需的信息保留，其余丢弃。
- 丢弃类别（流式/过程/冗余/遥测/加密 blob/多时间戳格式）作为规范的一部分显式列出，见 [spec/0001-ahs.md](../spec/0001-ahs.md) 第二节。
- **不留 `raw` / `extra` 逃生舱**。
- 无损性由源数据（`~/.claude/`、`~/.codex/` 等）提供，AHS 不复制原始记录；要归档就保留原始数据。
- 不追求 AHS → 源格式的双向可逆。

---

## 备选方案

### 方案 A: 无损容器（保留一切原始数据）

- 优点：信息零丢失；迁移可完美逆向
- 缺点：适配器退化为格式拷贝，无标准化价值；体积膨胀；上层工具仍需理解各家格式

### 方案 B: 有损 + raw/extra 逃生舱

- 优点：适配器作者有兜底；规范压力小
- 缺点：逃生舱把"要不要兼容"的决策推给每个适配器作者，各家填法不一致，等于没有标准；消费方无法依赖任何固定结构

---

## 选择理由

方案 B 的逃生舱在 obsidian-harness-frontend 的实践中已被证明会导致各适配器行为漂移。有损投影把"丢什么"的决策集中到规范层面，消费者一眼知道边界；适配器作者无自由裁量权，输出一致性由 AC 层1-2 机器保证。

---

## 验证

| 验证项 | 复现步骤 | 结论 | 经验 | 验证 Branch |
|--------|---------|------|------|------------|
| 首批适配器投影时不出现"保留判据内的信息无处安放" | 在 spike/* 分支实现 Claude Code / Codex / Kimi 三个适配器原型，投影真实会话，记录所有被迫丢弃但属于保留判据的信息 | **全部通过**（Claude Code / Codex / Kimi，2026-07-21） | 见下 | spike/0001-adapter-prototypes |

**Claude Code 验证经验**（173 个真实会话 / 66,339 records 只读 sweep，0 schema 错误）：

- 保留判据内无处安放的信息：**未发现**。
- 真实数据出现而研究文档未覆盖的 record 类型（`system`、`mode`、`permission-mode`、`file-history-snapshot`、`ai-title`、`agent-name`）全部属于过程/遥测，按本 ADR 丢弃无压力。
- 两处源格式事实修正：compaction 的真实形态是 user record 上的 `isCompactSummary: true`（已映射为 `compaction` record）；`"type":"summary"` 行实为 AI 生成的会话标题（属保留判据内元数据，映射为 `Manifest.title + titleOrigin:"generated"`，不丢）。
- 灰色地带：`attachment.goal_status`（目标达成判定 + reason）接近"关键状态事件"，当前最小 record 集无 goal 类型，暂按遥测丢弃——已列入 Spec 待定，若评测场景需要可复议（非推翻本 ADR，属保留判据校准）。**（2026-07-21 后续：已通过 `goal_update` record 类型解决，见 Spec 第五节）**

**Codex 验证经验**（230 个真实 rollout 文件 / 361,200 原始行 → 205,116 records，0 不变量错误，usage 投影总量与源端 `total_token_usage` 精确相等）：

- 保留判据内无处安放的信息：**未发现**（AC 元标准第二次成立）。
- 冗余去重策略成立：`response_item` 为内容规范表示，`event_msg` 仅用于 token_count/生命周期/compaction/goal；`last_token_usage` 非增量而是最近一次请求的全量——不去重会高估 usage ~1.3×，这条已写入适配器注释，值得规范层面知晓。
- `developer` 角色消息恰好落入新类型 `harness_message`（真实数据 518 条，是该类型的首个真实用例）；`turn_aborted`（研究文档未覆盖）映射为 `turn_boundary` end。
- 加密推理（20,516 条）按本 ADR 丢弃——这是仅次于内容的第三大类源数据，丢弃后历史语义完整性不受影响的判断在真实数据上成立。

**Kimi Code 验证经验**（698 个真实 session 目录 / 887 条 wire → 862 个 AHS session / 75,347 records，0 不变量错误，usage 与源端 turn-scope 总量精确相等）：

- 保留判据内无处安放的信息：**未发现**（AC 元标准第三次成立，三个代表性 harness 全部通过）。
- `harness_message` 在 Kimi 上成为主力类型：`origin.kind` 的 `injection`/`system_trigger`/`background_task`/`skill_activation` 全部落入，源端标注充分——该类型的引入在三个 harness 中两个有真实大规模用例（Codex developer 消息、Kimi 注入消息）。
- `goal_update` 的完整生命周期在 Kimi 上跑通：`goal.create` → pending（带 goalId+objective，Kimi 是三家唯一有 goalId 的）、`goal.update` 判定 → met/unmet；进度遥测（turnsUsed/tokensUsed，约占 90%）按本 ADR 丢弃无压力。
- 源端不可得补充：Kimi 的 cwd 是 hash（`wd_` id 不可还原路径）、CLI 版本不存在、`forked` 事件不带源 session id（forked_from 无法建立）。Spec 需注明这些字段对部分 harness 可为空/unknown。
- 一处保真缺口：`context.undo`（撤销已发消息）无法在 append-only 投影上回溯应用，真实数据仅 1 例，记录在适配器注释。
- `plans/*.md` 保留为 plan 内容块（文件侧投影，流内位置不可恢复）——"评审者必须看到 plan 是什么"的保留判据判断。

**Devin 验证经验**（计划外第四案例，2026-07-21）：

- 元标准第四次成立：`total_acu_cost` 无 schema 位置被丢弃（语料中恒为 0，无实际损失）；其余保留判据内信息均有归属，schema 零扩展。
- tool 配对 752/752 精确（tool 角色消息的 `tool_call_id` 链接完整），XOR 规则零 interrupted。

若验证中出现保留判据内信息无处安放，则本 ADR 被推翻，退回修订保留判据或数据模型（见 AC 元标准）。

---

## 后果

### 正面

- 适配器输出结构可预测，消费方一次对接
- 规范边界清晰，丢弃是特性不是缺陷
- 输出体积小，适合归档与传输

### 负面

- 保留判据判断失误的代价高：漏保信息无法事后补救，只能重新从源数据投影
- 需要 spike 验证来校准保留判据，契约冻结前工作量增加

---

## 约束范围

全部适配器实现；[spec/0001-ahs.md](../spec/0001-ahs.md) 数据模型；[ac/0001-adapter-ac.md](../ac/0001-adapter-ac.md) 层2（内容无静默丢失）。

---

## 约束规则

| 规则编号 | 规则 | 适用范围 | 违反时如何检出 |
|----------|------|---------|--------------|
| AR-001 | schema 中不得出现 `raw` / `extra` / `passthrough` 类逃生舱字段 | src/schema/ | code review + zod schema 审查 |
| AR-002 | 丢弃类别必须在 Spec 中显式列出；新增丢弃类别 = Spec 修订 | docs/spec/0001-ahs.md | 文档审查 |
| AR-003 | 适配器不得写回源存储 | src/ 全部适配器 | code review；接口只读（无 write 方法） |
