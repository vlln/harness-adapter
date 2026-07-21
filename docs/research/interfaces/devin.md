# Devin 交互接口

## Transport: CLI

### 二进制

`devin`（Rust 二进制，`~/.local/bin/devin`）

### 启动模式

| 模式 | 命令 |
|------|------|
| 交互式 | `devin [prompt]` |
| 非交互式 | `devin -p [prompt]` / `devin --print [prompt]` |
| 从文件 | `devin --prompt-file <file>` |

### Session 管理

| 操作 | 命令 |
|------|------|
| 继续最近 | `devin -c` / `devin --continue` |
| 选择恢复 | `devin -r [id]` / `devin --resume [id]` |
| 列出会话 | `devin list [--format json|csv]` |
| 导出 | `devin --export [path]` |

### 权限模式

| 模式 | 说明 |
|------|------|
| `auto` | 自动批准只读工具（默认） |
| `accept-edits` | 也自动批准工作区编辑 |
| `smart` | 另外自动运行快速模型判断安全的操作 |
| `dangerous` | 自动批准所有工具 |

```
devin --permission-mode accept-edits
```

### 其他命令

| 命令 | 说明 |
|------|------|
| `devin auth` | 认证管理 |
| `devin models` | 列出可用模型 |
| `devin rules` | 管理 Agent 规则 |
| `devin skills` | 管理 Agent 技能 |
| `devin plugins` | 管理插件 |
| `devin cloud` | 管理云端资源 |
| `devin update` | 检查更新 |
| `devin version` | 打印版本 |
| `devin migrate` | 从其他工具迁移配置 |
| `devin sandbox` | 进程沙箱（Research Preview） |
| `devin setup` | 交互式设置向导 |
| `devin shell` | Shell 集成（Feature Preview） |
| `devin uninstall` | 卸载并删除数据 |

### 配置

`~/.config/devin/config.json`（JSON）：

```json
{
  "version": 1,
  "devin": { "org_id": "org-..." },
  "agent": { "model": "claude-5-fable-medium" },
  "permissions": { "allow": ["Read(...)", "Write(...)"] },
  "theme_mode": "dark"
}
```

## Transport: ACP

### 启动

```
devin acp [options]
```

Run as an ACP (Agent Client Protocol) server over stdio.

### Agent 类型

| 类型 | 说明 |
|------|------|
| `default` | 标准 Agent（全部工具，默认） |
| `summarizer` | 摘要 Agent，无工具。输出到 `~/.local/share/devin/summaries/<session_id>.md` |
| `review` | 代码审查 Agent，只读+shell 工具 |

```
devin acp --agent-type summarizer
devin acp --agent-type review
```

### 特点

- 纯 stdio 传输
- 多种 Agent 类型切换
- summarizer 通过 Cog 机制持久化（`PostAgentIteration` cog）
- 标准 Agent 拥有完整工具集

---

## 适配器要点

- **非交互式 CLI**：`devin -p <prompt>`
- **ACP**：`devin acp [--agent-type <type>]`（stdio）
- **Session 列表**：`devin list --format json`
- **Session 恢复**：`devin -r <id> -p <prompt>`
- **配置**：`~/.config/devin/config.json`