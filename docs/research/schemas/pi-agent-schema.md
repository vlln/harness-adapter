# Pi Agent Session Storage Schema

## Overview

Pi Agent stores each session as a **single JSONL file** in a flat directory. The session ID and timestamp are encoded in the filename. All events — session metadata, model changes, thinking level changes, and conversation messages — are stored as top-level records in the same file, linked by a `parentId` tree.

- **Base path:** `~/.pi/agent/sessions/`
- **Format:** Single JSONL file per session
- **Protocol version:** `3`
- **Causal model:** Tree (`id` → `parentId`)
- **Sub-agent support:** No

---

## Directory Structure

```
~/.pi/agent/sessions/
  --<cwd-sanitized>--/                          # One directory per project (cwd path encoded with --)
    <iso-timestamp>_<session-uuid>.jsonl         # Single file per session
```

### Path Encoding

The `cwd` is sanitized: `/` is replaced with `-`, and the result is wrapped in `--...--`. For example:

| CWD | Directory Name |
|-----|---------------|
| `/path/to/project` | `--Users-user-Project-example--` |
| `/Users/vlln/agent-space` | `--Users-vlln-agent-space--` |
| `/tmp/st` | `--tmp-st--` |

### Filename Convention

```
<ISO-8601-timestamp>_<ULID-session-id>.jsonl
```

Example: `2026-07-06T12-52-42-533Z_019f377c-efa5-7894-87e9-9117316a79f2.jsonl`

The timestamp is the session creation time in ISO 8601 format with colons replaced by hyphens. The session ID is a ULID (Universally Unique Lexicographically Sortable Identifier).

---

## Top-Level Record Types

There are exactly **4** top-level record types:

| Type | Count (typical) | Purpose |
|------|----------------|---------|
| `session` | 1 | Session metadata — always the first record |
| `model_change` | 1+ | Model/provider switch event |
| `thinking_level_change` | 1 | Thinking mode toggle |
| `message` | N | All conversation turns — user messages, assistant responses, tool calls, tool results, and thinking |

---

## Record Schemas

### 1. `session`

The first record in every file. Establishes the session identity and working directory.

```json
{
  "type": "session",
  "version": 3,
  "id": "019f364a-25b0-7f3c-9ea2-adf450e7f7f6",
  "timestamp": "2026-07-06T07:17:36.816Z",
  "cwd": "/Users/vlln/agent-space"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session"` | Record type discriminator |
| `version` | `number` | Schema version (currently `3`) |
| `id` | `string` (ULID) | Session identifier |
| `timestamp` | `string` (ISO 8601) | Session creation time |
| `cwd` | `string` | Working directory for this session |

### 2. `model_change`

