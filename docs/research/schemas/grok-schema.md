# Grok Session Storage Schema

## Overview

**Grok** (by xAI) is a coding agent CLI. It stores session data in `~/.grok/` with a project-based directory structure, using JSONL files for messages, events, and streaming updates, plus SQLite for FTS search and worktree tracking.

| Attribute | Value |
|-----------|-------|
| Vendor | xAI |
| Base Path | `~/.grok/` |
| Schema Model | Event stream (temporal) + streaming update log |
| File Format | JSONL + SQLite + TOML |
| Observed Version | `0.2.93` |

---

## Directory Structure

```
~/.grok/
├── agent_id                          # UUID string
├── config.toml                       # CLI configuration
├── version.json                      # {"version": "0.2.93", ...}
├── active_sessions.json              # Active sessions list
├── models_cache.json                 # Model cache
├── auth.json                         # Authentication
├── CHANGELOG.json / CHANGELOG.md
├── README.md
├── tip_cursor.json
├── slash-mru.json
├── .metadata_version
├── logs/
├── completions/                      # Shell completions
├── bundled/                          # Bundled agents, roles, personas, skills
│   ├── agents/                       # explore.md, general-purpose.md, plan.md
│   ├── roles/                        # TOML role definitions
│   ├── personas/                     # TOML persona definitions
│   ├── skills/                       # Bundled skills
│   └── manifest.json
├── skills/                           # User-installed skills
├── marketplace-cache/
├── installed-plugins/
├── downloads/
├── docs/
├── vendor/
├── upload_queue/
├── worktrees.db                      # ★ Git worktree tracking (SQLite)
└── sessions/
    ├── session_search.sqlite         # ★ FTS5 session search index
    └── %2F<url-encoded-cwd>/         # Per-project directory
        ├── prompt_history.jsonl      # Per-project prompt history
        └── <ULID>/                   # Session directory
            ├── summary.json          # Session metadata
            ├── chat_history.jsonl    # ★ Messages (canonical)
            ├── events.jsonl          # Turn/loop events
            ├── updates.jsonl         # ★ Streaming update delta log
            ├── rewind_points.jsonl   # Checkpoint/rewind points
            ├── prompt_context.json   # Prompt context
            ├── system_prompt.txt     # System prompt
            ├── signals.json          # Session metrics
            ├── resources_state.json  # Tool resource state
            ├── announcement_state.json
            ├── recap_requests/       # Context recaps
            │   └── <uuid>.json
            └── terminal/             # Terminal output logs
                └── call-<id>-<n>.log
```

### CWD Encoding

URL-encoded: `/Users/vlln/agent-space` → `%2FUsers%2Fvlln%2Fagent-space`

### Session ID

ULID format: `019f4b1a-1d95-7983-b9bf-e66520e70af9`

---

## Storage Layer 1: `chat_history.jsonl` (Canonical Messages)

The primary message store. One JSON object per line, temporal order.

### Record Types

| Type | Count (sample) | Description |
|------|---------------|-------------|
| `system` | 1 | System prompt |
| `user` | 11 | User messages (with system reminders interleaved) |
| `assistant` | 20 | Model responses with tool calls |
| `reasoning` | 20 | Encrypted reasoning/thinking |
| `tool_result` | 35 | Tool execution results |

### System Message

```json
{
  "type": "system",
  "content": "You are Grok 4.5 released by xAI..."
}
```

Plain text string content.

### User Message

```json
{
  "type": "user",
  "content": [
    {
      "type": "text",
      "text": "<user_query>\ngrok cli 能配置URL/API吗\n</user_query>"
    }
  ]
}
```

Uses **OpenAI content block format**: `content[]` array of `{type: "text", text: "..."}` objects. System reminders are injected as user-type messages with `synthetic_reason: "system_reminder"`.

### Assistant Message

```json
{
  "type": "assistant",
  "content": "这是配置相关问题，我先查 Grok CLI 的文档说明。",
  "tool_calls": [
    {
      "id": "call-956f880f-04ef-43e8-8727-a1d3a4bcd750-0",
      "name": "read_file",
      "arguments": "{\"target_file\":\"/Users/vlln/.grok/skills/help/SKILL.md\"}"
    }
  ],
  "model_id": "grok-4.5",
  "model_fingerprint": "fp_a39489019fa99b6e",
  "reasoning_effort": "medium"
}
```

