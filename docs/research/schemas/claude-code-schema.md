# Claude Code Session Storage Schema

## Overview

Claude Code stores each session as a **JSONL file** in a per-project directory. Sessions with sub-agents spawn additional JSONL files in a `subagents/` subdirectory, plus `.meta.json` sidecar files. Large tool outputs are persisted separately in a `tool-results/` directory.

- **Base path:** `~/.claude/projects/`
- **Format:** Main JSONL + sub-agent JSONL + meta sidecars + tool-result files
- **Causal model:** Directed graph (`parentUuid` + `isSidechain`)
- **Sub-agent support:** Yes — separate JSONL files per sub-agent

---

## Directory Structure

```
~/.claude/projects/
  -<cwd-sanitized>-/                                 # One directory per project
    <session-uuid>.jsonl                              # Main session conversation stream
    <session-uuid>/                                   # Sub-directory for sessions with sub-agents
      subagents/
        agent-<agent-id>.jsonl                        # Sub-agent conversation stream
        agent-<agent-id>.meta.json                    # Sub-agent metadata sidecar
      tool-results/
        <opaque-id>.txt                               # Persisted tool output (>threshold)
```

### Path Encoding

The `cwd` is sanitized similarly to Pi Agent: `/` → `-`, wrapped in `-...-`:

| CWD | Directory Name |
|-----|---------------|
| `/path/to/project` | `-Users-user-Project-example` |

Note: Claude Code uses a single leading `-` (not `--` like Pi Agent).

### Session ID

Session IDs are standard UUIDv4 (e.g., `5c24449b-024a-4143-9fda-a03b6ca83428`). The JSONL file is named `<session-uuid>.jsonl`.

---

## Top-Level Record Types

The main session JSONL contains the following record types:

| Type | Purpose |
|------|---------|
| `queue-operation` | Task queue enqueue/dequeue |
| `attachment` | Goal status, system events, metadata |
| `user` | User messages and command output |
| `assistant` | Model responses (text, thinking, tool use) |
| `thinking` | (embedded in assistant messages) |
| `last-prompt` | Session termination marker |

---

## Common Record Fields

Every record in the main session stream (after the initial `queue-operation` records) shares these common fields:

```json
{
  "uuid": "5e3d26fb-30a6-4c40-84e2-8428e806dd50",
  "parentUuid": "1c9f53b4-39ef-442c-9bcd-9ed7a9b6e02b",
  "isSidechain": false,
  "type": "user",
  "timestamp": "2026-07-14T05:15:46.655Z",
  "sessionId": "5c24449b-024a-4143-9fda-a03b6ca83428",
  "cwd": "/path/to/project",
  "version": "2.1.204",
  "gitBranch": "develop",
  "userType": "external",
  "entrypoint": "sdk-cli"
}
```

| Field | Type | Presence | Description |
|-------|------|----------|-------------|
| `uuid` | `string` (UUIDv4) | Always | Unique record identifier |
| `parentUuid` | `string` (UUIDv4) or `null` | Always | Parent record in the causal graph |
| `isSidechain` | `boolean` | Always | Whether this record is in a sidechain (sub-agent branch) |
| `type` | `string` | Always | Record type discriminator |
| `timestamp` | `string` (ISO 8601) | Always | Event time |
| `sessionId` | `string` (UUIDv4) | Always | Owning session identifier |
| `cwd` | `string` | Always | Working directory |
| `version` | `string` | Always | Claude Code CLI version (e.g., `"2.1.204"`) |
| `gitBranch` | `string` | Always | Current git branch at record time |
| `userType` | `"external"` | Always | User type (always `"external"` in observed data) |
| `entrypoint` | `"sdk-cli"` or `"cli"` | Always | How the session was invoked |
| `promptId` | `string` (UUIDv4) | `user` records | Groups records belonging to the same prompt |
| `slug` | `string` | Sub-agent records | Human-readable session identifier (e.g., `"happy-greeting-pond"`) |

---

## Record Schemas

### 1. `queue-operation`

Task queue management. Appears at the start of a session when a `/goal` is used.

