---
title: Vision — harness-adapter 顶层愿景
description: 编码 Agent Harness 的中立通用抽象库与离线交换标准（AHS），消除生态碎片化、解除厂商锁定。
type: vision
status: active
created: 2026-07-21T11:48:45Z
---

---

## 一、业务目标

编码 Agent Harness（Claude Code、Codex、Kimi Code、Devin、Grok、Qwen Code……）相互封闭，各厂商试图锁定用户；上层工具（调度、评测、可视化、迁移）被迫为每个 Harness 重复开发专属适配层。

本项目构建一个中立的通用抽象库与离线交换格式：

- **消除碎片化**：一次开发适配器，全生态上层工具共享
- **解除厂商锁定**：用户可以在 Harness 之间自由迁移
- **离线标准**：AHS（Agent History Standard），面向会话归档、Trace 回放、跨 Harness 迁移的离线交换与消费格式
- **通信层兼容**：愿景上兼容 ACP（Agent Communication Protocol）等在线协议（当前阶段不实现，见系统边界）

详细动机与碎片化问题分析见 [research/harness-adapter-motivation.md](research/harness-adapter-motivation.md)，本文件不重述。

---

## 二、用户范围

- 上层工具开发者：调度系统、评测系统、可视化工具（如 MindWalk、obsidian-harness-frontend）、迁移工具的构建者——他们只对接 AHS 一次，而非 N 个 Harness。
- Harness 使用者：希望跨 Harness 查看、归档、迁移自己会话历史的个人用户与团队。

---

## 三、长期理想形态

```
一次开发适配器，全生态共享

┌─────────────────────────────────────────────────┐
│          调度系统  │  评测系统  │  可视化(MindWalk)  │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│              Harness Adapter（统一 API）          │
├─────────────────────────────────────────────────┤
│  PiAdapter │ CCAdapter │ KimiAdapter │ ...      │
├─────────────────────────────────────────────────┤
│  ~/.pi/  │  ~/.claude/  │  ~/.kimi-code/  │ ... │
└─────────────────────────────────────────────────┘
```

AHS 成为编码 Agent 会话历史事实上的交换标准：新 Harness 出现时只需新增一个适配器；历史数据在任何工具链中可读、可评测、可迁移。

---

## 四、不定义

本文件不定义实现细节、技术选型、接口定义、格式字段、编码规范。这些分别属于 Spec、Interface、ADR、CONTRIBUTING.md。