- `content` is plain text (not content blocks)
- `tool_calls` array with `{id, name, arguments}` (arguments is JSON string)
- `reasoning_effort` per message

### Reasoning Message

```json
{
  "type": "reasoning",
  "id": "rs_c4a32e85-e4ee-97c4-a20d-c809bd50a3b5",
  "summary": [
    {
      "type": "summary_text",
      "text": "The user is asking about whether Grok CLI can configure URL/API settings..."
    }
  ],
  "encrypted_content": "AvYzOZ9zLY+I4VnxmndtVQM0jaqqQk2CJ3jtrzuyVq...",
  "status": "completed"
}
```

**Encrypted reasoning** — like Codex. The `summary` field provides a plaintext summary, while `encrypted_content` is the full reasoning trace.

### Tool Result

```json
{
  "type": "tool_result",
  "tool_call_id": "call-956f880f-04ef-43e8-8727-a1d3a4bcd750-0",
  "result": "...",
  "status": "completed"
}
```

> **Errata (2026-07-24, formal adapter sweep — see docs/plans/0012-grok-adapter/01-report-grok.md):** the shape above is the older form. Real data observed at implementation time (Grok `0.2.106`, 9 sessions / 35 tool results) uses `{"type":"tool_result","tool_call_id":"...","content":"..."}` — no `result`, no `status`, and no error marker at all, so a failed call is indistinguishable from a successful one. Consumers should treat `{tool_call_id, content}` as canonical and merely tolerate the documented `{result, status}` form.

---

## Storage Layer 2: `updates.jsonl` (Streaming Delta Log)

A complete log of every streaming update chunk. Much larger than `chat_history.jsonl` (1MB vs 263KB in the sample). Each line is a `session/update` method call.

### Update Types

| `sessionUpdate` | Description |
|-----------------|-------------|
| `user_message_chunk` | User input streaming |
| `agent_thought_chunk` | Reasoning/thinking streaming chunk |
| `agent_message_chunk` | Assistant response streaming chunk |
| `tool_call` | Tool call invocation with `x.ai/tool` metadata |
| `tool_call_update` | Tool call result with location info |
| `tool_result` | Tool execution result |

### Example: `agent_thought_chunk`

```json
{
  "timestamp": 1783671460,
  "method": "session/update",
  "params": {
    "sessionId": "019f4b1a-1d95-7983-b9bf-e66520e70af9",
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "content": {
        "type": "text",
        "text": "The user is asking about whether Grok CLI can configure URL/API settings..."
      }
    },
    "_meta": {
      "totalTokens": 3302,
      "eventId": "019f4b1a-1d95-7983-b9bf-e66520e70af9-46",
      "agentTimestampMs": 1783671460317,
      "promptId": "10ef7f89-d85a-45af-b41c-47b9d66ca335",
      "streamStartMs": 1783671459603,
      "turnStartMs": 1783671458266,
      "updateType": "AgentThoughtChunk",
      "chunkId": 44
    }
  }
}
```

