## 当前系统状态

| 字段 | 值 |
|------|-----|
| **当前阶段** | `TEST_INFRA` |
| **设计评估** | — |

Agent 中断恢复时，用 `git log --oneline --grep="docs(state):\|docs(plan):"` 重建上下文。

## 子目录

| 路径 | 用途 |
|------|------|
| [vision.md](vision.md) | 全局顶层愿景 |
| [research/](research/) | 调研文档：9 个 Harness 存储 Schema、交互接口、版本锁定（Spec/ADR 的依据，保留不动） |
| [spec/](spec/) | Spec：AHS 格式规范（Manifest、Record、Usage、Relation） |
| [interface/](interface/) | 接口定义：HarnessAdapter 契约 |
| [adr/](adr/) | 架构决策记录 |
| [ac/](ac/) | 验收标准：适配器四层验收 |
| [plans/](plans/) | 执行容器（Plan + Report） |

## 读取顺序

```
1. AGENTS.md           → 项目入口地图：文档类型、目录结构、系统边界、阶段行为
2. docs/README.md      → 当前系统状态 + 行为边界（本文件）
3. CONTRIBUTING.md     → 编码/测试/PR 规范
4. 各级 README.md      → 子目录索引和状态
5. 具体文档             → Vision / Spec / AC / ADR / Plan / Report
```

## 行为边界

当前处于 **TEST_INFRA** 阶段：

- 契约已冻结（2026-07-21 审查通过）：Vision/Spec/AC/Interface = `active`，ADR = `accepted`。冻结后不可原地修改——契约变更须退回 DESIGN 走 ADR 修订流程（typo、措辞澄清等非破坏性修改除外，走快速通道 B）。
- 本阶段只做一次性基建：`ci/*` `test/*` `build/*` 分支 → develop（CI 流水线、覆盖率、MR 门禁、系统测试框架）。
- 不写正式业务功能代码。正式适配器开发等 TEST_INFRA 门禁通过后在 DEVELOP 阶段以 `feat/*` 执行容器进行（spike/0001-adapter-prototypes 上的 4 个适配器原型为设计证据，保留不合并，作为正式实现的参考底稿）。

### 快速通道（项目自定义）

| 通道 | 适用情况 | 跳过什么 | 不跳过什么 |
|------|---------|---------|-----------|
| A. 验证性开发 | 契约冻结前，为验证/推翻设计而写的适配器原型 | 执行容器（Plan/Report） | spike/* 分支保留不合并；产出必须回流为 ADR 验证段或 Spec 修订 |
| B. 微修改 | typo、措辞澄清、research 文档补充、不影响行为的代码格式 | 执行容器、独立分支（可直提 develop） | 文档/代码分开 commit |
| C. hotfix | devloop 原生通道 | — | — |

永不走快速通道：契约文档 promote（draft→proposed→active 必须经审查）、阶段门禁、契约冻结后的 feat 开发。
