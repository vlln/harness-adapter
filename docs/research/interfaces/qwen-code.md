# Qwen Code 交互接口

## Transport: CLI

### 二进制

`qwen`（npm 包 `@qwen-code/qwen-code`，源码位于 `qwen-code source`，未全局安装）

### 启动模式

基于 npm 包源码和存储结构推断（未实际运行）：

| 模式 | 推断命令 |
|------|---------|
| 交互式 | `qwen [prompt]` |
| 恢复会话 | `qwen --session <id>` |

> 注：Qwen Code CLI 未在本地全局安装，仅保留源码。完整 CLI 接口待实际运行后确认。

### Session 管理

无独立 session 管理 CLI 命令。通过项目目录 `~/.qwen/projects/<cwd>/chats/` 直接管理 JSONL 文件。

### 配置

`~/.qwen/settings.json`（JSON）：

```json
{
  "env": { "DASHSCOPE_API_KEY": "sk-..." },
  "modelProviders": {
    "openai": [
      {
        "id": "deepseek-v4-flash",
        "name": "[ModelStudio Standard] deepseek-v4-flash",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "envKey": "DASHSCOPE_API_KEY"
      }
    ]
  },
  "security": { "auth": { "selectedType": "openai" } },
  "model": { "name": "deepseek-v4-flash" },
  "$version": 4
}
```

## Transport: ACP

**支持（原生）。**

Qwen Code 在 [ACP 官方 Agents 列表](https://agentclientprotocol.com/overview/agents) 中。

---

## 适配器要点

- CLI 未全局安装，需通过源码构建或 npm 安装
- Session 数据直接通过 JSONL 文件管理（无需 CLI）
- 配置：`~/.qwen/settings.json`