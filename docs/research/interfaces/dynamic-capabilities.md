# Harness 动态能力注入对比

## 概述

对比各 Harness 在**启动时动态注入**以下能力：Skills、MCPs、Tools、System Prompt、Hooks、Agents（复合 profile）。

"动态注入"指通过 CLI 参数或配置文件在启动时指定，而非硬编码在 harness 内部。

## 总表

| Harness | Skills | MCPs | Tools | System Prompt | Hooks | Agents |
|---------|--------|------|-------|---------------|-------|--------|
| **Pi Agent** | `--skill` | ❌ | `--tools`/`--exclude-tools` | `--system-prompt`/`--append-system-prompt` | 通过 Extension | 通过 Extension |
| **Claude Code** | Plugin/Settings | `--mcp-config` | `--allowedTools`/`--disallowedTools` | `--system-prompt`/`--append-system-prompt` | `--bare`/`--include-hook-events` | `--agent`/`--agents` |
| **Kimi Code** | `--skills-dir` | ❌ | ❌ | ❌（仅 config） | ❌ | ❌ |
| **Codex** | Plugin | `codex mcp` | Config | Config | `--dangerously-bypass-hook-trust` | ❌ |
| **Qwen Code** | 内置 | ❌ | ❌ | ❌ | ❌ | 内置 |
| **OpenCode** | 项目 `.opencode/` | ❌ | ❌ | ❌ | ❌ | 项目 `.opencode/agents/` |
| **Devin** | `devin skills` | `devin mcp` | `--agent-config` | `--agent-config` | ❌ | `--agent-config` |
| **Cursor** | IDE 内置 | IDE 内置 | IDE 内置 | IDE 设置 | ❌ | IDE 内置 |
| **Grok** | `--agent-profile`/Plugin | `grok mcp`/`--plugin-dir` | `--tools`/`--disallowed-tools`/`--allow`/`--deny` | `--system-prompt-override`/`--rules` | `--plugin-dir` | `--agent`/`--agent-profile`/`--agents` |

---

## 1. Skills

### Pi Agent
```
--skill <path>    # 加载 skill 文件或目录（可重复）
--no-skills       # 禁用 skills 发现和加载
```
自动发现：用户级和项目级 skills 目录。

### Claude Code
通过 Settings 和 Plugin 系统管理 skills。`/skill-name` 在交互式会话中动态调用。
```
--bare            # 最小模式：跳过 skills（但 /skill-name 仍可用）
```
自动发现：`CLAUDE.md` 目录中的 skills。

### Kimi Code
```
--skills-dir <dir>  # 加载 skills 目录（可重复，替代自动发现）
```
自动发现：用户级和项目级 skills 目录。

### Codex
通过 Plugin 系统管理 skills。

### Qwen Code
内置 skills 系统。`~/.qwen/skills/` 目录。

### OpenCode
项目级 `.opencode/` 目录中的 agent 定义（Markdown 格式）。

### Devin
```
devin skills list    # 列出所有 skills
devin skills show    # 查看详情
devin skills paths   # 显示路径
```
自动发现 + 用户管理。

### Cursor
IDE 内置，通过扩展系统管理。

### Grok
```
--agent-profile <path>    # Agent profile 中包含 skills 配置
--plugin-dir <dir>        # 插件目录（可重复，最高优先级）
```
内置：`~/.grok/skills/` + `~/.grok/bundled/skills/`（design, execute-plan, implement, pr-babysit, resume-claude, review）。

---

## 2. MCPs

### Pi Agent
❌ 不支持。

### Claude Code
```
--mcp-config <json>        # 加载 MCP 服务器配置（可重复，JSON 文件或字符串）
--strict-mcp-config        # 仅使用 --mcp-config，忽略所有其他 MCP 配置
claude mcp add/remove      # 管理持久化 MCP 服务器
```
自动发现：`.mcp.json` 文件。

### Kimi Code
❌ 不支持。

### Codex
```
codex mcp                  # 管理外部 MCP 服务器
codex mcp-server           # 启动 Codex 作为 MCP Server（stdio）
```

### Qwen Code
❌ 不支持。