```json
{
  "type": "queue-operation",
  "operation": "enqueue",
  "timestamp": "2026-07-14T05:15:46.647Z",
  "sessionId": "5c24449b-024a-4143-9fda-a03b6ca83428",
  "content": "/goal Say hello\n\nSay hello in one sentence"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"queue-operation"` | Record type discriminator |
| `operation` | `"enqueue"` or `"dequeue"` | Queue operation |
| `timestamp` | `string` (ISO 8601) | Event time |
| `sessionId` | `string` (UUIDv4) | Session identifier |
| `content` | `string` | (enqueue only) The raw goal/prompt text |

### 2. `attachment`

A generic container for system events. The primary use is `goal_status` — tracking whether the session's goal has been met.

#### Goal Status (initial)

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "type": "attachment",
  "uuid": "1c9f53b4-39ef-442c-9bcd-9ed7a9b6e02b",
  "timestamp": "2026-07-14T05:15:46.655Z",
  "attachment": {
    "type": "goal_status",
    "met": false,
    "sentinel": true,
    "condition": "Say hello\n\nSay hello in one sentence"
  },
  "userType": "external",
  "entrypoint": "sdk-cli",
  "cwd": "/path/to/project",
  "sessionId": "5c24449b-024a-4143-9fda-a03b6ca83428",
  "version": "2.1.204",
  "gitBranch": "develop"
}
```

#### Goal Status (completion)

```json
{
  "parentUuid": "a3932737-73fd-4b4e-97d2-d2fa8393776d",
  "isSidechain": false,
  "attachment": {
    "type": "goal_status",
    "met": true,
    "condition": "Say hello\n\nSay hello in one sentence",
    "reason": "The assistant said 'Hello! I'm ready to help...' which is a greeting containing 'hello' in a single sentence.",
    "iterations": 1,
    "durationMs": 8233,
    "tokens": 240
  },
  "type": "attachment",
  "uuid": "28636c61-3ef2-4f85-a7ee-7ffcb5579edb",
  "timestamp": "2026-07-14T05:15:54.888Z",
  ...
}
```

| Field | Type | Description |
|-------|------|-------------|
| `attachment.type` | `"goal_status"` | Attachment type |
| `attachment.met` | `boolean` | Whether the goal was achieved |
| `attachment.sentinel` | `boolean` | (initial only) Whether this is the sentinel goal |
| `attachment.condition` | `string` | The goal condition text |
| `attachment.reason` | `string` | (completion only) Explanation of why the goal was met |
| `attachment.iterations` | `number` | (completion only) Number of iterations |
| `attachment.durationMs` | `number` | (completion only) Duration in milliseconds |
| `attachment.tokens` | `number` | (completion only) Token count for the session |

### 3. `user`

Represents user input. May appear multiple times for a single prompt — first with the raw command, then with command output (stdout).

```json
{
  "parentUuid": "1c9f53b4-39ef-442c-9bcd-9ed7a9b6e02b",
  "isSidechain": false,
  "promptId": "249cb3a3-5a81-422f-870a-4a5c7e6e9b2a",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>Say hello\n\nSay hello in one sentence</command-args>"
  },
  "uuid": "5e3d26fb-30a6-4c40-84e2-8428e806dd50",
  "timestamp": "2026-07-14T05:15:46.655Z",
  ...
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"user"` | Record type discriminator |
| `message.role` | `"user"` | Always `"user"` |
| `message.content` | `string` | Raw message content (XML-formatted for slash commands, plain text otherwise) |
| `promptId` | `string` (UUIDv4) | Groups related user records for the same prompt |

**Note:** Unlike Pi Agent, the `message.content` in Claude Code user records is a **plain string**, not an array of content blocks. Slash commands are encoded as XML tags (`<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`).

### 4. `assistant`

Model responses. A single assistant message can contain multiple content blocks: text, thinking, and tool use.

#### Simple Text Response

```json
{
  "parentUuid": "13939ebd-9ac4-4553-8d71-d81c726bacea",
  "isSidechain": false,
  "message": {
    "model": "deepseek-v4-pro",
    "id": "msg_7d6906f8-91c7-48e4-8ecc-3da21ed86938",
    "role": "assistant",
    "type": "message",
    "content": [
      {
        "type": "text",
        "text": "Hello! I'm ready to help you with your software engineering tasks today."
      }
    ],
    "usage": {
      "input_tokens": 18181,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0,
      "output_tokens": 46,
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": 0,
        "ephemeral_5m_input_tokens": 0
      },
      "inference_geo": "",
      "iterations": [],
      "speed": "standard"
    },
    "stop_reason": "end_turn",
    "stop_details": null
  },
  "type": "assistant",
  "uuid": "a3932737-73fd-4b4e-97d2-d2fa8393776d",
  "timestamp": "2026-07-14T05:15:50.338Z",
  ...
}
```

#### With Thinking and Tool Use

```json
{
  "parentUuid": "744077ae-c43d-4353-8dcd-a7604eef6e1a",
  "isSidechain": true,
  "agentId": "a88a63cee17bdc9e7",
  "message": {
    "model": "qwen3.6-plus",
    "id": "msg_2688ea78-2aad-4b27-916d-9438c3728cdb",
    "role": "assistant",
    "type": "message",
    "content": [
      {
        "type": "thinking",
        "signature": "",
        "thinking": "The user wants me to research whether Claude Code's workflow subagents..."
      },
      {
        "type": "text",
        "text": "I'll search for information about Claude Code's workflow subagent goal support..."
      },
      {
        "name": "WebSearch",
        "input": {
          "query": "claude code workflow agent goal parameter"
        },
        "id": "toolu_18e3b42c7e8c4e16ba2b935f",
        "type": "tool_use"
      }
    ],
    "usage": {
      "input_tokens": 1439,
      "cache_creation_input_tokens": 5421,
      "cache_read_input_tokens": 0,
      "output_tokens": 174,
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": 0,
        "ephemeral_5m_input_tokens": 5421
      },
      "inference_geo": "",
      "iterations": [],
      "speed": "standard"
    },
    "stop_reason": "tool_use",
    "stop_details": null
  },
  "attributionAgent": "Explore",
  "type": "assistant",
  "uuid": "75269d3a-5c8d-4df3-b66e-e14525e9333a",
  "timestamp": "2026-07-14T01:10:18.031Z",
  ...
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message.model` | `string` | Model identifier |
| `message.id` | `string` | Provider message ID (`msg_` prefix) |
| `message.role` | `"assistant"` | Always `"assistant"` |
| `message.type` | `"message"` | Message type |
| `message.content` | `array` of content blocks | Mixed content |
| `message.content[].type` | `"text"` \| `"thinking"` \| `"tool_use"` | Content block type |
| `message.content[].text` | `string` | (text blocks) The text |
| `message.content[].thinking` | `string` | (thinking blocks) The reasoning |
| `message.content[].signature` | `string` | (thinking blocks) Signature (empty for non-Claude models) |
| `message.content[].name` | `string` | (tool_use blocks) Tool name |
| `message.content[].input` | `object` | (tool_use blocks) Tool arguments |
| `message.content[].id` | `string` | (tool_use blocks) Tool call ID (`toolu_` prefix) |
| `message.usage` | `object` | Anthropic-style usage with cache tiers |
| `message.usage.input_tokens` | `number` | Input tokens |
| `message.usage.cache_creation_input_tokens` | `number` | Tokens used for cache creation |
| `message.usage.cache_read_input_tokens` | `number` | Tokens read from cache |
| `message.usage.output_tokens` | `number` | Output tokens |
| `message.usage.server_tool_use` | `object` | Server-side tool usage counts |
| `message.usage.service_tier` | `string` | Service tier (`"standard"`) |
| `message.usage.cache_creation` | `object` | Cache creation breakdown by TTL |
| `message.usage.speed` | `string` | Speed tier (`"standard"`) |
| `message.stop_reason` | `string` | `"end_turn"`, `"tool_use"`, or `"stop"` |
| `message.stop_details` | `null` or `string` | Stop details |
| `attributionAgent` | `string` | (sub-agent only) Agent type name that produced this message |

### 5. `last-prompt`

Marks the end of a session. Contains a pointer to the final leaf record.

```json
{
  "type": "last-prompt",
  "leafUuid": "28636c61-3ef2-4f85-a7ee-7ffcb5579edb",
  "sessionId": "5c24449b-024a-4143-9fda-a03b6ca83428"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"last-prompt"` | Record type discriminator |
| `leafUuid` | `string` (UUIDv4) | UUID of the last record in the causal chain |
| `sessionId` | `string` (UUIDv4) | Session identifier |

---

## Sub-Agent Records

Sub-agents are stored in separate JSONL files under `subagents/agent-<agent-id>.jsonl`. Each sub-agent has a `.meta.json` sidecar.

### Sub-Agent Meta File

`agent-<agent-id>.meta.json`:

```json
{
    "agentType": "Explore",
    "description": "Search CC workflow goal docs",
    "toolUseId": "toolu_aecb4d975d9045f3926f5d6d",
    "spawnDepth": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `agentType` | `string` | Agent type name (e.g., `"Explore"`, `"Plan"`) |
| `description` | `string` | Human-readable task description |
| `toolUseId` | `string` | The tool call ID that spawned this sub-agent |
| `spawnDepth` | `number` | Nesting depth (0 = main, 1 = first sub-agent, etc.) |

### Sub-Agent JSONL

The sub-agent JSONL uses the same record types as the main session (`user`, `assistant`) with additional fields:

- `isSidechain: true` — always set for sub-agent records
- `agentId` — the agent's identifier (matches the filename)
- `attributionAgent` — the agent type name (e.g., `"Explore"`) on assistant messages
- `slug` — human-readable session identifier

The sub-agent's `user` record contains the task prompt that was given to the sub-agent. The sub-agent's `assistant` records follow the same structure as the main session.

---

## Causal Graph Structure

Claude Code uses a **directed graph** rather than a simple tree:

```
queue-operation (enqueue)
queue-operation (dequeue)
attachment (goal_status, initial)  ← parentUuid=null
  └─ user (command)                ← parentUuid=attachment
       └─ user (stdout)            ← parentUuid=user
            └─ assistant (response) ← parentUuid=user
                 └─ attachment (goal_status, final) ← parentUuid=assistant
last-prompt (leafUuid=final_attachment)
```

For sub-agents, the `isSidechain` field creates a branch:

```
main session:
  user → assistant (with tool_use to spawn agent)
                              ↓
sidechain (separate file):
  user (task prompt)          ← parentUuid = main assistant's uuid, isSidechain=true
    → assistant (thinking)
    → assistant (text)
    → assistant (tool_use)
    → ...
```

---

## Tool Results

Large tool outputs are persisted to disk and referenced via a tool result ID. The files are stored in:

```
<session-uuid>/tool-results/<opaque-id>.txt
```

The file contains a `<persisted-output>` XML wrapper with a preview and a path to the full content:

```
<persisted-output>
Output too large (122.1KB). Full output saved to: /Users/vlln/.claude/projects/.../tool-results/bke9i9486.txt

Preview (first 2KB):
...
</persisted-output>
```

---

## Key Design Characteristics

1. **Graph-based causal model.** Records are linked by `parentUuid`. The `isSidechain` flag enables branching for sub-agents. Unlike Pi Agent's linear tree, Claude Code can have multiple children per parent.

2. **Rich per-record metadata.** Every record carries `sessionId`, `cwd`, `version`, `gitBranch`, `userType`, and `entrypoint`. This makes each record self-describing.

3. **Anthropic-style usage.** Token usage follows the Anthropic API format with cache creation/read tiers, server tool use tracking, and service tier.

4. **Goal tracking.** The `attachment` type with `goal_status` provides automatic goal evaluation — tracking whether the session's objective was met, with reasoning, iteration count, and duration.

5. **Sub-agent isolation.** Sub-agents have their own JSONL files and meta sidecars. The `spawnDepth` field tracks nesting.

6. **Command encoding.** Slash commands are serialized as XML tags within the user message content string.

7. **Tool result offloading.** Large tool outputs are persisted to separate files, keeping the main JSONL manageable.

---

## Complete Record Type Summary

### Main Session

| # | Type | Has `uuid` | Has `parentUuid` | Has `message` | Has `attachment` |
|---|------|-----------|-----------------|---------------|-----------------|
| 1 | `queue-operation` | ❌ | ❌ | ❌ | ❌ |
| 2 | `attachment` | ✅ | ✅ | ❌ | ✅ |
| 3 | `user` | ✅ | ✅ | ✅ | ❌ |
| 4 | `assistant` | ✅ | ✅ | ✅ | ❌ |
| 5 | `last-prompt` | ❌ | ❌ | ❌ | ❌ |

### Sub-Agent Session

| # | Type | Has `uuid` | Has `parentUuid` | Has `isSidechain` | Has `agentId` |
|---|------|-----------|-----------------|-------------------|---------------|
| 1 | `user` | ✅ | ✅ | ✅ (`true`) | ✅ |
| 2 | `assistant` | ✅ | ✅ | ✅ (`true`) | ✅ |

### Content Block Types (within `message.content`)

| Type | Found In | Description |
|------|----------|-------------|
| `text` | `assistant` | Plain text output |
| `thinking` | `assistant` | Reasoning/thinking content |
| `tool_use` | `assistant` | Tool call with `name`, `input`, `id` |

---

## Example: Minimal Session with Goal

```jsonl
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-07-14T05:15:46.647Z","sessionId":"5c24449b-...","content":"/goal Say hello\n\nSay hello in one sentence"}
{"type":"queue-operation","operation":"dequeue","timestamp":"2026-07-14T05:15:46.647Z","sessionId":"5c24449b-..."}
{"parentUuid":null,"isSidechain":false,"type":"attachment","uuid":"1c9f53b4-...","timestamp":"...","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"Say hello\n\nSay hello in one sentence"},"userType":"external","entrypoint":"sdk-cli","cwd":"/path/to/project","sessionId":"5c24449b-...","version":"2.1.204","gitBranch":"develop"}
{"parentUuid":"1c9f53b4-...","isSidechain":false,"promptId":"249cb3a3-...","type":"user","message":{"role":"user","content":"<command-name>/goal</command-name>..."},"uuid":"5e3d26fb-...","timestamp":"...","userType":"external","entrypoint":"sdk-cli","cwd":"/path/to/project","sessionId":"5c24449b-...","version":"2.1.204","gitBranch":"develop"}
{"parentUuid":"5e3d26fb-...","isSidechain":false,"promptId":"249cb3a3-...","type":"user","message":{"role":"user","content":"<local-command-stdout>Goal set: Say hello\n\nSay hello in one sentence</local-command-stdout>"},"uuid":"a84fabcf-...","timestamp":"...","userType":"external","entrypoint":"sdk-cli","cwd":"/path/to/project","sessionId":"5c24449b-...","version":"2.1.204","gitBranch":"develop"}
{"parentUuid":"a84fabcf-...","isSidechain":false,"message":{"model":"deepseek-v4-pro","id":"msg_7d6906f8-...","role":"assistant","type":"message","content":[{"type":"text","text":"Hello! I'm ready to help..."}],"usage":{...},"stop_reason":"end_turn"},"type":"assistant","uuid":"a3932737-...","timestamp":"...","userType":"external","entrypoint":"sdk-cli","cwd":"/path/to/project","sessionId":"5c24449b-...","version":"2.1.204","gitBranch":"develop"}
{"parentUuid":"a3932737-...","isSidechain":false,"attachment":{"type":"goal_status","met":true,"condition":"Say hello\n\nSay hello in one sentence","reason":"The assistant said 'Hello!'...","iterations":1,"durationMs":8233,"tokens":240},"type":"attachment","uuid":"28636c61-...","timestamp":"...","userType":"external","entrypoint":"sdk-cli","cwd":"/path/to/project","sessionId":"5c24449b-...","version":"2.1.204","gitBranch":"develop"}
{"type":"last-prompt","leafUuid":"28636c61-...","sessionId":"5c24449b-..."}
```