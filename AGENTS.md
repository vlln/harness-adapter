## 一、项目简介

harness-adapter 是一个 TypeScript 库，定义 **AHS（Agent History Standard）**——编码 Agent 会话历史的离线交换与消费格式（有损但有原则），并提供只读适配器，将各 Harness（Claude Code、Codex、Kimi Code 等）的原生存储投影为 AHS。上层工具（调度、评测、可视化、迁移）一次对接 AHS，全生态共享。

技术栈：TypeScript（strict，ESM）+ zod v4（Schema 定义，可导出 JSON Schema）+ vitest。

---

## 二、文档体系

### 文档类型

| 文档 | 用途 |
|------|------|
| 本文档（AGENTS.md） | 项目入口地图 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 编码/Commit/文档/测试规范（含快速通道规则） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录（Keep a Changelog） |
| [docs/vision.md](docs/vision.md) | 全局顶层愿景（有 frontmatter） |
| [docs/spec/](docs/spec/) | Spec：AHS 格式规范（Manifest、Record、Usage、Relation 模型） |
| [docs/interface/](docs/interface/) | 接口定义：HarnessAdapter 契约 |
| [docs/ac/](docs/ac/) | 验收标准（AC）：适配器四层验收（合法/完整/保真/可用）。测试唯一权威依据 |
| [docs/adr/](docs/adr/) | 架构决策记录：有损投影、Session/Relation 模型、技术选型 |
| [docs/plans/](docs/plans/) | 执行容器：对应一个 Git 分支，内含 Plan + Report 成对 |
| [docs/research/](docs/research/) | 调研文档：9 个 Harness 的存储 Schema、交互接口、版本锁定（历史产出，Spec/ADR 的依据，原地保留） |
| [docs/README.md](docs/README.md) | 子目录索引 + **当前系统状态**（首先读取） |
| 各级 README.md | 该目录的索引和状态说明 |

### 文档目录结构

```
项目根目录
├── AGENTS.md
├── CONTRIBUTING.md
├── CHANGELOG.md
├── README.md
├── package.json / tsconfig.json
├── src/
│   ├── index.ts           # 库入口
│   ├── schema/            # AHS zod schemas（manifest / record / relation / usage / blob）
│   └── store/             # HarnessAdapter 只读接口
├── test/                  # vitest 单元测试
└── docs/
    ├── README.md          # 索引 + 当前系统状态
    ├── vision.md
    ├── research/          # 调研文档（保留，不动）
    ├── spec/              # AHS 规范
    ├── interface/         # HarnessAdapter 契约
    ├── ac/                # 适配器验收标准
    ├── adr/               # 架构决策记录
    └── plans/             # 执行容器（Plan + Report）
```

---

## 三、阶段行为

项目遵循 devloop 6 阶段状态机（INIT → DESIGN → TEST_INFRA → DEVELOP → SYSTEM_TEST → RELEASE），当前阶段见 [docs/README.md](docs/README.md)。

- **DESIGN（当前）**：只写/改契约文档（Vision/Spec/AC/ADR/Interface），在 `develop` 上进行；ADR 验证性适配器原型走 `spike/*` 分支（保留不合并）。不写正式功能代码。
- **TEST_INFRA**：`ci/*` `test/*` 分支搭建 CI、测试基建，合并回 `develop`。
- **DEVELOP**：`feat/*` 分支实现适配器，每个任务一个执行容器（docs/plans/），TDD 覆盖 AC。
- **RELEASE**：不新增功能。`release/*` 分支从 `develop` 拉出，整理 CHANGELOG，合并回 `main` + `develop`，在 `main` 上打 tag `vX.Y.Z`。
- 快速通道（验证性开发 / 微修改 / hotfix）见 [CONTRIBUTING.md](CONTRIBUTING.md) 第八节。

---

## 四、系统边界

- **范围内**：AHS 格式定义（schema）；各 Harness 原生存储 → AHS 的只读投影适配器；消费方示例工具（examples/）。
- **范围外（当前）**：通过 ACP 等在线协议的控制面（启动/恢复/停止会话）——愿景中保留，本阶段不实现；AHS → 源格式的逆向写回（不追求双向可逆）；备份/归档（无损性由源数据提供，AHS 不复制原始记录）。
