---
title: ADR-0004 测试基建选型
description: vitest + v8 覆盖率 + GitHub Actions + 合成 fixture 策略 + CLI 端到端系统测试；无付费依赖、无服务部署，相关项标记 N/A。
type: adr
status: accepted
created: 2026-07-22T07:33:05Z
---

# ADR-0004: 测试基建选型

---

## 背景

契约已冻结（2026-07-21），进入 TEST_INFRA。本项目是读取本地文件系统的 TypeScript 库：无网络服务、无付费外部依赖、无 UI。测试基建需覆盖单元/集成测试、覆盖率、CI、MR 门禁、提测门禁；系统测试按 CLI 项目裁剪（`examples/ahs-report.ts` 是当前唯一 CLI 形态消费方）。

---

## 决策内容

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 测试框架 | **vitest 3**（已在用） | 与 zod/TS ESM 栈集成成熟；spike 已积累 101 个用例 |
| 覆盖率 | **@vitest/coverage-v8**，阈值 statements/branches/functions/lines ≥ 80% | v8 原生覆盖率无插桩失真；80% 为初始门槛，随 DEVELOP 推进只升不降 |
| Mock 方案 | **合成 fixture 即 Mock**：手工构造 JSONL / 编程生成 SQLite（temp dir），禁止真实用户数据入仓 | 唯一"外部依赖"是本地文件系统的 harness 存储，fixture 天然是录制替身；spike 已验证该策略（4 个适配器） |
| 付费依赖隔离 | **N/A** | 库只读本地文件，零网络调用 |
| 系统测试 | **CLI 端到端**：vite-node 运行 `examples/ahs-report.ts` 对 fixture 归档做黑盒断言 | 无浏览器/服务；CLI 是消费方形态 |
| CI 平台 | **GitHub Actions**：`tsc --noEmit` + `vitest run --coverage`（阈值不达标即红） | 仓库托管在 GitHub，与 MR 门禁一体 |
| MR 门禁 | develop 分支保护：PR 必过 CI status check | 契约冻结后所有变更经 PR |
| 提测门禁 | `scripts/check-report.ts`：校验 Report 完整性（frontmatter、AC 标注、commit 引用）+ 覆盖率达标 | devloop 语义链的机器检查 |
| 测试数据策略 | fixture 随仓（`test/fixtures/`）+ 编程生成（temp dir） | 无持久化服务，无需数据工厂 |
| 部署策略 | **无服务部署底座**；发布 = npm publish（当前 private），RELEASE 阶段再定 | 库项目无运行时服务 |
| 视觉回归 / 沙箱账号 | **N/A** | 非前端项目；无付费资源 |

---

## 备选方案

- **jest**：生态等价，但 ESM 支持需要额外配置；vitest 已在用且无痛点，无切换收益
- **codecov 等外部覆盖率服务**：现阶段单 Maintainer，本地阈值门禁已够；引入外部服务增加维护面
- **husky + 本地 git hook 代替远程门禁**：已被用户否决（选择 GitHub Actions 远程门禁），本地 hook 可作为补充但不替代

---

## 验证

| 验证项 | 复现步骤 | 结论 | 经验 | 验证 Branch |
|--------|---------|------|------|------------|
| CI 可运行 | push 后触发 Actions，确认 tsc + vitest + coverage 全执行 | 通过（run 29901827795、29902033763 success） | pull_request 工作流取自 base 分支——工作流未合并到 develop 前，PR 不触发 CI | ci/0002-test-infra |
| MR 门禁正确拦截 | 提交故意失败的测试 PR，确认 status check 报红阻断合并 | 通过（PR #2：run 29902198447 failure，`gh pr merge` 被拒 "base branch policy prohibits the merge"） | 分支保护 required check=`test`，enforce_admins | 同上 |
| 提测门禁正确拦截 | 构造不达标 Report（缺 AC 标注），确认 check-report 报错 | 通过（植入坏 Report：2 violations，exit 1） | 无 Report 时 vacuous pass；跳过 `*-template` 容器 | 同上 |
| 覆盖率数据准确 | 对已知代码基线跑覆盖率，与人工统计比对 | 通过（usage.ts：branches/functions 人工统计 0/0 与 v8 一致；statements 仅粒度差异，覆盖判定一致 100%） | v8 按子表达式段计 statements，纯声明式 zod 文件 branches/functions 为 0 | 同上 |
| 系统测试框架可跑冒烟 | vite-node 运行 e2e 冒烟脚本，确认启动成功 | 通过（本地 + CI 均 OK） | ahs-report.ts 在未合并 spike 分支，故为框架级占位；真实 CLI 用例 DEVELOP 落地 | 同上 |

---

## 后果

### 正面

- 无付费/网络依赖，CI 完全自包含，运行快且确定
- fixture 策略在 spike 中已验证，无新风险

### 负面

- 合成 fixture 与真实格式的漂移需靠适配器作者维护（真实数据 sweep 不进 CI，作为发布前本地检查）
- node:sqlite 为 Node 22 实验特性，CI 镜像需固定 Node ≥ 22.5
