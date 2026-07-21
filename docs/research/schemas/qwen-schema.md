# Qwen Code Session Storage Schema

## Overview

**Qwen Code** (aka Qwen CLI, by Alibaba) is a coding agent harness. It stores session data in `~/.qwen/` using a flat project-based directory structure with JSONL chat files.

| Attribute | Value |
|-----------|-------|
| Vendor | Alibaba (Qwen Team) |
| Base Path | `~/.qwen/` |
| Schema Model | Tree (`parentUuid`) |
| File Format | JSONL (one JSON object per line) |
| Observed Version | `0.19.1` |

---

## Directory Structure

```
~/.qwen/
├── installation_id                    # UUID string
├── settings.json                      # Model providers, auth, env config
├── output-language.md                 # LLM output language preference
├── tip_history.json                   # UI tips shown to user
├── usage_record.jsonl                 # Per-session usage summaries
├── usage/
│   └── token-usage-YYYY-MM.jsonl      # Per-API-call token usage, partitioned by month
├── memories/
│   └── MEMORY.md                      # Global memory store
├── tmp/
│   └── <hash>/
│       ├── logs.json
│       └── scheduled_tasks.lock
└── projects/
    └── -<cwd-encoded>/
        ├── meta.json                  # {version, createdAt, updatedAt}
        ├── memory/
        │   └── MEMORY.md              # Project-level memory
        ├── extract-cursor.json        # Auto-memory extraction cursor
        └── chats/
            ├── <uuid>.jsonl           # Chat session records
            └── <uuid>.runtime.json    # Runtime metadata for the session
```

### CWD Encoding

`/` → `-`, then prepend `-`. Example: `/tmp/st` → `-tmp-st`, `/home/user/project` → `-home-user-project`

---

## Session Lifecycle

### meta.json

```json
{
  "version": 1,
  "createdAt": "2026-06-24T13:02:22.700Z",
  "updatedAt": "2026-06-24T13:02:22.700Z"
}
```

### runtime.json

```json
{
  "schema_version": 1,
  "pid": 3532114,
  "session_id": "b748de2e-a9b5-44a8-9f82-28f99bc56469",
  "work_dir": "/home/user/agent-space/agent-platform",
  "hostname": "dev-machine",
  "started_at": 1782305492.311,
  "qwen_version": "0.19.1"
}
```

### extract-cursor.json

Tracks auto-memory extraction progress:

```json
{
  "sessionId": "6d470352-9707-4ba1-b6a6-ad7fdd0f2576",
  "processedOffset": 5,
  "updatedAt": "2026-06-24T13:02:44.173Z"
}
```

---

## Chat Record Schema (JSONL)

Each line in the `.jsonl` file is a JSON object with these common fields:

```typescript
interface QwenRecord {
  uuid: string              // UUIDv4 — unique record ID
  parentUuid: string | null // Causal parent record UUID (null = root)
  sessionId: string         // UUIDv4 — session ID
  timestamp: string         // ISO 8601
  type: "user" | "assistant" | "system"
  cwd: string               // Working directory
  version: string           // Qwen CLI version (e.g. "0.19.1")
  gitBranch?: string        // Git branch (present on projects with git)
}
```

### Causal Model: Tree (`parentUuid`)

Each record has a single `parentUuid` pointing to the record that caused it. The tree is reconstructed by following `parentUuid` chains. This is identical to Pi Agent's model.

```
user → system(attribution) → system(ui_telemetry) → assistant → system(ui_telemetry) → ...
```

---

## Record Types

### 1. User Message (`type: "user"`)

```json
{
  "uuid": "c7ef8382-e7bb-4d95-b6b7-b50a9ad5ed13",
  "parentUuid": null,
  "sessionId": "6d470352-9707-4ba1-b6a6-ad7fdd0f2576",
  "timestamp": "2026-06-24T13:02:17.009Z",
  "type": "user",
  "cwd": "/tmp/st",
  "version": "0.19.1",
  "message": {
    "role": "user",
    "parts": [
      { "text": "Say hello" }
    ]
  }
}
```

Uses Google GenAI-style `parts[]` array. Each part has `text` (required) and optionally `thought: true`.

### 2. Assistant Message (`type: "assistant"`)

