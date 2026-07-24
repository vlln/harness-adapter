## 当前系统状态

| 字段 | 值 |
|------|-----|
| **当前阶段** | `RELEASE` |
| **设计评估** | readManifest 接口补全 + 实现（SYSTEM_TEST 通过，271 tests + 7 e2e chains） |

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

当前处于 **RELEASE** 阶段（v0.2.0 发布后增量迭代完成）：

- 不新增功能。`release/*` 分支从 `develop` 拉出，整理 CHANGELOG，合并回 `main` + `develop`，在 `main` 上打 tag `vX.Y.Z`。
- 契约已冻结：Vision/Spec/AC/Interface = `active`，ADR = `accepted`。
- 本轮迭代成果：HarnessAdapter 接口补全 `readManifest(sessionId)`，writeArchive/facade 改用，ahs-export CLI。
- 快速通道（验证性开发 / 微修改 / hotfix）见 [CONTRIBUTING.md](../../CONTRIBUTING.md) 第八节。

### 快速通道（项目自定义）

| 通道 | 适用情况 | 跳过什么 | 不跳过什么 |
|------|---------|---------|-----------|
| A. 验证性开发 | 契约冻结前，为验证/推翻设计而写的适配器原型 | 执行容器（Plan/Report） | spike/* 分支保留不合并；产出必须回流为 ADR 验证段或 Spec 修订 |
| B. 微修改 | typo、措辞澄清、research 文档补充、不影响行为的代码格式 | 执行容器、独立分支（可直提 develop） | 文档/代码分开 commit |
| C. hotfix | devloop 原生通道 | — | — |

永不走快速通道：契约文档 promote（draft→proposed→active 必须经审查）、阶段门禁、契约冻结后的 feat 开发。
