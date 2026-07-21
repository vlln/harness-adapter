# CONTRIBUTING

编码与协作规范。Agent 在 DEVELOP 阶段读取。

---

## 一、开发环境

要求 Node.js 20+，包管理器使用 npm。

```bash
npm install        # 安装依赖
npx tsc --noEmit   # 类型检查
npx vitest run     # 运行测试
```

**构建/配置入口：**

| 文件 | 用途 |
|------|------|
| `package.json` | 依赖声明、scripts（`typecheck` / `test`）、ESM 入口 |
| `tsconfig.json` | TypeScript strict 配置 |
| `src/index.ts` | 库入口（导出 schema 与 store 接口） |

---

## 二、代码风格

- 语言：TypeScript strict 模式，ESM（`"type": "module"`）
- Schema 一律用 zod v4 定义（可导出 JSON Schema）
- 代码与注释使用英文；设计文档（docs/）使用中文
- 命名：
  - 文件：kebab-case（如 `record.ts`）
  - 变量/函数：camelCase
  - 类/接口/type：PascalCase
  - 常量：UPPER_SNAKE_CASE
- 适配器为只读纯投影：不写回源存储，不留 `raw`/`extra` 逃生舱（见 docs/adr/0001）

---

## 三、Commit 规则

### 格式

遵循 Conventional Commits：

```
<type>(<scope>): <简短描述>
```

| type | 说明 |
|------|------|
| feat | 新功能 |
| fix | Bug 修复 |
| docs | 文档变更（必须独立提交，不与代码混合） |
| refactor | 重构 |
| test | 测试相关 |
| chore | 构建/工具/依赖 |

### devloop 约定

- 文档变更和代码变更永远分开 commit
- 阶段推进伴随独立 commit，前缀 `docs(state):`
- 执行容器计划/报告类文档 commit 前缀 `docs(plan):`
- 文档 commit 格式：`docs(<scope>): <简述>`

---

## 四、分支策略

遵循 Gitflow：

```
main     ─────●──────────●────→  (tag: v0.1.0, v0.2.0)
              ↑          ↑
release  ──── v0.1.0 ─── v0.2.0
              ↑          ↑
develop  ────●──●──●──●──●──→  (持续集成)
              ↑  ↑  ↑
             ci/ feat/ fix/
```

| 分支 | 用途 | 从哪拉 | 合并到哪 |
|------|------|--------|---------|
| `main` | 仅含 release 节点，始终可部署 | — | — |
| `develop` | 持续集成分支 | `main` | — |
| `feat/*` `refactor/*` `perf/*` | 功能开发 | `develop` | `develop` |
| `ci/*` `test/*` `build/*` | 基建搭建 | `develop` | `develop` |
| `fix/*` | 集成修复 | `develop` | `develop` |
| `spike/*` | ADR 技术验证（如契约冻结前的适配器原型） | `develop` | 不合并（保留） |
| `release/*` | 版本发布 | `develop` | `main` + `develop` |
| `hotfix/*` | 生产热修复 | `main` | `main` + `develop` |

一个执行容器 = 一个分支，编号与执行容器对应。分支类型与 commit type 一致。Merge 策略：merge commit（保留证据链）。

---

## 五、版本策略

版本格式遵循 `MAJOR.MINOR.PATCH`（X.Y.Z），参考 [Semantic Versioning](https://semver.org/)：

| 段 | 何时升 | 示例 |
|----|--------|------|
| MAJOR | 不兼容的 API 变更 | `0.1.0 → 1.0.0` |
| MINOR | 新增功能，向后兼容 | `0.1.0 → 0.2.0` |
| PATCH | 向后兼容的 bug 修复 | `0.1.0 → 0.1.1` |

MAJOR=0 期间（0.x.y）：MINOR 升功能，PATCH 修 bug。契约驱动下 API 实际稳定，版本号仅反映语义。

devloop 特有约定：
- 首次发布从 `0.1.0` 起步
- RELEASE 阶段在 `main` 上打 tag，格式 `vX.Y.Z`
- hotfix 升 PATCH：`v0.1.0 → v0.1.1`

---

## 六、测试

### 测试命令

| 命令 | 用途 |
|------|------|
| `npx tsc --noEmit` | 类型检查（提交前必过） |
| `npx vitest run` | 单元测试 |

### 测试目录

| 层级 | 目录路径 | 说明 |
|------|---------|------|
| 单元测试 | `test/` | vitest，覆盖 schema 校验与适配器逻辑 |

---

## 七、PR 流程

- PR 从 `develop` 拉出，合并回 `develop`（`release/*`、`hotfix/*` 除外）
- PR 描述需关联执行容器（docs/plans/ 编号）与覆盖的 AC 编号
- 合并前 `npx tsc --noEmit` 与 `npx vitest run` 必须全绿

---

## 八、快速通道（项目自定义）

| 通道 | 适用情况 | 跳过什么 | 不跳过什么 |
|------|---------|---------|-----------|
| A. 验证性开发 | 契约冻结前，为验证/推翻设计而写的适配器原型 | 执行容器（Plan/Report） | spike/* 分支保留不合并；产出必须回流为 ADR 验证段或 Spec 修订 |
| B. 微修改 | typo、措辞澄清、research 文档补充、不影响行为的代码格式 | 执行容器、独立分支（可直提 develop） | 文档/代码分开 commit |
| C. hotfix | devloop 原生通道 | — | — |

永不走快速通道：契约文档 promote（draft→proposed→active 必须经审查）、阶段门禁、契约冻结后的 feat 开发。

---

## 九、行为准则

尊重事实，直说分歧；review 对事不对人。

---

## 十、许可证

待定（项目尚未发布）。
