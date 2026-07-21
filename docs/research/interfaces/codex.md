# Codex 交互接口

## Transport: CLI

### 二进制

`codex`（Rust 二进制，Homebrew 安装）

### 启动模式

| 模式 | 命令 |
|------|------|
| 交互式 | `codex [prompt]` |
| 非交互式 | `codex exec [prompt]` |
| 从 stdin | `codex exec`（读取 stdin） |
| Code Review | `codex review` / `codex exec review` |
| 应用 diff | `codex apply` / `codex a` |

### Session 管理

| 操作 | 命令 |
|------|------|
| 恢复会话 | `codex resume [id]`（交互式选择器） |
| 恢复最近 | `codex resume --last` |
| 归档 | `codex archive [id]` |
| 取消归档 | `codex unarchive [id]` |
| 删除 | `codex delete [id]` |
| Fork | `codex fork [id]` |
| Cloud 浏览 | `codex cloud` |

### 非交互式 Session

| 操作 | 命令 |
|------|------|
| 恢复+执行 | `codex exec resume [--last] [id] [prompt]` |
| Review+执行 | `codex exec review` |

### 配置覆盖

所有命令支持 `-c key=value` 覆盖 `config.toml`：

```
codex -c model="o3" exec "fix the bug"
codex -c 'sandbox_permissions=["disk-full-read-access"]' exec "analyze"
```

### 诊断

| 操作 | 命令 |
|------|------|
| 诊断 | `codex doctor` |
| 更新 | `codex update` |
| 功能标志 | `codex features` |
| 补全脚本 | `codex completion` |

### 配置

`~/.codex/config.toml`（TOML）：

```toml
model_provider = "custom"
model = "gpt-5.6-sol"
disable_response_storage = true
model_reasoning_effort = "medium"

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "https://..."

[projects."/path/to/project"]
trust_level = "trusted"
```

## Transport: ACP

**支持（第三方适配器）。**

Codex CLI 通过 [Zed 的 `codex-acp`](https://github.com/zed-industries/codex-acp) 适配器支持 ACP。

### MCP Server（替代协议）

Codex 原生支持 MCP Server 模式：

```
codex mcp-server [options]
```

通过 stdio 启动 Codex 作为 MCP Server。

| 选项 | 说明 |
|------|------|
| `-c key=value` | 配置覆盖 |
| `--strict-config` | 严格配置模式 |
| `--enable <feature>` | 启用功能 |
| `--disable <feature>` | 禁用功能 |

### 实验性接口

| 接口 | 命令 | 说明 |
|------|------|------|
| App Server | `codex app-server` | 应用服务器 |
| Remote Control | `codex remote-control` | 远程控制守护进程 |
| Exec Server | `codex exec-server` | 独立执行服务器 |

---

## 适配器要点

- **非交互式 CLI**：`codex exec [prompt]`
- **Session 恢复**：`codex exec resume [--last] [id] [prompt]`
- **MCP Server**：`codex mcp-server`（stdio）
- **配置覆盖**：`-c key=value`（TOML 路径）
- **配置**：`~/.codex/config.toml`