# Kimi Code Session Storage Schema

## Overview

Kimi Code stores each session as a **directory** containing a `state.json` metadata file, per-agent `wire.jsonl` event streams, an optional `plans/` directory for plan mode documents, and a `logs/` directory for runtime logs.

- **Base path:** `~/.kimi-code/sessions/`
- **Format:** Multi-file directory per session; per-agent JSONL event streams
- **Protocol version:** `"1.4"`
- **Causal model:** Event stream (no explicit causal links between records)
- **Sub-agent support:** Yes — separate `wire.jsonl` per agent, with `AgentSwarm` tool

---

## Directory Structure

```
~/.kimi-code/sessions/
  wd_<workspace-id>/                                    # Workspace-level grouping
    session_<uuid>/                                      # Single session
      state.json                                         # Session metadata
      agents/
        main/
          wire.jsonl                                     # Main agent event stream
          plans/                                         # Plan mode documents (optional)
            <human-readable-slug>.md                     # Markdown plan document
        agent-0/
          wire.jsonl                                     # Sub-agent 0 event stream
        agent-1/
          wire.jsonl                                     # Sub-agent 1 event stream
        ...
      logs/
        kimi-code.log                                    # Runtime log file
```

### Workspace ID

The workspace ID is a hash/identifier for the working directory (e.g., `wd_kimi-code_2ab9c8b91202`). All sessions opened in the same working directory share the same workspace group.

### Session ID

Session IDs are UUIDv4 (e.g., `ad37ee83-0cd8-4421-ab91-6e24f83e8d3e`). The directory is named `session_<uuid>`.

---

## `state.json`

Session-level metadata. Lives at the session root.

