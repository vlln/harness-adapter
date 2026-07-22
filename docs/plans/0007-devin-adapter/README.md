# 0007-devin-adapter 执行容器

对应分支：`feat/0007-devin-adapter`（从 develop 拉出，PR 合并后删除）

阶段：DEVELOP。依据：spec/0001-ahs.md、interface/0001-harness-adapter.md、ac/0001-adapter-ac.md（均 active）。共享层：0003-ahs-core（已完成）。参考底稿：spike/0001-adapter-prototypes 的 `src/adapters/devin/`（参考重写，不合并 spike）。

## 子任务状态表

| Plan | 内容 | 状态 | Report |
|------|------|------|--------|
| [01-plan-devin.md](01-plan-devin.md) | Devin 正式适配器（forest → sibling_attempt） | pending | — |

## 适配器要点

- 存储：`~/.local/share/devin/cli/sessions.db`（SQLite，node:sqlite 只读打开；真实 sweep 先复制到 temp 防 WAL 锁）
- 森林：每个 root 一棵树一 session；main_chain_id 指向链尾（tip→root 上溯找主链）；非主链 root → sibling_attempt + 指向主链 session
- 分支重试去重：同 message_id 树内首次出现保留，子节点经 forwarding map 重锚
- 角色：user→user_message，system→harness_message，assistant（thinking+text+tool_calls 拆分），tool→tool_result（tool_call_id 链接）
- assistant metadata.metrics → record usage；sessions.metadata.total_credit_cost → stats cost（currency "credit"）