```json
{
  "uuid": "ed83c771-28ee-453e-b070-1d9419a8d11c",
  "parentUuid": "19043246-a609-4ced-b617-daea73c0a985",
  "sessionId": "6d470352-9707-4ba1-b6a6-ad7fdd0f2576",
  "timestamp": "2026-06-24T13:02:22.695Z",
  "type": "assistant",
  "cwd": "/tmp/st",
  "version": "0.19.1",
  "model": "deepseek-v4-flash",
  "message": {
    "role": "model",
    "parts": [
      {
        "text": "The user just said \"Say hello\"...",
        "thought": true
      },
      {
        "text": "Hello! How can I help you today?"
      }
    ]
  },
  "usageMetadata": {
    "promptTokenCount": 29849,
    "candidatesTokenCount": 31,
    "thoughtsTokenCount": 20,
    "totalTokenCount": 29880,
    "cachedContentTokenCount": 0
  },
  "contextWindowSize": 1000000
}
```

Key points:
- `message.role` is `"model"` (not `"assistant"`)
- `parts[]` uses `thought: true` to mark thinking/reasoning content
- `usageMetadata` is separate from the message body
- `contextWindowSize` is per-message

### 3. System: Attribution Snapshot (`type: "system"`, `subtype: "attribution_snapshot"`)

```json
{
  "uuid": "c4f52aa9-2b84-47e3-96f5-f119ba89138a",
  "parentUuid": "c7ef8382-e7bb-4d95-b6b7-b50a9ad5ed13",
  "sessionId": "6d470352-9707-4ba1-b6a6-ad7fdd0f2576",
  "timestamp": "2026-06-24T13:02:17.022Z",
  "type": "system",
  "cwd": "/tmp/st",
  "version": "0.19.1",
  "subtype": "attribution_snapshot",
  "systemPayload": {
    "snapshot": {
      "type": "attribution-snapshot",
      "version": 1,
      "surface": "cli",
      "fileStates": {},
      "promptCount": 1,
      "promptCountAtLastCommit": 0
    }
  }
}
```

### 4. System: File History Snapshot (`type: "system"`, `subtype: "file_history_snapshot"`)

```json
{
  "uuid": "20a86a61-d122-4ef5-8ab1-0223268eb33b",
  "parentUuid": "6c065ed6-5b17-4582-a9ff-fac32d9f86de",
  "sessionId": "b748de2e-a9b5-44a8-9f82-28f99bc56469",
  "timestamp": "2026-06-24T12:53:05.102Z",
  "type": "system",
  "cwd": "/home/user/agent-space/agent-platform",
  "version": "0.19.1",
  "gitBranch": "main",
  "subtype": "file_history_snapshot",
  "systemPayload": {
    "snapshots": [
      {
        "promptId": "b748de2e-a9b5-44a8-9f82-28f99bc56469########0",
        "timestamp": "2026-06-24T12:53:05.101Z",
        "trackedFileBackups": {}
      }
    ]
  }
}
```

### 5. System: UI Telemetry (`type: "system"`, `subtype: "ui_telemetry"`)

```json
{
  "uuid": "19043246-a609-4ced-b617-daea73c0a985",
  "parentUuid": "c4f52aa9-2b84-47e3-96f5-f119ba89138a",
  "sessionId": "6d470352-9707-4ba1-b6a6-ad7fdd0f2576",
  "timestamp": "2026-06-24T13:02:22.694Z",
  "type": "system",
  "cwd": "/tmp/st",
  "version": "0.19.1",
  "subtype": "ui_telemetry",
  "systemPayload": {
    "uiEvent": {
      "event.name": "qwen-code.api_response",
      "event.timestamp": "2026-06-24T13:02:22.693Z",
      "response_id": "chatcmpl-3697e21b-19cd-9e52-9071-c2d77c06a1f7",
      "model": "deepseek-v4-flash",
      "status_code": 200,
      "duration_ms": 5652,
      "input_token_count": 29849,
      "output_token_count": 31,
      "cached_content_token_count": 0,
      "thoughts_token_count": 20,
      "total_token_count": 29880,
      "response_text": "Hello! How can I help you today?",
      "prompt_id": "6d470352-9707-4ba1-b6a6-ad7fdd0f2576########0",
      "auth_type": "openai",
      "subagent_name": "managed-auto-memory-extractor"  // optional
    }
  }
}
```

Telemetry events capture API call details. The `subagent_name` field appears when the call was made by a managed sub-agent (e.g., `"managed-auto-memory-extractor"`).

---

## Usage Tracking

### usage_record.jsonl (per-session summary)

