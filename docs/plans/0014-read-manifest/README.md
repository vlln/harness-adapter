# 0014 readManifest 实现

## 状态

| 子任务 | 状态 |
|--------|------|
| 01 readManifest 全 adapter 实现 + writeArchive/facade 改用 | pending |

## 概述

HarnessAdapter 接口新增 `readManifest(sessionId): Promise<Manifest>`（PR #50 契约变更）。本执行容器实现该方法于全部 7 个 adapter，更新 writeArchive 和 facade 使用 readManifest 替代 listSessions 遍历，新增 ahs-export CLI。
