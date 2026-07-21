# 版本锁定

本文件记录调研时所使用的各 Harness、协议、参考源的精确版本。

## Harness 版本

| Harness | 版本 | 安装方式 | 源码 |
|---------|------|---------|------|
| **Pi Agent** | `0.80.10` | npm 全局 | [earendil-works/pi](https://github.com/earendil-works/pi) |
| **Claude Code** | `2.1.204` | npm 全局 | [anthropics/claude-code](https://github.com/anthropics/claude-code) |
| **Kimi Code** | `0.28.1` | Go 二进制 | [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) |
| **Codex** | `0.144.6` | Homebrew | [openai/codex](https://github.com/openai/codex) |
| **Qwen Code** | `dddb56d` | npm 源码 | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) |
| **OpenCode** | `@opencode-ai/plugin@1.17.9` | Bun 二进制 | [anomalyco/opencode](https://github.com/anomalyco/opencode) |
| **Devin** | `3000.2.17` (2c489dfc) | Rust 二进制 | [cognitionai/devin-cli](https://github.com/cognitionai/devin-cli) |
| **Cursor** | `3.12.17` | macOS App | 闭源 |
| **Grok** | `0.2.93` (f00f96316d4b) | Rust 二进制 | [xai-org/grok-build](https://github.com/xai-org/grok-build) |

## 协议版本

| 协议 | 版本 | 参考源 |
|------|------|--------|
| **ACP** | Protocol v1 | [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)，commit `4fec58c`，schema `v1.19.0` |
| **MCP** | — | 未专门调研，通过各 Harness 的 MCP 支持间接观察 |

## 参考源

| 源 | 仓库 | 版本/Commit |
|----|------|------------|
| ACP 官方仓库 | [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | `4fec58c` |
| Qwen Code 源码 | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | `dddb56d` |
| Grok 内置文档 | `~/.grok/docs/user-guide/` | 随 Grok `0.2.93` 分发 |
| Grok 内置 Skills/Agents | `~/.grok/bundled/` | manifest `public-2026-07-10-r1` |

## 调研日期

所有 Harness Schema 调研、交互接口调研、动态能力对比基于 **2026-07-14 ~ 2026-07-21** 期间的实际运行和数据采集。

## 更新原则

- 当 Harness 发布新版本时，应更新此表并重新验证已有结论
- 当 ACP 协议升级到 v2 时，应更新协议调研文档
- 版本锁定确保未来回溯时能还原调研上下文