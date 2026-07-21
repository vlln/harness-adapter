# OpenCode 交互接口

## Transport: CLI

### 二进制

`opencode`（Bun 二进制，`~/.opencode/bin/opencode`）

### 状态

**未在本地实际运行**，无会话持久化。基于 `@opencode-ai/plugin@1.17.9` 包。

### 配置

`~/.opencode/package.json`：

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.17.9"
  }
}
```

## Transport: ACP

**支持（原生）。**

OpenCode 在 [ACP 官方 Agents 列表](https://agentclientprotocol.com/overview/agents) 中。

---

## 适配器要点

- 无本地会话数据（Tier 3）
- 无 CLI 接口可调用
- Null adapter：所有查询返回空