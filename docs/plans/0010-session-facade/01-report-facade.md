---
title: Report 01 Session Facade 实现
description: 按 interface/0003 实现 src/session/（openHarness 注册 + AhsSession/AhsTask 双视图）；投影规则逐行覆盖、XOR 配对、children 递归与静默跳过、Task HEAD 链拼接三态切分；202 测试全绿、覆盖率 98.24%/88.69%。
type: report
status: complete
created: 2026-07-23T22:19:00Z
---

# 01-report: Session Facade 实现

---

## 执行摘要

成功。按 [interface/0003-session-facade.md](../../interface/0003-session-facade.md)（proposed）完成 `src/session/` facade 实现：`openHarness` 注册入口（4 适配器 + basePath 注入）、`AhsSession`（存储视角：manifest/messages/events/usage/children）、`AhsTask`（用户视角：groupId/head/members/HEAD 链拼接 messages）。组/HEAD 机制复用 `src/ahs/relations.ts`（buildRelations 两段式：manifest-only 分组 → 物化组成员后重推 HEAD 与边），未复制逻辑。`npx tsc --noEmit` 零错误；`npx vitest run --coverage` 15 文件 / **202 测试全绿**（新增 15），覆盖率 **98.24% stmts / 88.69% branch / 100% funcs / 98.24% lines**（src/session 98.23% / 91.96%）；`npm run test:e2e` 4/4 链路通过；`node scripts/check-report.ts` 通过。契约未改，一处加性观察见"契约摩擦"。

---

## 关联 Commit

| Commit Hash | 说明 |
|-------------|------|
| d529333 | feat(session): AHS session facade (interface-0003)（feat/0010-session-facade，PR #33 合并为 d28be2f） |
| （docs commit 见 PR） | docs(plan): 0010 Plan 01 完成（本文件 + 状态翻转） |

---

## 产物清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 公共类型 | src/session/types.ts | ConversationItem / StateEvent / AhsSession / AhsTask / HarnessFacade |
| 实现 | src/session/facade.ts | projectMessages、SessionView/TaskView/FacadeImpl、createFacade、openHarness、SessionNotFoundError |
| 模块出口 | src/session/index.ts、src/index.ts | 库入口导出 facade（其他并行容器被告知不动 src/index.ts，本 Plan 负责） |
| 测试 | test/session-facade.test.ts | 15 测试，契约点全覆盖（见对照表） |

## API 面（与契约一致）

```typescript
openHarness(name: "claude-code" | "codex" | "kimi-code" | "devin", options?: { basePath?: string }): HarnessFacade
createFacade(adapter: HarnessAdapter): HarnessFacade   // 测试/自定义注入 seam
// HarnessFacade: adapter · listSessions(filter?) · loadSession(id) · loadTask(id)
// AhsSession: manifest · messages() · events() · usage · children()
// AhsTask: groupId · head · members · messages()
// SessionNotFoundError（.sessionId）
```

实现要点：facade 只做内存物化与投影（大 session 指引走底层 readRecords 流）；loadSession/loadTask 先扫 `listSessions({ includeForks: true })` 拿全量 manifest（组解析的声明成本），再物化所需 session 的 records；`AhsTask.messages()` 为同步方法，拼接在 loadTask 内完成（契约签名如此）。

---

## 契约点对照 PASS 表