### OpenCode
❌ 不支持。

### Devin
```
devin mcp                  # 连接和登录 MCP 服务器
```

### Cursor
IDE 内置 MCP 配置（`mcps/` 目录中有 `cursor-app-control` 和 `cursor-ide-browser` 的 tool 定义）。

### Grok
```
grok mcp list/add/remove/doctor    # 管理 MCP 服务器
--plugin-dir <dir>                  # 插件中的 MCP 服务器自动激活（always trusted）
```
ACP 模式下：`session/new` 的 `mcpServers` 参数传递 MCP 配置。

---

## 3. Tools（动态 allow/deny）

### Pi Agent
```
--tools, -t <list>          # 白名单
--exclude-tools, -xt <list> # 黑名单
--no-tools, -nt             # 禁用所有工具
--no-builtin-tools, -nbt    # 仅禁用内置工具
```

### Claude Code
```
--allowedTools <tools>       # 白名单（支持模式匹配，如 "Bash(git *) Edit"）
--disallowedTools <tools>    # 黑名单
```

### Kimi Code
❌ 不支持 CLI 级别控制。通过 `config.toml` 的权限配置间接控制。

### Codex
通过 `config.toml` 的 `sandbox_permissions` 和 `approvals_reviewer` 配置。

### Qwen Code
❌ 不支持。

### OpenCode
❌ 不支持。

### Devin
通过 `--agent-config <file>` 声明式配置文件控制工具可见性和权限。

### Cursor
IDE 内置，通过权限模式控制。

### Grok
```
--tools <TOOLS>              # 白名单
--disallowed-tools <TOOLS>   # 黑名单
--allow <RULE>               # 权限允许规则（Claude Code 兼容）
--deny <RULE>                # 权限拒绝规则
--always-approve             # 自动批准所有工具
--disable-web-search         # 禁用 web 搜索工具
```

---

## 4. System Prompt

### Pi Agent
```
--system-prompt <text>          # 替换默认 system prompt
--append-system-prompt <text>   # 追加到默认 system prompt（可重复）
```

### Claude Code
```
--system-prompt <prompt>        # 替换 system prompt
--append-system-prompt <prompt> # 追加 system prompt
```

### Kimi Code
❌ 不支持 CLI 级别。通过 `config.toml` 的 provider/model 配置间接控制。

### Codex
通过 `config.toml` 配置。

### Qwen Code
通过 `~/.qwen/output-language.md` 间接影响（仅语言偏好）。

### OpenCode
❌ 不支持。

### Devin
通过 `--agent-config <file>` 声明式配置文件中的 `system instructions` 字段。

### Cursor
IDE 设置中的 Rules 和自定义指令。

### Grok
```
--system-prompt-override <prompt>  # 完全替换 system prompt
--rules <rules>                     # 追加规则到 system prompt
```
ACP 模式下：`session/new` 的 `_meta.systemPromptOverride` 和 `_meta.rules`。

---

## 5. Hooks

### Pi Agent
通过 Extension 系统实现。Extension 可注册 lifecycle hooks。

### Claude Code
```
--bare                    # 跳过所有 hooks + LSP + plugin sync + auto-memory
--include-hook-events     # 在 --print 流式输出中包含 hook 生命周期事件
```
Hook 过滤：`--debug <filter>` 支持 `"api,hooks"` 等过滤。

### Codex
```
--dangerously-bypass-hook-trust   # 跳过 hook 信任检查（危险，仅自动化）
```

### Kimi Code / Qwen Code / OpenCode / Devin / Cursor
❌ 不支持 CLI 级别 hooks 注入。

### Grok
```
--plugin-dir <dir>    # 插件中的 hooks 自动激活（always trusted）
```
Plugin 是最高优先级 scope，hooks 和 MCP 服务器无需提示即可激活。

---

## 6. Agents（复合能力 Profile）

**Agent 是核心概念**：将 Skills、MCPs、Tools、System Prompt、Hooks 等打包为一个可复用的 profile，在启动时动态注入。

### 支持情况