```json
{
  "version": 1,
  "sessionId": "b748de2e-a9b5-44a8-9f82-28f99bc56469",
  "timestamp": 1782305592308,
  "startTime": 1782305491685,
  "project": "/home/user/agent-space/agent-platform",
  "durationMs": 100623,
  "totalLatencyMs": 5045,
  "models": {
    "deepseek-v4-flash": {
      "requests": 1,
      "inputTokens": 23781,
      "outputTokens": 35,
      "cachedTokens": 0,
      "thoughtsTokens": 19,
      "totalTokens": 23816,
      "totalLatencyMs": 5045
    }
  },
  "tools": {
    "totalCalls": 0,
    "totalSuccess": 0,
    "totalFail": 0,
    "byName": {}
  },
  "files": {
    "linesAdded": 0,
    "linesRemoved": 0
  }
}
```

### usage/token-usage-YYYY-MM.jsonl (per-API-call)

```json
{
  "schemaVersion": 1,
  "id": "22b78d9e-74d7-45bd-a2d1-dba7dfc26401",
  "timestamp": "2026-06-24T12:53:10.169Z",
  "localDate": "2026-06-24",
  "localMonth": "2026-06",
  "sessionId": "b748de2e-a9b5-44a8-9f82-28f99bc56469",
  "model": "deepseek-v4-flash",
  "authType": "openai",
  "source": "main",              // "main" or "managed-auto-memory-extractor"
  "inputTokens": 23781,
  "outputTokens": 35,
  "cachedTokens": 0,
  "thoughtsTokens": 19,
  "totalTokens": 23816,
  "apiDurationMs": 5045
}
```

---

## Message Content Model

Qwen Code uses the **Google GenAI-style** content model:

| Field | Value |
|-------|-------|
| User role | `"user"` |
| Assistant role | `"model"` |
| Content format | `parts[]` array of `{text, thought?}` objects |
| Thinking | `thought: true` flag on a part |
| Tool calls | Embedded in `parts[]` as function call parts (not observed in sample data) |
| Tool results | Embedded in `parts[]` as function response parts (not observed in sample data) |

---

## Sub-Agent Support

Qwen Code has managed sub-agents (e.g., `managed-auto-memory-extractor`). These appear in:
- `usage_record.jsonl` → `tools.byName` may show sub-agent tool calls
- `usage/token-usage-*.jsonl` → `source` field tracks which agent made the API call
- `systemPayload.uiEvent.subagent_name` → identifies the sub-agent in telemetry

Sub-agent runs are NOT stored in separate files — they're part of the main chat JSONL.

---

## Configuration (settings.json)

```json
{
  "env": {
    "DASHSCOPE_API_KEY": "sk-..."
  },
  "modelProviders": {
    "openai": [
      {
        "id": "deepseek-v4-flash",
        "name": "[ModelStudio Standard] deepseek-v4-flash",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "envKey": "DASHSCOPE_API_KEY",
        "generationConfig": {
          "contextWindowSize": 1000000
        }
      }
    ]
  },
  "security": {
    "auth": { "selectedType": "openai" }
  },
  "model": {
    "name": "deepseek-v4-flash",
    "baseUrl": ""
  },
  "providerMetadata": {
    "alibabaStandard": {
      "version": "b7e4a1e0...",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
  },
  "$version": 4
}
```

Uses OpenAI-compatible API. Primary backend is Alibaba's DashScope (ModelStudio).

---

## Additional Features

| Feature | Support |
|---------|---------|
| Memory (MEMORY.md) | ✅ Global + per-project |
| Git branch tracking | ✅ Per record (on git repos) |
| Auto-memory extraction | ✅ Background sub-agent |
| Thinking/reasoning | ✅ `thought: true` flag |
| Usage tracking | ✅ Dual-level (session summary + per-call) |
| Hostname tracking | ✅ In runtime.json |
| Tool tracking | ✅ Per-session tool call counts |
| File change tracking | ✅ Lines added/removed per session |
| Plan mode | ❌ Not observed |
| Goal tracking | ❌ Not observed |
| Context compaction | ❌ Not observed |
| Permission tracking | ❌ Not observed |
| Log files | ✅ `tmp/<hash>/logs.json` |

---

## Key Design Characteristics

1. **Tree causal model** — identical to Pi Agent, uses `parentUuid` chains
2. **Google GenAI message format** — `parts[]` array with `{text, thought?}` objects
3. **Dual usage tracking** — session-level summaries + per-API-call records
4. **Managed sub-agents** — auto-memory extractor runs as background agent
5. **Telemetry in chat stream** — API call metrics are interleaved as system records
6. **No separate tool call records** — tool calls/results are embedded in message parts
7. **Project-scoped memory** — each project has its own `memory/MEMORY.md`