| interface/0003 契约点 | 结果 | 证据（test/session-facade.test.ts） |
|----------------------|------|------|
| 入口 openHarness 注册 4 适配器 + basePath | PASS | "opens all four registered harnesses"（4 名 + 默认 basePath）；"rejects an unknown harness name" |
| listSessions 透传底层 | PASS | "listSessions passes through to the adapter" |
| messages() 映射表：user/assistant/harness 行 | PASS | "projects the mapping table row by row, in seq order"（kinds 序列 + content/timestamp） |
| messages() 映射表：tool 行（配对在投影内完成） | PASS | 同上：tool item 含 call{name,args}/result{content,status}/sessionIds；"pairs with the FIRST result in seq order; drops unpaired results defensively" |
| XOR：interrupted → tool item 无 result | PASS | "not.toHaveProperty('result')"（与 AC-0002-N-6 一致） |
| 状态类 record 进 events() 不进 messages() | PASS | "events() exposes state records in seq order"（turn_boundary×2/model_change/compaction/goal_update） |
| usage = 本 session records 求和 | PASS | "usage sums the session's own records" |
| children() 直接子 session + 消费方递归 | PASS | "returns direct children (back-link + forward link) and recurses"（root→sub→grand） |
| 子 session 不可发现静默跳过 | PASS | "skips undiscoverable children silently"（正链指向店外 session 不报错） |
| loadSession/loadTask 未知 id 抛 SessionNotFoundError | PASS | 两条 throws 测试（instanceof + .sessionId） |
| Task 组解析（扫 store manifests）+ HEAD 最近活跃启发式 | PASS | 各 Task 测试断言 groupId/members/head（T 序最大者） |
| Task messages() 拼接：锚点切分、前缀不重复 | PASS | "stitches the HEAD chain"（切于 atRecordId、"build it" 仅一次、废弃尾巴不渲染）；"chained forks (a → b → c)" |
| Task 拼接三态：null = 父段全量；缺省 = 父段零贡献 | PASS | "null atRecordId … kept in full"；"retry-from-start … parent contributes nothing" |
| 不变量：facade 只依赖底层契约数据 | PASS | 全部测试经 fakeAdapter（内存 SessionData）驱动，无源存储接触；实现仅 import schema/store/relations |
| 大 session 内存顾虑 → 底层流式 | PASS（文档） | facade.ts 模块注释声明；listSessions/readRecords 底层不变 |

---

## 契约摩擦与观察（未擅自改契约）

1. **ConversationItem tool 行缺 timestamp（加性补充）**：契约映射表的 user/assistant/harness 三行均带 `timestamp`，tool 行未列。实现为全部 item（含 tool）携带 timestamp——时间线展示与 events() 对齐必需，属加性字段不矛盾契约形状。**建议契约修订时补记**。
2. **usage 聚合的 cost 多币种**：`AhsSession.usage` 是单个 Usage（单币种 cost 槽），record 级 cost 若混币种无法无损表达。实现按币种求和后取字典序首个币种（注释声明）；真实数据中 record 级 cost 仅见单币种（测试 fixture USD），无实际影响。
3. **children() 的"直接子"口径**：契约写"invocation 回链反查（等价于关系存储的 invocation 边）"。实现取回链子 ∪ 本 session records 正链 sessionIds 目标的并集（= 关系存储 invocation 边的两个来源），不含 fork-of-subagent 闭包继承边（非"直接"子）。与关系存储 `invocationChildEdges` 语义一致。
4. **组解析两段式**：契约允许扫全量 manifest；HEAD 需要组内 records 的末条时间戳，实现仅物化组成员（不读全库 records），成本 = 全量 manifest + 组内 records，优于朴素全量物化。

---

## 失败原因分类

无失败。实现一次通过（15/15 新测试首跑全绿），无返工。

## 阻塞级缺陷判定

**无阻塞级缺陷。** interface/0003 全部契约点有测试覆盖；底层接口零改动；无新运行时依赖。

---

## 测试摘要

- `npx tsc --noEmit`：通过
- `npx vitest run --coverage`：**202 tests 全绿**（15 文件，新增 test/session-facade.test.ts 15 测试）；覆盖率 **98.24% stmts / 88.69% branch / 100% funcs / 98.24% lines**（阈值 ≥80%；src/session 98.23% / 91.96%）
- `npm run test:e2e`：smoke OK + 4 条适配器链路 OK
- CI：PR #33 status check `test` 绿，mergeStateStatus CLEAN 后合并
- `node scripts/check-report.ts`：通过

---

## 验收结果

| AC | 结果 | 证据 |
|----|------|------|
| AC-0002-N-6（tool 配对 XOR 在消费投影一致） | PASS | 投影内配对：首条结果获胜、interrupted 无 result、孤儿 result 防御性丢弃（测试 2 条） |
| AC-0004-N-1（消费可用） | PASS | facade 双视图（loadSession/loadTask）从底层契约数据渲染对话与 Task 链，契约点全表 PASS |