### Example: `tool_call`

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call-956f880f-04ef-43e8-8727-a1d3a4bcd750-0",
  "title": "read_file",
  "rawInput": {
    "target_file": "/Users/vlln/.grok/skills/help/SKILL.md"
  },
  "_meta": {
    "x.ai/tool": {
      "version": 1,
      "name": "read_file",
      "kind": "read",
      "namespace": "grok_build",
      "label": "Read",
      "read_only": true
    }
  }
}
```

Each tool call carries `x.ai/tool` metadata with `version`, `name`, `kind` (read/write), `namespace`, `label`, and `read_only` flag.

---

## Storage Layer 3: `summary.json` (Session Metadata)

```json
{
  "info": {
    "id": "019f4b1a-1d95-7983-b9bf-e66520e70af9",
    "cwd": "/Users/vlln/agent-space"
  },
  "session_summary": "grok cli 能配置URL/API吗",
  "created_at": "2026-07-10T08:17:10.628289Z",
  "updated_at": "2026-07-10T08:52:41.349704Z",
  "num_messages": 168,
  "num_chat_messages": 87,
  "current_model_id": "grok-4.5",
  "next_trace_turn": 8,
  "chat_format_version": 1,
  "request_id": "b9bcca7c-6bc5-4bc3-8660-8ddae10f6c19",
  "grok_home": "/Users/vlln/.grok",
  "last_active_at": "2026-07-10T08:45:35.540054Z",
  "generated_title": "grok cli 能配置URL/API吗",
  "agent_name": "grok-build-plan",
  "sandbox_profile": "off",
  "reasoning_effort": "high"
}
```

---

## Storage Layer 4: `events.jsonl` (Execution Events)

```json
{"ts": "2026-07-10T08:17:38.131Z", "type": "turn_started", "session_id": "...", "turn_number": 0, "model_id": "grok-4.5", "yolo_mode": false, "conversation_message_count": 3, "session_relationship": "primary", "schema_version": "1.0"}
{"ts": "2026-07-10T08:17:38.266Z", "type": "loop_started", "loop_index": 0}
{"ts": "2026-07-10T08:17:38.267Z", "type": "phase_changed", "phase": "waiting_for_model"}
```

Tracks the agent's execution lifecycle at the turn/loop/phase level.

---

## Storage Layer 5: `signals.json` (Session Metrics)

The most comprehensive metrics of any observed harness:

```json
{
  "turnCount": 8,
  "userMessageCount": 8,
  "assistantMessageCount": 20,
  "errorCount": 0,
  "toolFailureCount": 0,
  "cancellationCount": 0,
  "toolCallCount": 35,
  "toolsUsed": ["list_dir", "read_file", "grep", "run_terminal_command"],
  "modelsUsed": ["grok-4.5"],
  "contextWindowUsage": 14,
  "contextTokensUsed": 71735,
  "contextWindowTokens": 500000,
  "compactionCount": 0,
  "totalTokensBeforeCompaction": 0,
  "agentLinesAdded": 0,
  "agentLinesRemoved": 0,
  "humanLinesAdded": 0,
  "humanLinesRemoved": 0,
  "agentFilesTouched": 0,
  "humanFilesTouched": 0,
  "sessionDurationSeconds": 1421,
  "avgTimeToFirstTokenMs": 1526,
  "avgResponseTimeMs": 8100,
  "minTimeToFirstTokenMs": 493,
  "maxTimeToFirstTokenMs": 3483,
  "itlP50Ms": 0,
  "itlP99Ms": 51,
  "itlMaxMs": 179,
  "totalChunkCount": 10070,
  "peakRssBytes": 136429568,
  "gitCommitCount": 0,
  "prCreatedCount": 0,
  "editAndRetryCount": 0,
  "positiveRatings": 0,
  "negativeRatings": 0,
  "longPausesCount": 7
}
```

> **Errata (2026-07-24, formal adapter sweep — see docs/plans/0012-grok-adapter/01-report-grok.md):** the token metrics in this file are context-window occupancy, not request-level usage. `contextTokensUsed` (together with `contextWindowUsage` / `contextWindowTokens`) measures how full the context window is; it is NOT a sum of per-request input/output tokens, and `chat_history.jsonl` carries no record-level usage blocks either. Consumers needing usage figures (input/output/cache sums) will find no honest source in Grok's local storage — do not treat these aggregates as usage data. The genuinely useful session stats here are `turnCount` and `sessionDurationSeconds`.

---

## Storage Layer 6: `session_search.sqlite` (FTS5 Index)

```sql
CREATE TABLE session_docs (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_indexed_offset INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE session_docs_fts USING fts5(
  title, content,
  content='session_docs',
  content_rowid='rowid'
);
```

Full-text search over session titles and content, with triggers to keep the FTS index in sync.

---

## Storage Layer 7: `worktrees.db` (Git Worktree Tracking)

```sql
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  source_repo TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'session',
  creation_mode TEXT NOT NULL DEFAULT 'linked',
  git_ref TEXT,
  head_commit TEXT,
  session_id TEXT,
  creator_pid INTEGER,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'alive',
  metadata TEXT
);
```

Tracks git worktrees created per session. Links worktrees to sessions via `session_id`.

---

## Causal Model: Event Stream (temporal)

Grok uses a **temporal event stream** model — no explicit causal links between records. Order is implied by file sequence.

```
system → user → reasoning → assistant(tool_calls) → tool_result → ...
```

The `updates.jsonl` provides a finer-grained view of the same events as streaming deltas.

---

## Message Content Model

| Feature | Format |
|---------|--------|
| User message | OpenAI `content[]` array of `{type: "text", text}` |
| Assistant message | Plain text `content` + `tool_calls[]` array |
| Reasoning | `encrypted_content` (like Codex) + `summary[]` plaintext |
| Tool call | `{id, name, arguments}` (arguments is JSON string) |
| Tool result | `{tool_call_id, result, status}` |
| System reminders | User-type messages with `synthetic_reason: "system_reminder"` |

> **Errata (2026-07-24):** the Tool result row shows the older shape — see the Tool Result errata above; the observed form is `{tool_call_id, content}` with no `status`.

---

## Timestamp Formats

| Field | Format | Example |
|-------|--------|---------|
| `summary.json.created_at` | ISO 8601 | `"2026-07-10T08:17:10.628289Z"` |
| `events.jsonl.ts` | ISO 8601 | `"2026-07-10T08:17:38.131Z"` |
| `updates.jsonl.timestamp` | Unix seconds | `1783671460` |
| `updates.jsonl._meta.agentTimestampMs` | Unix ms | `1783671460317` |

---

## Additional Features

| Feature | Support |
|---------|---------|
| Encrypted reasoning | ✅ `reasoning.encrypted_content` + plaintext `summary` |
| Streaming update log | ✅ `updates.jsonl` with per-chunk token counts |
| Context compaction | ✅ `compactionCount`, `totalTokensBeforeCompaction` in signals |
| Session metrics | ✅ `signals.json` — most comprehensive metrics (latency, tokens, lines, files) |
| FTS session search | ✅ `session_search.sqlite` with FTS5 |
| Git worktree tracking | ✅ `worktrees.db` with session linkage |
| Rewind/checkpoint | ✅ `rewind_points.jsonl` with `file_snapshots` |
| Resource state | ✅ `resources_state.json` (tool parameter overrides) |
| Recap/context | ✅ `recap_requests/<uuid>.json` (context snapshots) |
| Terminal logs | ✅ `terminal/call-<id>-<n>.log` |
| Agent mode | ✅ `agent_name` (e.g., "grok-build-plan") |
| Sandbox | ✅ `sandbox_profile` |
| Reasoning effort | ✅ `reasoning_effort` per session ("high"/"medium") |
| Personas | ✅ Bundled persona system (implementer, reviewer, test-writer, etc.) |
| Plan mode | ❌ Not observed |
| Goal tracking | ❌ Not observed |
| Sub-agents | ❌ Not observed as separate files |
| Memory (MEMORY.md) | ❌ `memory_enabled: false` |

---

## Key Design Characteristics

1. **Temporal event stream** — like Kimi/Codex, no explicit causal links
2. **Dual storage** — `chat_history.jsonl` (canonical) + `updates.jsonl` (streaming deltas)
3. **Encrypted reasoning** — like Codex, with plaintext summaries
4. **Rich metrics** — `signals.json` has the most comprehensive metrics of any harness
5. **FTS5 search** — SQLite-based full-text search over sessions
6. **Git worktree integration** — tracks worktrees per session in SQLite
7. **Streaming fidelity** — `updates.jsonl` captures every chunk of model output
8. **OpenAI content format** — `content[]` array for user messages
9. **x.ai tool metadata** — tool calls carry `x.ai/tool` with `kind`, `namespace`, `read_only`
10. **URL-encoded CWD** — project directories use percent-encoding

---

## Implications for Unified Abstraction

Grok is a **Tier 1** harness (full local access):

- **Available locally:** Full session history, messages, tool calls, streaming deltas, metrics
- **Causal model:** Temporal stream — straightforward to linearize
- **Message format:** OpenAI content blocks + plain text — easy to normalize
- **Tool calls:** Inline in assistant messages with `tool_calls[]` array
- **Encrypted reasoning:** Like Codex — needs special handling
- **Metrics:** `signals.json` provides rich analytics not available in other harnesses
- **Streaming log:** `updates.jsonl` provides per-chunk detail for debugging/replay