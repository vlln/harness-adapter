# Pi Agent 交互接口

## Transport: CLI

### 二进制

`pi`（Node.js，全局安装）

### 启动模式

| 模式 | 命令 |
|------|------|
| 交互式 | `pi [prompt]` |
| 非交互式 | `pi --print [prompt]` |
| JSON 输出 | `pi --mode json --print [prompt]` |
| RPC 模式 | `pi --mode rpc`（stdio JSON-RPC） |

### Session 管理

| 操作 | 命令 |
|------|------|
| 继续最近会话 | `pi --continue` / `pi -c` |
| 选择恢复 | `pi --resume` / `pi -r` |
| 指定会话 | `pi --session <path|id>` |
| 精确 ID | `pi --session-id <id>` |
| Fork 会话 | `pi --fork <path|id>` |
| 命名会话 | `pi --name <name>` / `pi -n <name>` |
| 无会话（临时） | `pi --no-session` |
| 导出 HTML | `pi --export <file>` |
| 列出模型 | `pi --list-models [search]` |

### 工具控制

| 操作 | 命令 |
|------|------|
| 禁用所有工具 | `pi --no-tools` / `-nt` |
| 禁用内置工具 | `pi --no-builtin-tools` / `-nbt` |
| 白名单 | `pi --tools <list>` / `-t <list>` |
| 黑名单 | `pi --exclude-tools <list>` / `-xt <list>` |

### 扩展

| 操作 | 命令 |
|------|------|
| 加载扩展 | `pi --extension <path>` / `-e <path>` |
| 禁用扩展发现 | `pi --no-extensions` / `-ne` |
| 安装扩展 | `pi install <source>` |
| 移除扩展 | `pi remove <source>` |
| 列出扩展 | `pi list` |
| 配置扩展 | `pi config` |

### 模型

| 操作 | 命令 |
|------|------|
| 指定 provider | `pi --provider <name>` |
| 指定 model | `pi --model <pattern>` |
| 多模型切换 | `pi --models <patterns>` |
| 思考等级 | `pi --thinking <level>`（off/minimal/low/medium/high/xhigh/max） |

### 配置

无独立配置文件，通过 CLI 参数和环境变量配置：

| 环境变量 | 说明 |
|---------|------|
| `PI_CODING_AGENT_SESSION_DIR` | Session 存储目录 |
| `PI_OFFLINE` | 离线模式（1/true/yes） |
| `PI_PACKAGE_DIR` | 包目录（Nix/Guix） |
| `PI_SHARE_VIEWER_URL` | 分享 URL |

## Transport: ACP

**支持（第三方适配器）。**

Pi Agent 通过 [`pi-acp`](https://github.com/svkozak/pi-acp) 适配器支持 ACP。

---

## 适配器要点

- 非交互式执行：`pi --print --mode json <prompt>`
- Session 恢复：`pi --session <id> --print <prompt>`
- 导出：`pi --export <session-file> output.html`
- 无配置文件需要解析（全部 CLI 参数）