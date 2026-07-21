# Kimi Code 交互接口

## Transport: CLI

### 二进制

`kimi`（Go 二进制，`~/.kimi-code/bin/kimi`）

### 启动模式

| 模式 | 命令 |
|------|------|
| 交互式 | `kimi [prompt]` |
| 非交互式 | `kimi -p <prompt>` / `kimi --prompt <prompt>` |
| 文本输出 | `kimi -p --output-format text` |
| 流式 JSON | `kimi -p --output-format stream-json` |
| Plan 模式 | `kimi --plan` |
| YOLO 模式 | `kimi -y` / `kimi --yolo` |
| 自动模式 | `kimi --auto` |

### Session 管理

| 操作 | 命令 |
|------|------|
| 继续最近 | `kimi -c` / `kimi --continue` |
| 选择恢复 | `kimi -S [id]` / `kimi --session [id]` |
| 导出 | `kimi export [sessionId]` → ZIP 归档 |
| 可视化 | `kimi vis [sessionId]` → 浏览器 |
| 迁移 | `kimi migrate`（从旧版 kimi-cli） |

### 模型

| 操作 | 命令 |
|------|------|
| 指定模型 | `kimi -m <model>` / `kimi --model <model>` |

### 工作目录

| 操作 | 命令 |
|------|------|
| 额外目录 | `kimi --add-dir <dir>`（可重复） |

### 诊断

| 操作 | 命令 |
|------|------|
| 配置验证 | `kimi doctor` |
| 升级 | `kimi upgrade` / `kimi update` |

### 配置

`~/.kimi-code/config.toml`（TOML）：

```toml
default_model = "alibaba-cn/deepseek-v4-pro"

[providers.alibaba-cn]
type = "openai"
api_key = "sk-..."
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"

[models."alibaba/qwen3-coder-plus"]
provider = "alibaba"
model = "qwen3-coder-plus"
max_context_size = 1048576
capabilities = ["tool_use"]
```

## Transport: ACP

### 启动

```
kimi acp [options]
```

Run kimi-code as an Agent Client Protocol (ACP) server over stdio.

### 选项

| 选项 | 说明 |
|------|------|
| `--login` | 运行设备码登录流程后退出（ACP terminal-auth 入口） |

### 特点

- 纯 stdio 传输
- 通过 `config.toml` 预配置模型和 provider
- 支持设备码认证流程

---

## Transport: Web

### 启动

```
kimi web [options]
```

启动本地 Kimi 服务器并打开 Web UI。

---

## 适配器要点

- **非交互式 CLI**：`kimi -p --output-format stream-json <prompt>`
- **ACP**：`kimi acp`（stdio JSON-RPC）
- **Session 恢复**：`kimi --session <id> -p <prompt>`
- **导出**：`kimi export <sessionId>` → ZIP
- **配置**：`~/.kimi-code/config.toml`