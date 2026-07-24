---
title: ADR-0006 多分支 Session 目录模型（supersede ADR-0005）
description: Session = 目录（manifest + 多分支 JSONL）；rewind = session 内分支（parentBranch + parentRecordId）；fork = 跨 session 新目录（lineage 元信息）；subagent 不变；relations.jsonl / group / closure / root 退役；HEAD 显式化为 manifest 字段。
type: adr
status: accepted
created: 2026-07-24T03:00:00Z
---

# ADR-0006: 多分支 Session 目录模型

> 本 ADR **supersede [ADR-0005](0005-linear-sessions.md)**：被取代的是"session 一律线性（record 删 parentId、rewind 一律成 session）"、"rewind 与 fork 统一为 lineage 跨 session 回链"、"relations.jsonl 作为派生索引"、"group / closure 派生概念"。被保留的是"subagent 是独立 session"、"invocation 两链（正链 + 回链）"、"Task 为用户视角派生概念"的精神。

---

## 动机

ADR-0005 的核心设计——"一切分叉一律产出新 session"——在实现和消费中暴露了根本性缺陷：

1. **rewind 被消解为独立 session**：rewind 本质是 session 树内的分叉，共享前缀。当前模型把它建模为独立 session + `lineage` 回链，导致树结构在磁盘上不存在——它是内存中沿回链 walk 出来的派生视图。删掉源 session，rewind 分支就断了。
2. **`relations.jsonl` 是过度设计**：edge/group/closure 三种行全部可从 manifest 重算，且有冗余语义（group 用 union-find 连通分量，closure 用 invocation 传递闭包）。rewind 回归 session 内后，这些概念自然消失。
3. **`root` 字段是冗余的**：一旦 session 目录自包含所有分支，就不再需要区分"自包含"和"依赖源"。
4. **`HEAD` 是显式概念，不应藏在派生索引中**：当前 HEAD 是 `relations.jsonl` 里按时间戳启发式推导的，源 harness 的权威信息丢失了。

relay-go 的 `kernel/events.jsonl`（单文件内 `parentId` 形成树）给了方向性启发，但 AHS 不应复制其"控制在数据层混入"的缺点。AHS 应该保持 manifest（元数据）与 records（数据）分离，但让 tree 在磁盘上真实存在。

---

## 决策

### 1. Session = 目录，内含多分支

```
session-<id>/
├── manifest.json
├── records/
│   ├── main.jsonl
│   ├── b001.jsonl
│   └── b002.jsonl
└── blobs/
    └── sha256-<hex>
```

- `manifest.json`：session 元数据 + 分支注册表 + HEAD + invocation + stats
- `records/*.jsonl`：每个分支一个 JSONL 文件，seq 从 0 起（分支内独立编号），纯数据记录
- `blobs/`：content-addressed 大内容（>64KB），不变

### 2. manifest.json 结构

```json
{
  "sessionId": "sess-abc",
  "harness": "claude-code",
  "harnessVersion": "2.1.204",
  "ahsVersion": "0.2.0",
  "cwd": "/tmp",
  "model": "claude-opus-4-1",
  "thinking": "high",
  "branches": {
    "main": { "parentBranch": null, "parentRecordId": null },
    "b001": { "parentBranch": "main", "parentRecordId": "r2" },
    "b002": { "parentBranch": "main", "parentRecordId": "r4" }
  },
  "HEAD": { "branch": "main", "recordId": "r5" },
  "invocation": { "sessionId": "parent-sess", "atRecordId": "r9" },
  "stats": { ... }
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `branches` | 分支注册表。key = 分支名（`"main"` 保留给主链）；`parentBranch` = 父分支名（null = root）；`parentRecordId` = 分叉点的父分支中的 recordId（null = 从 root 开始） |
| `HEAD` | `{ branch, recordId }`。当前活跃节点。从现有 harness 历史读取时默认 = 活跃分支的最后一个 record |
| `thinking` | 推理深度等级（session 级配置，对应 Claude Code 的 thinking budget 等）。中途切换走 record 级覆盖 |
| `invocation` | 调用维回链。subagent 场景：谁创建了我。`atRecordId` 指向父 session 中 spawning tool_call 的 recordId |
| ~~`lineage`~~ | **退役**。rewind 变成 session 内分支，不再跨 session；fork 的 lineage 降级为元信息（见 §3） |
| ~~`root`~~ | **退役**。每个 session 目录自包含所有分支 |

### 3. 各操作在模型中的表达

**Rewind（session 内分叉）**：
- 在 `records/` 下新增一个分支文件（如 `b001.jsonl`）
- 在 `manifest.branches` 中注册：`{ "parentBranch": "main", "parentRecordId": "r2" }`
- 不产生新 session。完整路径 = 沿 `parentBranch` 回溯到 root，在 `parentRecordId` 处截断，拼接前缀

**Fork（全量复制，独立 session）**：
- 创建新 session 目录，全量复制源路径的所有记录
- 可选 `lineage`（元信息）：`{ type: "forked_from", sessionId, atRecordId }`——仅在源 harness 有记录时填写
- 新 session 是独立的 root，不依赖源

**Subagent（独立 session，调用维）**：
- 创建新 session 目录，`invocation` 回链
- 正链：父 session 中 `tool_result.sessionIds` 记录产生的子 session
- 不变

### 4. 退役的概念

| 退役概念 | 原因 |
|---------|------|
| `relations.jsonl` | edge = 从 manifest 直读；group = session 即边界；closure = 从 manifest 直读 |
| `group` / `LineageGroup` | rewind 回归 session 内，连通分量 = session |
| `closure` / `InvocationClosure` | invocation 是 session 级属性，不需要闭包计算 |
| `root` 字段 | session 目录自包含所有分支 |
| `rewound_from` lineage 类型 | rewind 不再是跨 session 操作 |
| `sibling_attempt` lineage 类型 | 已退役（ADR-0005 2026-07-24 amend），消解为 rewind 的锚点位置 |

### 5. 保留的概念

| 保留概念 | 说明 |
|---------|------|
| `forked_from` lineage 类型 | 跨 session fork 的元信息（可选，源 harness 无记录时省略） |
| `invocation` 两链 | 正链 `tool_result.sessionIds` + 回链 `manifest.invocation` |
| `atRecordId` 三态 | 有值 = 锚定；null = 源端不可得；缺省 = 无锚点 |
| Task = 用户视角派生概念 | 由 sessions + lineage 边 + HEAD 组成，非存储实体 |
| 适配器只读接口（`HarnessAdapter`） | listSessions / readRecords 不变 |

---

## 影响

### 代码变更

- **schema**：`ManifestSchema` 新增 `branches`、`HEAD`、`thinking`；删 `lineage`、`root`；`RelationEdge` 简化（仅 invocation 边）
- **适配器**：rewind 不再产出新 session，改为 session 内分支；claude-code / codex / devin / pi / qwen 的 fork 产出逻辑重写
- **validate**：跨 session 对账只剩 invocation 正链/回链；session 内分支完整性检查
- **ahs**：writer 支持多分支文件；relations 删减；reader 适配
- **facade**：`loadSession` 返回分支树；`loadTask` 的 HEAD 链拼接到分支内
- **relations.jsonl**：删除文件，`buildRelations` / `writeRelations` / `readRelations` 删除
- **golden fixtures**：全部重生成
- **测试**：大幅重写

### 契约文档

- spec/0001-ahs.md → v4
- adr/0005-linear-sessions.md → 标记 superseded
- ac/0001-adapter-ac.md → 更新 invariants