```json
{
    "createdAt": "2026-06-22T13:23:19.558Z",
    "updatedAt": "2026-06-22T13:23:50.394Z",
    "title": "say hello",
    "isCustomTitle": false,
    "agents": {
        "main": {
            "homedir": "/home/user/.kimi-code/sessions/wd_kimi-code_2ab9c8b91202/session_8eaaa6b9-1340-4ab8-8b35-2f57e9d64f90/agents/main",
            "type": "main",
            "parentAgentId": null
        }
    },
    "custom": {},
    "lastPrompt": "say hello from session A"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `createdAt` | `string` (ISO 8601) | Session creation time |
| `updatedAt` | `string` (ISO 8601) | Last update time |
| `title` | `string` | Session title (auto-generated or user-set) |
| `isCustomTitle` | `boolean` | Whether the title was manually set |
| `agents` | `object` | Map of agent ID → agent metadata |
| `agents.<id>.homedir` | `string` | Absolute path to the agent's directory |
| `agents.<id>.type` | `"main"` or `"subagent"` (presumed) | Agent role |
| `agents.<id>.parentAgentId` | `string` or `null` | Parent agent ID (null for main) |
| `custom` | `object` | Extensible custom metadata (empty by default) |
| `lastPrompt` | `string` | The last user prompt text |

---

## `wire.jsonl` — Event Stream Schema

Each agent directory contains a `wire.jsonl` file. This is the core event stream — all conversation, tool calls, and system events are recorded here.

Kimi Code uses a **two-layer event model**:

1. **Top-level events** — metadata, configuration, turns, and context operations
2. **`context.append_loop_event`** — a wrapper that carries all events from the agent's execution loop

### Time Format

Kimi Code uses **Unix milliseconds** for all timestamps (e.g., `1782128092403` = 2026-06-22T13:34:52.403Z). The field name is `time` (not `timestamp`).

---

## Top-Level Record Types

### 1. `metadata`

The first record. Establishes the protocol version.

```json
{
    "type": "metadata",
    "protocol_version": "1.4",
    "created_at": 1782128092403
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"metadata"` | Record type discriminator |
| `protocol_version` | `string` | Schema version (currently `"1.4"`) |
| `created_at` | `number` (Unix ms) | Session creation time |

### 2. `tools.set_active_tools`

Declares the set of available tools.

```json
{
    "type": "tools.set_active_tools",
    "names": [
        "Read", "Write", "Edit", "Grep", "Glob", "Bash",
        "TaskList", "TaskOutput", "TaskStop",
        "CronCreate", "CronList", "CronDelete",
        "ReadMediaFile", "TodoList", "Skill",
        "WebSearch", "Agent", "AgentSwarm",
        "FetchURL", "AskUserQuestion",
        "EnterPlanMode", "ExitPlanMode",
        "CreateGoal", "GetGoal", "SetGoalBudget", "UpdateGoal",
        "mcp__*"
    ],
    "time": 1782128092403
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"tools.set_active_tools"` | Record type discriminator |
| `names` | `array` of `string` | Available tool names |
| `time` | `number` (Unix ms) | Event time |

### 3. `config.update`

Records configuration changes (model, thinking level, etc.).

```json
{
    "type": "config.update",
    "modelAlias": "alibaba-cn/deepseek-v4-pro",
    "thinkingLevel": "high",
    "time": 1782128092404
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"config.update"` | Record type discriminator |
| `modelAlias` | `string` | Model identifier (provider-qualified) |
| `thinkingLevel` | `"high"` or `"off"` (presumed) | Thinking mode |
| `time` | `number` (Unix ms) | Event time |

### 4. `turn.prompt`

Captures the user's input at the start of a turn.

```json
{
    "type": "turn.prompt",
    "input": [
        {
            "type": "text",
            "text": "你是kimi code, 一个coding agent工具, 你能否被其他agent工具调用?"
        }
    ],
    "origin": {
        "kind": "user"
    },
    "time": 1782128116559
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"turn.prompt"` | Record type discriminator |
| `input` | `array` of content blocks | User input (OpenAI content format) |
| `origin.kind` | `"user"` | Origin of the prompt |
| `time` | `number` (Unix ms) | Event time |

### 5. `context.append_message`

Appends a message to the conversation context.

```json
{
    "type": "context.append_message",
    "message": {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": "你是kimi code, 一个coding agent工具, 你能否被其他agent工具调用?"
            }
        ],
        "toolCalls": [],
        "origin": {
            "kind": "user"
        }
    },
    "time": 1782128116560
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"context.append_message"` | Record type discriminator |
| `message.role` | `"user"` \| `"assistant"` | Message role |
| `message.content` | `array` of content blocks | Message content |
| `message.toolCalls` | `array` | Tool calls (empty for user messages) |
| `message.origin.kind` | `"user"` | Origin |
| `time` | `number` (Unix ms) | Event time |

### 6. `context.append_loop_event`

**The core wrapper.** All events from the agent's execution loop are wrapped in this record type. The `event` field contains the actual event.

This is the most frequent record type — typically hundreds per session.

### 7. `usage.record`

Token usage tracking.

```json
{
    "type": "usage.record",
    "model": "alibaba-cn/deepseek-v4-pro",
    "usage": {
        "inputOther": 19846,
        "output": 265,
        "inputCacheRead": 1024,
        "inputCacheCreation": 0
    },
    "usageScope": "turn",
    "time": 1782128125422
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"usage.record"` | Record type discriminator |
| `model` | `string` | Model identifier |
| `usage.inputOther` | `number` | Non-cached input tokens |
| `usage.output` | `number` | Output tokens |
| `usage.inputCacheRead` | `number` | Cache read tokens |
| `usage.inputCacheCreation` | `number` | Cache creation tokens |
| `usageScope` | `"turn"` | Scope of usage accounting |
| `time` | `number` (Unix ms) | Event time |

### 8. `permission.record_approval_result`

Records the result of a permission approval.

```json
{
    "type": "permission.record_approval_result",
    ...
}
```

### 9. `plan_mode.enter` / `plan_mode.exit` / `plan_mode.cancel`

Plan mode state transitions.

### 10. `tools.update_store`

Incremental updates to the available tool set.

### 11. `permission.set_mode`

Permission mode changes.

```json
{
    "type": "permission.set_mode",
    ...
}
```

---

## Loop Event Types (inside `context.append_loop_event.event`)

These are the event types found within the `event` field of `context.append_loop_event` records:

### `step.begin`

```json
{
    "type": "context.append_loop_event",
    "event": {
        "type": "step.begin",
        "uuid": "1ee116b1-07a8-4178-a206-080b7724e5d2",
        "turnId": "0",
        "step": 1
    },
    "time": 1782128116568
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event.type` | `"step.begin"` | Event type |
| `event.uuid` | `string` (UUIDv4) | Unique step identifier |
| `event.turnId` | `string` | Turn number (as string) |
| `event.step` | `number` | Step number within the turn |

### `step.end`

Marks the end of a step. Same structure as `step.begin` but with `type: "step.end"`.

### `content.part`

Model output — either thinking or text.

**Thinking:**

```json
{
    "type": "context.append_loop_event",
    "event": {
        "type": "content.part",
        "uuid": "f866d55a-1c12-41d8-9f8f-1e67db0fb976",
        "turnId": "0",
        "step": 1,
        "stepUuid": "1ee116b1-07a8-4178-a206-080b7724e5d2",
        "part": {
            "type": "think",
            "think": "用户问的是我（kimi code）能否被其他 agent 工具调用..."
        }
    },
    "time": 1782128125152
}
```

**Text:**

```json
{
    "type": "context.append_loop_event",
    "event": {
        "type": "content.part",
        "uuid": "476a33ad-15a8-4b61-b670-bc3ed4a5ee1c",
        "turnId": "0",
        "step": 1,
        "stepUuid": "1ee116b1-07a8-4178-a206-080b7724e5d2",
        "part": {
            "type": "text",
            "text": "这是一个关于项目架构的问题，让我看一下代码库中 agent 之间调用的实现"
        }
    },
    "time": 1782128125170
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event.uuid` | `string` (UUIDv4) | Content part identifier |
| `event.turnId` | `string` | Turn number |
| `event.step` | `number` | Step number |
| `event.stepUuid` | `string` (UUIDv4) | Owning step UUID |
| `event.part.type` | `"think"` or `"text"` | Content type |
| `event.part.think` | `string` | (think) The reasoning text |
| `event.part.text` | `string` | (text) The output text |

### `tool.call`

```json
{
    "type": "context.append_loop_event",
    "event": {
        "type": "tool.call",
        "uuid": "call_47b62cbf5dd74d5aaa2f700b",
        "turnId": "0",
        "step": 1,
        "stepUuid": "1ee116b1-07a8-4178-a206-080b7724e5d2",
        "toolCallId": "call_47b62cbf5dd74d5aaa2f700b",
        "name": "Grep",
        "args": {
            "pattern": "subagent|sub.agent|AgentSwarm|Agent\\(",
            "path": "/path/to/kimi-code/packages/agent-core",
            "output_mode": "files_with_matches"
        },
        "description": "Searching for 'subagent|sub.agent|AgentSwarm|Agent\\(' in /path/to/kimi-code/packages/agent-core",
        "display": {
            "kind": "file_io",
            "operation": "grep",
            "path": "/path/to/kimi-code/packages/agent-core"
        }
    },
    "time": 1782128125260
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event.type` | `"tool.call"` | Event type |
| `event.uuid` | `string` | Unique event identifier |
| `event.turnId` | `string` | Turn number |
| `event.step` | `number` | Step number |
| `event.stepUuid` | `string` (UUIDv4) | Owning step UUID |
| `event.toolCallId` | `string` | Tool call identifier (matches `event.uuid`) |
| `event.name` | `string` | Tool name |
| `event.args` | `object` | Tool arguments |
| `event.description` | `string` | Human-readable description of the call |
| `event.display.kind` | `string` | Display category (e.g., `"file_io"`) |
| `event.display.operation` | `string` | Operation type (e.g., `"grep"`) |
| `event.display.path` | `string` | Target path |

### `tool.result`

```json
{
    "type": "context.append_loop_event",
    "event": {
        "type": "tool.result",
        "parentUuid": "call_47b62cbf5dd74d5aaa2f700b",
        "toolCallId": "call_47b62cbf5dd74d5aaa2f700b",
        "result": {
            "output": "packages/agent-core/test/tools/skill-tool.test.ts\n..."
        }
    },
    "time": 1782128125419
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event.type` | `"tool.result"` | Event type |
| `event.parentUuid` | `string` | UUID of the corresponding `tool.call` |
| `event.toolCallId` | `string` | Tool call identifier (correlates to `tool.call.toolCallId`) |
| `event.result` | `object` | Tool execution result |
| `event.result.output` | `string` | Tool output text |

---

## Plans Directory

When the agent enters plan mode, plan documents are stored as Markdown files:

```
agents/main/plans/<human-readable-slug>.md
```

Example slug: `kyle-rayner-thunder-cyborg`

The plan file is standard Markdown with frontmatter-style metadata in the heading:

```markdown
# Plan: Create `kimi-code` Skill — Multi-Agent Management

## 核心概念
- **Agent** = 定义（`.agents/kimi-code/<name>.md`），是模板/蓝图
- **Session** = 实例（kimi-code session），是 agent 的一次运行
...
```

---

## Logs

```
logs/kimi-code.log
```

Standard application log file. Contains runtime diagnostic output.

---

## Key Design Characteristics

1. **Two-layer event model.** The `context.append_loop_event` wrapper separates "context management" events from "agent execution" events. All loop events are nested inside the wrapper.

2. **No explicit causal chain.** Unlike Pi Agent (`parentId` tree) and Claude Code (`parentUuid` graph), Kimi Code does not maintain explicit causal links between records. The event stream is temporal — order is implied by the `time` field and sequence within the file.

3. **Per-agent isolation.** Each agent (main, agent-0, agent-1...) has its own `wire.jsonl`. The `state.json` maps agent IDs to their directories and parent relationships.

4. **Unix millisecond timestamps.** All timestamps use `time` (number, Unix ms), not ISO 8601 strings. This is unique among the four harnesses.

5. **Protocol versioning.** The `metadata` record declares `protocol_version: "1.4"`, enabling forward compatibility.

6. **Rich tool call metadata.** Tool calls include `description` (human-readable) and `display` (structured rendering hints) in addition to the raw `name`/`args`.

7. **Plan mode documents.** Plan documents are stored as Markdown files, making them human-readable outside the tool.

8. **Separate agent lifecycle.** `state.json` tracks `createdAt`/`updatedAt` and agent registration. The `agents` map can grow as sub-agents are spawned.

9. **Config tracking.** The `config.update` record captures model and thinking level changes. The `tools.set_active_tools` and `tools.update_store` records track tool availability.

10. **Chinese language support.** The observed data contains Chinese text, reflecting Kimi Code's origin (Moonshot AI).

---

## Complete Record Type Summary

### Top-Level Types

| # | Type | Frequency | Has `time` | Has `event` |
|---|------|-----------|------------|-------------|
| 1 | `metadata` | 1 | ❌ (`created_at`) | ❌ |
| 2 | `tools.set_active_tools` | 1 | ✅ | ❌ |
| 3 | `config.update` | 1+ | ✅ | ❌ |
| 4 | `turn.prompt` | 1 per turn | ✅ | ❌ |
| 5 | `context.append_message` | 1+ per turn | ✅ | ❌ |
| 6 | `context.append_loop_event` | N | ✅ | ✅ |
| 7 | `usage.record` | 1 per step | ✅ | ❌ |
| 8 | `permission.record_approval_result` | 0+ | ✅ | ? |
| 9 | `plan_mode.enter` | 0-1 | ✅ | ? |
| 10 | `plan_mode.exit` | 0-1 | ✅ | ? |
| 11 | `plan_mode.cancel` | 0-1 | ✅ | ? |
| 12 | `tools.update_store` | 0+ | ✅ | ? |
| 13 | `permission.set_mode` | 0-1 | ✅ | ? |

### Loop Event Types (inside `context.append_loop_event.event`)

| # | Type | Description |
|---|------|-------------|
| 1 | `step.begin` | Step start marker |
| 2 | `step.end` | Step end marker |
| 3 | `content.part` (think) | Model thinking/reasoning |
| 4 | `content.part` (text) | Model text output |
| 5 | `tool.call` | Tool invocation |
| 6 | `tool.result` | Tool execution result |

---

## Example: Minimal Session Wire Format

```jsonl
{"type":"metadata","protocol_version":"1.4","created_at":1782128092403}
{"type":"tools.set_active_tools","names":["Read","Write","Edit","Grep","Glob","Bash","WebSearch","Agent","Skill","..."],"time":1782128092403}
{"type":"config.update","modelAlias":"alibaba-cn/deepseek-v4-pro","thinkingLevel":"high","time":1782128092404}
{"type":"turn.prompt","input":[{"type":"text","text":"say hello"}],"origin":{"kind":"user"},"time":1782128116559}
{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"say hello"}],"toolCalls":[],"origin":{"kind":"user"}},"time":1782128116560}
{"type":"context.append_loop_event","event":{"type":"step.begin","uuid":"...","turnId":"0","step":1},"time":1782128116568}
{"type":"context.append_loop_event","event":{"type":"content.part","uuid":"...","turnId":"0","step":1,"stepUuid":"...","part":{"type":"text","text":"Hello!"}},"time":1782128125170}
{"type":"context.append_loop_event","event":{"type":"step.end","uuid":"...","turnId":"0","step":1},"time":1782128125422}
{"type":"usage.record","model":"alibaba-cn/deepseek-v4-pro","usage":{"inputOther":19846,"output":265,"inputCacheRead":1024,"inputCacheCreation":0},"usageScope":"turn","time":1782128125422}
```