| Harness | 动态 Agent 注入 | 方式 | 格式 |
|---------|----------------|------|------|
| **Claude Code** | ✅ | `--agent <name>` / `--agents <json>` | JSON inline |
| **Grok** | ✅ | `--agent <name>` / `--agent-profile <path>` / `--agents <json>` | TOML + Markdown |
| **Devin** | ✅ | `--agent-config <file>` | JSON/YAML file |
| **Pi Agent** | ⚠️ | 通过 Extension 组合 | Extension 文件 |
| **OpenCode** | ⚠️ | 项目 `.opencode/agents/` | Markdown |
| **Kimi Code** | ❌ | — | — |
| **Codex** | ❌ | — | — |
| **Qwen Code** | ❌ | 仅内置 agents | — |
| **Cursor** | ❌ | IDE 内置模式 | — |

### Claude Code

```
--agent <agent>     # 使用预定义的 agent（覆盖 settings 中的 'agent' 设置）
--agents <json>     # 内联定义自定义 agents
```

```json
{
  "reviewer": {
    "description": "Reviews code",
    "prompt": "You are a code reviewer"
  }
}
```

### Grok

三种方式定义 agent：

**1. 内置 agent 名称：**
```
--agent general-purpose
--agent explore
--agent plan
```

**2. Agent profile 文件（TOML + Markdown）：**
```
--agent-profile /path/to/profile.toml
```

**3. 内联 JSON：**
```
--agents '{"name": "reviewer", "description": "...", "prompt": "..."}'
```

Grok 的 agent 系统最丰富，包含：
- **Personas**（7 个）：implementer, reviewer, test-writer, design-doc-writer, design-doc-reviewer, security-auditor, researcher
- **Roles**（9 个）：对应的 TOML 角色定义
- **Agents**（3 个）：general-purpose, explore, plan
- 每个 Persona 定义 `inputs`/`outputs`（文件参数）、`default_capability_mode`、`default_fork_context`

### Devin

```
--agent-config <file>    # JSON 或 YAML 声明式配置
```

定义：system instructions, tool visibility, permissions。使用严格解析，未知字段会报错。

---

## 关键发现

### 1. Agent Profile 是最高级抽象

只有 **Claude Code**、**Grok**、**Devin** 三个 Harness 支持完整的 Agent Profile 概念——将 Skills、MCPs、Tools、System Prompt 打包为一个可复用的动态注入单元。

### 2. Grok 的 Agent 系统最成熟

- 分层设计：Agents > Personas > Roles
- 声明式 I/O：Persona 定义 `inputs`/`outputs`（文件参数）
- 多种注入方式：名称、文件路径、内联 JSON
- ACP 原生支持：`session/new` 的 `_meta.agentProfile`

### 3. MCP 支持分化

| 级别 | Harness |
|------|---------|
| MCP Client + Server | Codex |
| MCP Client（管理 + 动态注入） | Claude Code, Grok, Devin |
| MCP Client（仅 IDE 内置） | Cursor |
| 不支持 | Pi Agent, Kimi Code, Qwen Code, OpenCode |

### 4. Hooks 是最弱的环节

只有 Pi Agent（通过 Extension）、Claude Code、Codex 和 Grok（通过 Plugin）支持 hooks。大多数 harness 没有暴露 hooks 接口。

### 5. 对统一抽象库的影响

```typescript
interface AgentProfile {
  name: string
  description?: string
  systemPrompt?: string
  rules?: string[]
  skills?: string[]           // Skill 路径或名称
  mcpServers?: MCPConfig[]    // MCP 服务器配置
  tools?: {
    allow?: string[]          // 白名单
    deny?: string[]           // 黑名单
  }
  hooks?: HookConfig[]        // Hook 配置
  permissionMode?: string     // 权限模式
  model?: string              // 模型
  reasoningEffort?: string    // 推理努力
}

interface HarnessAdapter {
  // 动态注入 Agent Profile
  launchWithProfile(profile: AgentProfile): AgentProcess
}
```

Grok 的 `--agent-profile` + `--plugin-dir` 组合是最接近这个理想接口的实现。Claude Code 的 `--agents` JSON 次之。Devin 的 `--agent-config` 文件方式更适合声明式配置。