Emitted when the model or provider changes. The `parentId` is `null` for the initial model change (it's the root of the causal tree after the session record).

```json
{
  "type": "model_change",
  "id": "3df28002",
  "parentId": null,
  "timestamp": "2026-07-06T07:17:36.826Z",
  "provider": "ollama",
  "modelId": "DeepSeek-V4-Flash"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"model_change"` | Record type discriminator |
| `id` | `string` (8-char hex) | Unique ID for this record |
| `parentId` | `string` or `null` | Parent record ID in the causal chain |
| `timestamp` | `string` (ISO 8601) | Event time |
| `provider` | `string` | Provider identifier (e.g., `"ollama"`, `"blsc"`, `"grok"`) |
| `modelId` | `string` | Model identifier (e.g., `"DeepSeek-V4-Flash"`, `"grok-4.5"`) |

**Note:** Multiple `model_change` records can appear in a session. For example, a session may start with `ollama/DeepSeek-V4-Flash` and later switch to `grok/grok-4.5`. Each `model_change` has its own `id` and links to the previous record via `parentId`.

### 3. `thinking_level_change`

Emitted after the initial model change to set the thinking mode.

```json
{
  "type": "thinking_level_change",
  "id": "ba45d0fa",
  "parentId": "3df28002",
  "timestamp": "2026-07-06T07:17:36.826Z",
  "thinkingLevel": "off"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"thinking_level_change"` | Record type discriminator |
| `id` | `string` (8-char hex) | Unique ID for this record |
| `parentId` | `string` | Parent record ID (typically the `model_change`) |
| `timestamp` | `string` (ISO 8601) | Event time |
| `thinkingLevel` | `"off"` or `"high"` (presumed) | Thinking mode toggle |

### 4. `message`

The universal container for all conversation content. A single `message` record can carry multiple content blocks — the model may emit thinking, text, and tool calls all in a single message.

The `role` field determines the semantics:

| Role | Content Types | Purpose |
|------|--------------|---------|
| `user` | `text` | User input |
| `assistant` | `text`, `thinking`, `toolCall` | Model response (may include mixed content) |
| `toolResult` | `text` | Tool execution result |

#### 4a. User Message

```json
{
  "type": "message",
  "id": "80e9873d",
  "parentId": "ba45d0fa",
  "timestamp": "2026-07-06T07:17:54.465Z",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "nvim报错,怎么解决"
      }
    ],
    "timestamp": 1783322274463
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"message"` | Record type discriminator |
| `id` | `string` (8-char hex) | Unique ID for this record |
| `parentId` | `string` | Parent record ID in the causal chain |
| `timestamp` | `string` (ISO 8601) | Record-level timestamp |
| `message.role` | `"user"` | Message role |
| `message.content` | `array` of content blocks | Message content |
| `message.content[].type` | `"text"` | Content block type |
| `message.content[].text` | `string` | The user's input text |
| `message.timestamp` | `number` (Unix ms) | Message-level timestamp |

#### 4b. Assistant Message (with thinking, tool calls, and text)

A single assistant message can contain multiple content blocks in sequence:

```json
{
  "type": "message",
  "id": "4f1b8aae",
  "parentId": "80e9873d",
  "timestamp": "2026-07-06T07:18:08.940Z",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "The error is in Neovim's treesitter module...",
        "thinkingSignature": "reasoning_content"
      },
      {
        "type": "toolCall",
        "id": "call_00_BBnRszhom9Uw4tyhvNMh9500",
        "name": "bash",
        "arguments": {
          "command": "ls ~/.local/share/nvim/lazy/render-markdown.nvim/..."
        }
      },
      {
        "type": "toolCall",
        "id": "call_01_06BZOW87GJoMTsWJrT2t9595",
        "name": "bash",
        "arguments": {
          "command": "cat /opt/homebrew/share/nvim/runtime/lua/vim/treesitter.lua ..."
        }
      }
    ],
    "api": "openai-completions",
    "provider": "ollama",
    "model": "DeepSeek-V4-Flash",
    "usage": {
      "input": 1918,
      "output": 409,
      "cacheRead": 256,
      "cacheWrite": 0,
      "reasoning": 0,
      "totalTokens": 2583,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "stopReason": "toolUse",
    "timestamp": 1783322274529,
    "responseId": "f7e19537-7f51-4693-912b-94639d9ae95b|928067d9-c335-45b0-a5b0-c24adb47300d"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message.role` | `"assistant"` | Message role |
| `message.content[].type` | `"thinking"` \| `"text"` \| `"toolCall"` | Content block type |
| `message.content[].thinking` | `string` | (for `thinking` blocks) The reasoning text |
| `message.content[].thinkingSignature` | `string` | (for `thinking` blocks) Signature type (`"reasoning_content"`) |
| `message.content[].id` | `string` | (for `toolCall` blocks) Tool call ID |
| `message.content[].name` | `string` | (for `toolCall` blocks) Tool name |
| `message.content[].arguments` | `object` | (for `toolCall` blocks) Tool arguments |
| `message.api` | `string` | API type used (e.g., `"openai-completions"`) |
| `message.provider` | `string` | Provider identifier |
| `message.model` | `string` | Model identifier |
| `message.usage` | `object` | Token usage breakdown |
| `message.usage.input` | `number` | Input tokens |
| `message.usage.output` | `number` | Output tokens |
| `message.usage.cacheRead` | `number` | Cache read tokens |
| `message.usage.cacheWrite` | `number` | Cache write tokens |
| `message.usage.reasoning` | `number` | Reasoning tokens |
| `message.usage.totalTokens` | `number` | Total token count |
| `message.usage.cost` | `object` | Cost breakdown (all fields `number`) |
| `message.stopReason` | `string` | `"stop"`, `"toolUse"`, or `"error"` |
| `message.timestamp` | `number` (Unix ms) | Message-level timestamp |
| `message.responseId` | `string` | Provider response ID (pipe-separated pair) |
| `message.errorMessage` | `string` | (only when `stopReason` is `"error"`) Error description |

#### 4c. Tool Result Message

Tool results are stored as messages with `role: "toolResult"`:

```json
{
  "type": "message",
  "id": "e5f597c7",
  "parentId": "4f1b8aae",
  "timestamp": "2026-07-06T07:18:08.969Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_00_BBnRszhom9Uw4tyhvNMh9500",
    "toolName": "bash",
    "content": [
      {
        "type": "text",
        "text": "/Users/vlln/.local/share/nvim/lazy/render-markdown.nvim/lua/render-markdown/request/view.lua\n..."
      }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message.role` | `"toolResult"` | Message role |
| `message.toolCallId` | `string` | Correlates to the `id` in the corresponding `toolCall` content block |
| `message.toolName` | `string` | Name of the tool that was called |
| `message.content` | `array` of `{type: "text", text: string}` | Tool execution output |

#### 4d. Assistant Text-Only Message (final response)

When the model responds without tool calls:

```json
{
  "type": "message",
  "id": "df71a13e",
  "parentId": "acffb7e1",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "现在完成了。以下是所有修复内容的摘要..."
      }
    ],
    "api": "openai-completions",
    "provider": "ollama",
    "model": "DeepSeek-V4-Flash",
    "usage": {
      "input": 856,
      "output": 1,
      "cacheRead": 0,
      "cacheWrite": 0,
      "reasoning": 0,
      "totalTokens": 857,
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
    },
    "stopReason": "stop",
    "timestamp": 1783323065834,
    "responseId": "1a474cc1-23a8-4cc6-b007-132c5d8d5031|ffa02c54-1732-4339-92ad-699a2de98b58"
  }
}
```

---

## Causal Tree Structure

All records (except `session`) are linked via `parentId`:

```
session (root)
  └─ model_change (id="3df28002", parentId=null)
       └─ thinking_level_change (id="ba45d0fa", parentId="3df28002")
            └─ message (user) (id="80e9873d", parentId="ba45d0fa")
                 └─ message (assistant+toolCalls) (id="4f1b8aae", parentId="80e9873d")
                      ├─ message (toolResult) (id="e5f597c7", parentId="4f1b8aae")
                      ├─ message (toolResult) (id="...", parentId="4f1b8aae")
                      └─ message (assistant) (id="...", parentId="e5f597c7")  [after results]
```

- The `id` values are 8-character hex strings (e.g., `"3df28002"`)
- The `session` record has no `id` field — it uses `id` (ULID) for the session itself
- Each `parentId` points to the `id` of the record that caused this one
- The tree is always linear (no branching) — each record has at most one child, and tool results share the same parent (the assistant message that emitted the tool calls)

---

## Key Design Characteristics

1. **All content is inline.** Thinking, tool calls, and tool results are all content blocks within `message` records — there are no separate `toolCall` or `toolResult` top-level records. The `message` type is the universal container.

2. **No sub-agent support.** All conversation is in a single file. There is no mechanism for agent spawning or multi-agent sessions.

3. **Dual timestamp system.** Each message has both a record-level `timestamp` (ISO 8601 string) and a message-level `timestamp` (Unix ms number). The reason for this duality is unclear but both are always present.

4. **Provider/model tracking.** Every assistant message records the `provider`, `model`, and `api` used. The `model_change` records track when the user switches models mid-session.

5. **Error handling.** Assistant messages with `stopReason: "error"` include an `errorMessage` field. Usage is still recorded (typically all zeros).

6. **No session-level metadata file.** All metadata is in the first few records of the JSONL. There is no separate `state.json` or equivalent.

7. **No tool result persistence.** Tool results are stored inline in the JSONL. There is no separate tool-results directory for large outputs.

8. **Cost tracking.** Every assistant message records token costs (even if all values are zero for local models). The cost object always has `input`, `output`, `cacheRead`, `cacheWrite`, and `total` fields.

---

## Complete Record Type Summary

| # | Type | Per Session | Has `id` | Has `parentId` | Has `message` |
|---|------|-------------|----------|----------------|---------------|
| 1 | `session` | 1 | ✅ (ULID) | ❌ | ❌ |
| 2 | `model_change` | 1+ | ✅ (hex8) | ✅ | ❌ |
| 3 | `thinking_level_change` | 1 | ✅ (hex8) | ✅ | ❌ |
| 4 | `message` | N | ✅ (hex8) | ✅ | ✅ |

---

## Example: Minimal Session

```jsonl
{"type":"session","version":3,"id":"019f377c-efa5-7894-87e9-9117316a79f2","timestamp":"2026-07-06T12:52:42.533Z","cwd":"/path/to/project"}
{"type":"model_change","id":"f8f7d572","parentId":null,"timestamp":"2026-07-06T12:52:42.541Z","provider":"ollama","modelId":"DeepSeek-V4-Flash"}
{"type":"thinking_level_change","id":"4d453984","parentId":"f8f7d572","timestamp":"2026-07-06T12:52:42.541Z","thinkingLevel":"off"}
{"type":"message","id":"c89e4670","parentId":"4d453984","timestamp":"2026-07-06T12:52:42.544Z","message":{"role":"user","content":[{"type":"text","text":"say hello"}],"timestamp":1783342362543}}
{"type":"message","id":"...","parentId":"c89e4670","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}],...}}
```