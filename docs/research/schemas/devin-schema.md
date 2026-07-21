# Devin Session Storage Schema

## Overview

**Devin** (by Cognition AI) has **two** storage locations:
1. **Devin desktop app** (`~/Library/Application Support/Devin/`) — VS Code/Windsurf shell, cloud-only sessions, local tab metadata only
2. **Devin CLI** (`~/.local/share/devin/cli/`) — full local session storage in SQLite + JSON transcripts

The CLI is the primary local storage; the desktop app is a thin cloud client.

| Attribute | Value |
|-----------|-------|
| Vendor | Cognition AI |
| Base Paths | `~/.local/share/devin/cli/` (CLI) + `~/Library/Application Support/Devin/` (Desktop) |
| Schema Model | **Forest** (`node_id` + `parent_node_id` in SQLite) + ATIF transcripts |
| File Format | SQLite (`sessions.db`) + JSON transcripts |
| Observed Version | CLI `3000.1.27`, ATIF `v1.7` |

---

## Directory Structure

### Devin CLI (`~/.local/share/devin/`)

```
~/.local/share/devin/
├── credentials.toml
├── mcp/
└── cli/
    ├── installation_id                    # UUID string
    ├── tip_index
    ├── trusted_workspaces.json
    ├── skill_events_spool.lock
    ├── sessions.db                        # ★ Primary session database (16MB SQLite)
    ├── sessions.db-shm                    # WAL shared memory
    ├── sessions.db-wal                    # Write-Ahead Log (4MB)
    ├── session_locks/                     # Per-session lock files
    ├── transcripts/                       # ★ ATIF-format transcripts
    │   ├── confirmed-cloche.json          # (445KB)
    │   └── transcripts/
    │       ├── colorful-consonant.json    # (874KB)
    │       ├── grand-barometer.json       # (82KB)
    │       └── loud-hose.json             # (450KB)
    ├── plugins/
    │   └── lock.json
    └── logs/
        ├── devin_20260714-220227_3273.log
        ├── devin_20260714-222901_5189.log  # (111KB)
        ├── devin_20260717-101317_9585.log  # (85KB)
        ├── devin_20260717-113521_34087.log # (78KB)
        └── devin_20260719-231916_24007.log # (179KB)
```

### Devin Desktop (`~/Library/Application Support/Devin/`)

```
~/Library/Application Support/Devin/
├── User/globalStorage/
│   ├── state.vscdb           # Model config, chat participants
│   └── storage.json          # Workspace backups, onboarding
└── Local Storage/leveldb/    # open-sessions-by-workspace (tab metadata)
```

---

## Storage Layer 1: `sessions.db` (SQLite)

The primary session store. 16MB, 6 sessions, 2,250 message nodes.

### Schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- Descriptive name (e.g. "grand-barometer")
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,       -- "Windsurf"
  model TEXT NOT NULL,              -- e.g. "claude-5-fable-medium"
  agent_mode TEXT NOT NULL,         -- "normal" | "bypass" | "accept-edits"
  created_at INTEGER NOT NULL,      -- Unix timestamp
  last_activity_at INTEGER NOT NULL,
  title TEXT,                       -- User-provided title
  main_chain_id INTEGER,            -- Root node_id of the main conversation chain
  shell_last_seen_index INTEGER DEFAULT 0,
  cogs_json TEXT,                   -- System prompt overrides
  workspace_dirs TEXT,              -- Additional workspace directories
  hidden INTEGER NOT NULL DEFAULT 0,
  metadata TEXT                     -- JSON: {"total_credit_cost": 0, "total_acu_cost": 0.0}
);

CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,           -- Node ID within this session's forest
  parent_node_id INTEGER,             -- NULL for root nodes → FOREST structure
  chat_message TEXT NOT NULL,         -- JSON: {message_id, role, content}
  created_at INTEGER NOT NULL,
  metadata TEXT,                      -- Additional JSON metadata
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, node_id)
);

CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  is_shell INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tool_call_state (
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_call_json TEXT,              -- Serialised ACP ToolCall JSON
  tool_call_update_json TEXT,       -- Serialised ACP ToolCallUpdate JSON (final completion)
  PRIMARY KEY (session_id, tool_call_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE rendered_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  rendered_html TEXT NOT NULL,       -- HTML for terminal display
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, sequence_number)
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
```

---

## Session Record

### `sessions` table

```json
{
  "id": "confirmed-cloche",
  "working_directory": "/path/to/project",
  "backend_type": "Windsurf",
  "model": "claude-opus-4-8-medium",
  "agent_mode": "accept-edits",
  "created_at": 1752772583,
  "title": "Skill Project: Design Constraints & DDD",
  "main_chain_id": 222,
  "cogs_json": "[{\"source\":{\"Session\":\"User\"},\"lifetime\":{\"Unique\":\"core/profile\"},\"set_system_prefix\":[{...}]}]",
  "metadata": "{\"total_credit_cost\":0,\"total_acu_cost\":0.0}"
}
```

**Session IDs** are descriptive names (adjective-noun pairs): `grand-barometer`, `loud-hose`, `colorful-consonant`, `confirmed-cloche`, `bottled-magic`, `pointed-cadet`.

**Agent modes:**
- `normal` — standard interactive mode
- `bypass` — bypass safety checks
- `accept-edits` — auto-accept file edits

---

## Causal Model: Forest

Devin uses a **forest** structure — multiple trees per session, linked by `parent_node_id`:

```
Session "confirmed-cloche"
  ├─ node 0: system (Devin intro)           ← root
  │   ├─ node 1: user (first message)       ← parent_node_id=0
  │   │   ├─ node 2: system (subagent info) ← parent_node_id=1
  │   │   │   └─ node 3: assistant (reply)  ← parent_node_id=2
  │   │   └─ ...                             ← alternate branch
  │   └─ ...
  ├─ node 100: system (new context)         ← another root
  │   └─ ...
  └─ ...
```

Key differences from other harnesses:
- **Forest, not tree** — multiple root nodes (parent_node_id=NULL)
- **Branching** — a single parent can have multiple children (the model explores alternatives)
- `main_chain_id` in the sessions table identifies the "winning" branch

---

## Message Content Model

### `chat_message` JSON format

Each `message_nodes.chat_message` is a JSON string:

```json
{
  "message_id": "cd9d5d87-2011-41b0-ab04-d1bf2c7a9063",
  "role": "user",
  "content": "项目责任制协议的思路\n\n1.结构化是给计算机看的..."
}
```

### Role Distribution (across 2,250 messages)

| Role | Count | Description |
|------|-------|-------------|
| `assistant` | 1,161 | Model responses |
| `tool` | 752 | Tool call results (file views, shell outputs, skill outputs) |
| `system` | 235 | System prompts, subagent profiles, context info |
| `user` | 102 | User messages and slash commands |

### Tool Result Format

Tool messages contain structured output:

```
<file-view path="/path/to/file" start_line="1" end_line="32" total_lines="32">
  1| file content...
</file-view>
```

```
Output from command in shell 7e40ea:
/path/to/dir/:
0001-file.md
0002-file.md
```

```
The "devpact" skill is running
<skill name="devpact" status="running">
Source: /home/user/.agents/skills/example/SKILL.md
Base directory: /home/user/
```

---

## Storage Layer 2: ATIF Transcripts

JSON transcript files using the **ATIF** (Agent Task Interaction Format) protocol.

### `transcripts/<name>.json`

```json
{
  "schema_version": "ATIF-v1.7",
  "session_id": "confirmed-cloche",
  "agent": {
    "name": "devin",
    "version": "3000.1.27",
    "model_name": "Claude Opus 4.8",
    "tool_definitions": [
      {
        "type": "function",
        "function": {
          "name": "mcp_list_tools",
          "description": "List available tools and resources from MCP servers...",
          "parameters": {...}
        }
      }
    ]
  },
  "steps": [
    {
      "step_id": 1,
      "timestamp": "2026-07-17T17:13:23.628092+00:00",
      "source": "system",
      "message": "You are Devin, an interactive command line agent from Cognition..."
    },
    {
      "step_id": 2,
      "timestamp": "2026-07-17T17:13:23.629623+00:00",
      "source": "system",
      "message": "Available subagent profiles for the `run_subagent` tool..."
    }
  ],
  "final_metrics": {
    "total_prompt_tokens": 6755667,
    "total_completion_tokens": 61813,
    "total_cached_tokens": 6603063,
    "total_steps": 74
  }
}
```

### ATIF Step Structure

| Field | Description |
|-------|-------------|
| `step_id` | Sequential step number (1-based) |
| `timestamp` | ISO 8601 with timezone |
| `source` | `"system"`, `"user"`, `"assistant"`, `"tool"` |
| `message` | Plain text content |

### Transcript vs SQLite

- **Transcripts** are flat temporal sequences (like Codex/Kimi)
- **message_nodes** are forest-structured with branching
- Both represent the same data in different formats
- Transcripts may be generated on export, not maintained in real-time

---

## `rendered_commits` Table

Stores HTML-rendered versions of conversation turns for terminal display:

```html
<div class="user-message" data-prompt-mark="true">
  <div style="padding-right:1px;">❭</div>
  <div style="flex-grow:1;min-width:0;">
    <span>/model claude-fable-5 </span>
  </div>
</div>
```

1,296 rendered commits across all sessions. Each commit is a sequence-numbered HTML snippet.

---

## `app_state` Table

Simple key-value store for application state:

| Key | Value |
|-----|-------|
| `schema_compat_version` | `0` |
| `welcome_box_shown` | `true` |
| `rendered_max_node_id:<session>` | Tracks the highest rendered node_id per session |

---

## `tool_call_state` Table

Designed to store ACP (Agent Communication Protocol) tool call state:

```sql
tool_call_json      TEXT,   -- Serialised acp::ToolCall JSON
tool_call_update_json TEXT,  -- Serialised acp::ToolCallUpdate JSON
```

Currently 0 entries in the sample data, suggesting tool call state is managed in-memory or cleared after session completion.

---

## Timestamp Formats

| Field | Format | Example |
|-------|--------|---------|
| `sessions.created_at` | Unix seconds | `1752772583` |
| `sessions.last_activity_at` | Unix seconds | `1752772583` |
| `message_nodes.created_at` | Unix seconds | `1784313371` |
| `prompt_history.timestamp` | Unix seconds | — |
| `transcripts.steps[].timestamp` | ISO 8601 | `"2026-07-17T17:13:23.628092+00:00"` |

---

## Additional Features

| Feature | Support |
|---------|---------|
| Session branching | ✅ Forest model with multiple children per parent |
| Main chain tracking | ✅ `main_chain_id` in sessions table |
| Agent modes | ✅ `normal`, `bypass`, `accept-edits` |
| Sub-agents | ✅ `run_subagent` tool with profiles (`subagent_explore`, `subagent_general`) |
| Transcript export | ✅ ATIF v1.7 JSON format |
| Rendered output | ✅ HTML commits in `rendered_commits` |
| Tool call state | ✅ Schema exists (ACP protocol) |
| Prompt history | ✅ Separate `prompt_history` table |
| Shell integration | ✅ `is_shell` flag, `shell_last_seen_index` |
| Token usage | ✅ `final_metrics` in transcripts (prompt, completion, cached) |
| Credit/cost tracking | ✅ `metadata.total_credit_cost`, `total_acu_cost` |
| MCP support | ✅ Tool definitions in agent config |
| Workspace dirs | ✅ `workspace_dirs` for multi-root workspaces |
| Log files | ✅ Per-session logs |
| Plan mode | ❌ Not observed |
| Goal tracking | ❌ Not observed |
| Memory (MEMORY.md) | ❌ Not observed |

---

## Key Design Characteristics

1. **Forest causal model** — unique among observed harnesses; supports branching/exploration
2. **Dual storage** — SQLite for operational state + ATIF JSON for transcripts
3. **Descriptive session IDs** — adjective-noun pairs instead of UUIDs
4. **ACP protocol** — tool calls use Agent Communication Protocol (not OpenAI format)
5. **HTML rendering** — terminal output is pre-rendered as HTML commits
6. **Rich metadata** — credit costs, model info, agent mode, workspace dirs per session
7. **Windsurf backend** — all sessions use `backend_type: "Windsurf"`

---

## Implications for Unified Abstraction

Devin CLI is a **Tier 1** harness (full local access):

- **Available locally:** Full session history, message content, tool calls, token usage
- **Causal model:** Forest with branching — requires adapter to linearize or preserve branches
- **Message format:** Simple `{message_id, role, content}` JSON — easy to normalize
- **Tool calls:** Tool results are in `message_nodes` (role: "tool"); tool call state has separate schema
- **Transcripts:** ATIF format provides an alternative access path with metrics

### Dual Access Paths

```
SQLite (sessions.db)           ATIF Transcripts
├─ message_nodes (forest)      ├─ steps[] (temporal)
├─ tool_call_state              ├─ agent config
├─ rendered_commits             └─ final_metrics
└─ prompt_history
```

For a unified adapter, the SQLite `message_nodes` table is the primary source — it has the richest structure (branching) and is maintained in real-time. Transcripts provide a simpler flat view with metrics.