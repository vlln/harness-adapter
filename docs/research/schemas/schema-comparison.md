# Harness Session Schema Comparison

## Overview

This document compares the session storage schemas of nine coding agent harnesses:

| Harness | Vendor | Base Path | Schema Model |
|---------|--------|-----------|--------------|
| **Pi Agent** | Custom (pi-mono) | `~/.pi/agent/sessions/` | Tree (`parentId`) |
| **Claude Code** | Anthropic | `~/.claude/projects/` | Graph (`parentUuid` + `isSidechain`) |
| **Kimi Code** | Moonshot AI | `~/.kimi-code/sessions/` | Event stream (temporal) |
| **Codex** | OpenAI | `~/.codex/sessions/` | Event stream (temporal) |
| **Qwen Code** | Alibaba | `~/.qwen/projects/` | Tree (`parentUuid`) |
| **OpenCode** | OpenCode AI | `~/.opencode/` | N/A — no persistence |
| **Devin** | Cognition AI | `~/.local/share/devin/cli/` | Forest (`node_id` + `parent_node_id`) |
| **Cursor** | Anysphere | `~/.cursor/` + `~/Library/Application Support/Cursor/` | SQLite + cloud-sync |
| **Grok** | xAI | `~/.grok/` | Event stream (temporal) + streaming delta log |

---

## Directory Structure Comparison

```
Pi Agent:
  sessions/--<cwd>/--/<iso-ts>_<ulid>.jsonl
  → Flat: one directory per project, one file per session

Claude Code:
  projects/-<cwd>-/<uuid>.jsonl
  projects/-<cwd>-/<uuid>/subagents/agent-<id>.jsonl
  projects/-<cwd>-/<uuid>/subagents/agent-<id>.meta.json
  projects/-<cwd>-/<uuid>/tool-results/<id>.txt
  → Flat project dir, sub-dirs only for sessions with sub-agents

Kimi Code:
  sessions/wd_<workspace-id>/session_<uuid>/state.json
  sessions/wd_<workspace-id>/session_<uuid>/agents/main/wire.jsonl
  sessions/wd_<workspace-id>/session_<uuid>/agents/agent-N/wire.jsonl
  sessions/wd_<workspace-id>/session_<uuid>/agents/main/plans/<slug>.md
  sessions/wd_<workspace-id>/session_<uuid>/logs/kimi-code.log
  → Two-level hierarchy: workspace → session → agents

Codex:
  sessions/YYYY/MM/DD/rollout-<iso-ts>-<ulid>.jsonl
  → Date-partitioned: year/month/day directories

Qwen Code:
  projects/-<cwd-encoded>/chats/<uuid>.jsonl
  projects/-<cwd-encoded>/chats/<uuid>.runtime.json
  projects/-<cwd-encoded>/meta.json
  projects/-<cwd-encoded>/memory/MEMORY.md
  → Flat: one directory per project, one JSONL file per session

OpenCode:
  (no session data stored)
  → Binary-only installation, no persistence

Devin:
  cli/sessions.db                              → SQLite: sessions, message_nodes, tool_call_state, rendered_commits
  cli/transcripts/<name>.json                  → ATIF v1.7 JSON transcripts
  cli/logs/devin_*.log                         → Per-session logs
  → SQLite forest + ATIF transcripts; full local access

Cursor:
  User/globalStorage/state.vscdb           → Composer metadata (ItemTable)
  User/globalStorage/conversation-search.db → FTS index for conversations
  User/workspaceStorage/<id>/state.vscdb   → Per-workspace composer data
  ai-tracking/ai-code-tracking.db          → AI code attribution & git analysis
  → SQLite databases, cloud-synced message content

Grok:
  sessions/%2F<cwd-encoded>/<ulid>/chat_history.jsonl  → Messages (canonical)
  sessions/%2F<cwd-encoded>/<ulid>/updates.jsonl       → Streaming delta log
  sessions/%2F<cwd-encoded>/<ulid>/events.jsonl         → Turn/loop events
  sessions/%2F<cwd-encoded>/<ulid>/signals.json         → Session metrics
  sessions/%2F<cwd-encoded>/<ulid>/summary.json         → Session metadata
  sessions/session_search.sqlite                        → FTS5 search index
  worktrees.db                                          → Git worktree tracking
  → Temporal stream + streaming delta log; most comprehensive metrics
```

### CWD Encoding

| Harness | Pattern | Example |
|---------|---------|---------|
| Pi Agent | `--` + `/`→`-` + `--` | `--Users-user-Project-example--` |
| Claude Code | `-` + `/`→`-` + `-` | `-Users-user-Project-example` |
| Kimi Code | Workspace hash ID | `wd_kimi-code_2ab9c8b91202` |
| Codex | Date-based (no cwd encoding) | `2026/07/17/` |
| Qwen Code | `-` + `/`→`-` | `-tmp-st`, `-home-user-agent-space-agent-platform` |
| OpenCode | N/A | — |
| Devin | Descriptive name (adjective-noun) | `confirmed-cloche`, `grand-barometer` |
| Cursor | Workspace ID | `empty-window` |
| Grok | URL-encoded CWD | `%2FUsers%2Fuser%2Fagent-space` |

### Session ID

| Harness | ID Type | Example |
|---------|---------|---------|
| Pi Agent | ULID | `019f377c-efa5-7894-87e9-9117316a79f2` |
| Claude Code | UUIDv4 | `5c24449b-024a-4143-9fda-a03b6ca83428` |
| Kimi Code | UUIDv4 | `ad37ee83-0cd8-4421-ab91-6e24f83e8d3e` |
| Codex | ULID | `019f70d3-f83d-7823-a281-1a1318d7ded6` |
| Qwen Code | UUIDv4 | `6d470352-9707-4ba1-b6a6-ad7fdd0f2576` |
| OpenCode | N/A | — |
| Devin | Descriptive name | `confirmed-cloche`, `grand-barometer` |
| Cursor | UUIDv4 | `c378010d-c12b-43c1-af81-f1803d3885ea` |
| Grok | ULID | `019f4b1a-1d95-7983-b9bf-e66520e70af9` |

---

## Causal Model Comparison

### Pi Agent: Tree (`parentId`)

```
session → model_change → thinking_level_change → user_msg → assistant_msg
                                                                    ├→ toolResult
                                                                    └→ toolResult
```

- Each record has a single `parentId` pointing to the record that caused it
- Strictly linear — no branching, no multiple children (except tool results)
- The tree is reconstructed by following `parentId` chains

### Qwen Code: Tree (`parentUuid`)

```
user → system(attribution) → system(ui_telemetry) → assistant → system(ui_telemetry) → ...
```

- Identical causal model to Pi Agent, but uses `parentUuid` field name instead of `parentId`
- Each record has a single `parentUuid` pointing to the causal parent
- System events (attribution snapshot, telemetry) are interleaved in the tree
- Managed sub-agents (e.g., auto-memory-extractor) appear as telemetry events in the main stream

### Claude Code: Directed Graph (`parentUuid` + `isSidechain`)

```
main:
  queue-operation → attachment(goal) → user → assistant
                                                      ↓
sidechain (sub-agent file):
  user(task) → assistant → assistant(tool_use) → ...
```

- Each record has a `parentUuid` pointing to the causal parent
- `isSidechain: true` marks sub-agent branches
- Sub-agents live in separate files but reference main session UUIDs
- The graph can have multiple children per parent (branching)

### Kimi Code: Event Stream (temporal)

```
metadata → tools.set_active_tools → config.update → turn.prompt → context.append_message
  → context.append_loop_event(step.begin)
  → context.append_loop_event(content.part)
  → context.append_loop_event(tool.call)
  → context.append_loop_event(tool.result)
  → context.append_loop_event(step.end)
  → usage.record
```

- No explicit causal links between records
- Order is implied by the `time` field and file sequence
- Two-layer model: `context.append_loop_event` wraps agent execution events
- Per-agent isolation: each agent has its own `wire.jsonl`

### Codex: Event Stream (temporal, dual-format)

```
session_meta → task_started → turn_context → response_item(user message)
  → event_msg(user_message) → response_item(reasoning) → event_msg(agent_message)
  → response_item(function_call) → function_call → function_call_output
  → event_msg(token_count) → task_complete
```

- No explicit causal links between records
- Order is implied by `timestamp` and file sequence
- Dual format: same information appears in both `response_item` and `event_msg` types
- Dense: ~14,000 records per session

### Grok: Event Stream (temporal, dual-layer)

```
chat_history.jsonl (canonical, 87 messages):
  system → user → reasoning → assistant(tool_calls) → tool_result → ...

updates.jsonl (streaming deltas, 1MB):
  user_message_chunk → agent_thought_chunk → agent_message_chunk → tool_call → tool_call_update → tool_result
```

- No explicit causal links between records
- Order is implied by file sequence
- **Dual-layer**: `chat_history.jsonl` (final messages) + `updates.jsonl` (per-chunk streaming deltas)
- `events.jsonl` provides turn/loop/phase lifecycle events
- Encrypted reasoning (`reasoning.encrypted_content`) with plaintext summaries
- Rich metrics in `signals.json` (latency, tokens, lines, tool counts)

### Devin: Forest (`node_id` + `parent_node_id`)

```
Session "confirmed-cloche"
  ├─ node 0: system (Devin intro)           ← root (parent_node_id=NULL)
  │   ├─ node 1: user (first message)       ← parent_node_id=0
  │   │   ├─ node 2: system (subagent info) ← parent_node_id=1
  │   │   │   └─ node 3: assistant (reply)  ← parent_node_id=2
  │   │   └─ ...                             ← alternate branch
  │   └─ ...
  ├─ node 100: system (new context)         ← another root
  │   └─ ...
  └─ ...
```

- **Forest** — multiple root nodes per session (parent_node_id=NULL)
- **Branching** — a single parent can have multiple children (model explores alternatives)
- `main_chain_id` in the sessions table identifies the "winning" branch
- Stored in SQLite `message_nodes` table: `{session_id, node_id, parent_node_id, chat_message}`
- `chat_message` is JSON: `{message_id, role, content}`
- Roles: `assistant` (1161), `tool` (752), `system` (235), `user` (102)
- Dual access: also available as flat ATIF v1.7 JSON transcripts

### Cursor: Cloud-Synced (local metadata only)

```
composerHeaders (metadata) → cloud-synced message content → conversation-search.db (FTS index)
```

- Message content is cloud-stored, not locally accessible as structured records
- Local metadata: `composer.composerHeaders` (session list with modes, status)
- FTS index: `conversation_fts` (searchable body text)
- Code attribution: `ai-code-tracking.db` (AI vs human code tracking)

### OpenCode: No Local Persistence

- No causal model — no session data stored locally
- Binary-only CLI, ephemeral or cloud-only sessions

---

## Message Content Model

### Content Format by Harness

| Feature | Pi Agent | Claude Code | Kimi Code | Codex |
|---------|----------|-------------|-----------|-------|
| **User message format** | `content[]` array | Plain string (XML for commands) | `content[]` array | `content[]` array |
| **Assistant message** | Single `message` with mixed content blocks | Single `message` with mixed content blocks | Separate `content.part` events per block | Separate `response_item` records per block |
| **Thinking content** | `content[].type: "thinking"` | `content[].type: "thinking"` | `event.part.type: "think"` | `payload.type: "reasoning"` (encrypted) |
| **Tool call** | `content[].type: "toolCall"` | `content[].type: "tool_use"` | `event.type: "tool.call"` | `payload.type: "function_call"` |
| **Tool result** | Separate `message` with `role: "toolResult"` | Inline in user messages (presumed) | `event.type: "tool.result"` | `function_call_output` (top-level) |
| **Image support** | Not observed | Not observed | Not observed | `input_image` type |

| Feature | Qwen Code | OpenCode | Devin | Cursor |
|---------|-----------|----------|-------|--------|
| **User message format** | `parts[]` array (Google GenAI) | N/A | N/A | Cloud-synced |
| **Assistant message** | Single `message` with `parts[]` | N/A | N/A | Cloud-synced |
| **Thinking content** | `part.thought: true` flag | N/A | N/A | Cloud-synced |
| **Tool call** | Embedded in `parts[]` (not observed) | N/A | N/A | Cloud-synced |
| **Tool result** | Embedded in `parts[]` (not observed) | N/A | N/A | Cloud-synced |
| **Image support** | Not observed | N/A | N/A | Cloud-synced |

**Key distinction:** Qwen Code uses the **Google GenAI** `parts[]` format instead of the OpenAI `content[]` format. The assistant role is `"model"` (not `"assistant"`). Thinking is marked with `thought: true` on individual parts, not as a separate content type.

---

## Timestamp Formats

| Harness | Format | Field Name | Example |
|---------|--------|------------|---------|
| Pi Agent | ISO 8601 string | `timestamp` | `"2026-07-06T12:52:42.533Z"` |
| Pi Agent | Unix ms number | `message.timestamp` | `1783342362543` |
| Claude Code | ISO 8601 string | `timestamp` | `"2026-07-14T05:15:46.655Z"` |
| Kimi Code | Unix ms number | `time` | `1782128092403` |
| Codex | ISO 8601 string | `timestamp` | `"2026-07-17T16:07:01.531Z"` |
| Qwen Code | ISO 8601 string | `timestamp` | `"2026-06-24T13:02:17.009Z"` |
| Qwen Code | Unix ms number | `started_at` (runtime.json) | `1782305492.311` |
| OpenCode | N/A | — | — |
| Devin | N/A | — | — |
| Cursor | Unix ms number | `createdAt`, `lastUpdatedAt` | `1784563143058` |

**Notable:** Pi Agent and Qwen Code both use dual timestamp formats. Kimi Code is the only harness that exclusively uses Unix ms and names the field `time` instead of `timestamp`. Cursor uses Unix ms exclusively.

---

## Metadata & Environment

| Feature | Pi Agent | Claude Code | Kimi Code | Codex |
|---------|----------|-------------|-----------|-------|
| **Session metadata** | First record in JSONL | Scattered across records | `state.json` file | `session_meta` record |
| **CWD** | `session.cwd` + dir name | Every record has `cwd` | Workspace ID in path | `session_meta.payload.cwd` + `turn_context.payload.cwd` |
| **Git branch** | Not tracked | Every record has `gitBranch` | Not tracked | `session_meta.payload.git.branch` |
| **Git commit** | Not tracked | Not tracked | Not tracked | `session_meta.payload.git.commit_hash` |
| **CLI version** | Not tracked | Every record has `version` | Not tracked | `session_meta.payload.cli_version` |
| **Model info** | Per-message `provider` + `model` | Per-message `message.model` | `config.update.modelAlias` | `turn_context.payload.model` |
| **Protocol version** | `session.version` (3) | None | `metadata.protocol_version` ("1.4") | None |
| **Session title** | Not tracked | Not tracked | `state.json.title` | Not tracked |
| **Permissions** | Not tracked | Not tracked | `permission.*` events | `turn_context.payload.permission_profile` |
| **Sandbox policy** | Not tracked | Not tracked | Not tracked | `turn_context.payload.sandbox_policy` |

| Feature | Qwen Code | OpenCode | Devin | Cursor |
|---------|-----------|----------|-------|--------|
| **Session metadata** | `meta.json` + `runtime.json` | N/A | N/A | `composer.composerHeaders` |
| **CWD** | `runtime.json.work_dir` + dir name | N/A | N/A | `workspaceIdentifier.id` |
| **Git branch** | Per-record `gitBranch` (on git repos) | N/A | N/A | `trackedGitRepos[]` in composer headers |
| **Git commit** | Not tracked | N/A | N/A | `scored_commits.commitHash` (with AI%) |
| **CLI version** | Per-record `version` + `runtime.json.qwen_version` | N/A | N/A | VS Code version |
| **Model info** | Per-message `model` | N/A | N/A | `conversation_summaries.model` |
| **Protocol version** | None | N/A | N/A | None |
| **Session title** | Not tracked | N/A | N/A | `conversation_summaries.title` |
| **Permissions** | Not tracked | N/A | N/A | Not tracked |
| **Sandbox policy** | Not tracked | N/A | N/A | Not tracked |

**Notable additions:**
- Qwen Code has the richest per-record metadata of the JSONL-based harnesses: `version`, `gitBranch`, `cwd`, and `model` on every record
- Qwen Code's `runtime.json` additionally tracks `pid`, `hostname`, and `started_at`
- Cursor has unique git-aware code attribution: `scored_commits` tracks AI vs human contribution percentages per commit
- Cursor's `conversation_summaries` provides structured session overviews (title, TLDR, bullets)

---

## Token Usage Tracking

| Harness | Format | Key Fields |
|---------|--------|------------|
| Pi Agent | Per-message `usage` object | `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `cost` |
| Claude Code | Per-message Anthropic-style | `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `service_tier`, `cache_creation` |
| Kimi Code | Per-step `usage.record` | `inputOther`, `output`, `inputCacheRead`, `inputCacheCreation` |
| Codex | Per-event `token_count` | `total_token_usage` + `last_token_usage` with `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` |
| Qwen Code | Dual-level (per-message + per-call) | Per-message: `usageMetadata` with `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, `cachedContentTokenCount`; Per-call: `usage/token-usage-*.jsonl` with `inputTokens`, `outputTokens`, `cachedTokens`, `thoughtsTokens`, `totalTokens`, `apiDurationMs` |
| OpenCode | N/A | — |
| Devin | N/A | — |
| Cursor | Not observed locally | Cloud-side usage tracking |

**Notable:** Qwen Code has the most comprehensive usage tracking of all JSONL harnesses — dual-level (per-message in the chat stream + per-API-call in a separate file) with `thoughtsTokenCount` for reasoning tokens. Claude Code has the richest Anthropic-style cache tiers. Pi Agent is the only one that tracks cost.

---

## Sub-Agent / Multi-Agent Support

| Feature | Pi Agent | Claude Code | Kimi Code | Codex |
|---------|----------|-------------|-----------|-------|
| **Sub-agent support** | ❌ | ✅ | ✅ | ❌ |
| **Storage** | — | Separate JSONL + meta.json | Separate wire.jsonl | — |
| **Discovery** | — | `subagents/` directory | `state.json.agents` map | — |
| **Causal link** | — | `parentUuid` + `isSidechain` | `parentAgentId` in state.json | — |
| **Agent type** | — | `agentType` in meta.json, `attributionAgent` in records | Agent type in state.json | — |
| **Nesting depth** | — | `spawnDepth` in meta.json | Not tracked | — |

| Feature | Qwen Code | OpenCode | Devin | Cursor |
|---------|-----------|----------|-------|--------|
| **Sub-agent support** | ✅ (managed sub-agents) | N/A | N/A | ✅ (sub-composers) |
| **Storage** | Inline in main JSONL (as telemetry) | N/A | N/A | Cloud-synced |
| **Discovery** | `systemPayload.uiEvent.subagent_name` | N/A | N/A | `numSubComposers` in composer header |
| **Causal link** | Part of main `parentUuid` tree | N/A | N/A | Cloud-synced |
| **Agent type** | `source` field in usage records | N/A | N/A | Cloud-synced |
| **Nesting depth** | Not tracked | N/A | N/A | Not tracked |

**Notable:** Qwen Code's sub-agents are "managed" (system-managed background agents like `managed-auto-memory-extractor`) rather than user-invoked. They appear as telemetry events in the main chat stream, not as separate files. Cursor supports sub-composers but their content is cloud-synced.

---

## Additional Features

| Feature | Pi Agent | Claude Code | Kimi Code | Codex |
|---------|----------|-------------|-----------|-------|
| **Goal tracking** | ❌ | ✅ (`attachment.goal_status`) | ✅ (`CreateGoal`/`UpdateGoal` tools) | ✅ (`thread_goal_updated`) |
| **Plan mode** | ❌ | ❌ (observed) | ✅ (`plan_mode.*` events + `plans/*.md`) | ❌ (observed) |
| **Task queue** | ❌ | ✅ (`queue-operation`) | ❌ | ❌ |
| **Tool result persistence** | ❌ | ✅ (`tool-results/`) | ❌ | ❌ |
| **Permission tracking** | ❌ | ❌ (observed) | ✅ (`permission.*` events) | ✅ (`permission_profile`, `disabled`, `danger-full-access`) |
| **Context compaction** | ❌ | ❌ (observed) | ❌ (observed) | ✅ (`context_compacted`, `compacted`) |
| **Encrypted reasoning** | ❌ | ❌ | ❌ | ✅ (`encrypted_content`) |
| **Log files** | ❌ | ❌ | ✅ (`logs/kimi-code.log`) | ❌ |

| Feature | Qwen Code | OpenCode | Devin | Cursor |
|---------|-----------|----------|-------|--------|
| **Goal tracking** | ❌ | N/A | N/A | ❌ |
| **Plan mode** | ❌ | N/A | N/A | ✅ (`hasPendingPlan` in composer) |
| **Task queue** | ❌ | N/A | N/A | ❌ |
| **Tool result persistence** | ❌ | N/A | N/A | ❌ |
| **Permission tracking** | ❌ | N/A | N/A | ❌ |
| **Context compaction** | ❌ | N/A | N/A | ❌ (cloud-side) |
| **Encrypted reasoning** | ❌ | N/A | N/A | ❌ |
| **Log files** | ✅ (`tmp/<hash>/logs.json`) | N/A | N/A | ✅ (`logs/` directory) |
| **Memory (MEMORY.md)** | ❌ | ❌ | ❌ | ❌ |
| **Memory (MEMORY.md)** | ❌ | ❌ | ❌ | ❌ |

| Feature | Qwen Code | OpenCode | Devin | Cursor |
|---------|-----------|----------|-------|--------|
| **Auto-memory extraction** | ✅ (`managed-auto-memory-extractor`) | — | — | ❌ |
| **AI code attribution** | ❌ | — | — | ✅ (`ai-code-tracking.db`) |
| **Git commit AI% scoring** | ❌ | — | — | ✅ (`scored_commits`) |
| **FTS conversation search** | ❌ | — | — | ✅ (`conversation-search.db`) |
| **Cloud sync** | ❌ | — | ✅ | ✅ |
| **MCP support** | ❌ | — | — | ✅ (`mcps/` directory) |
| **Canvas SDK** | ❌ | — | — | ✅ (React-based UI rendering) |
| **Usage record JSONL** | ✅ (`usage_record.jsonl`) | — | — | ❌ |
| **Token usage by date** | ✅ (`usage/token-usage-*.jsonl`) | — | — | ❌ |

---

## Persistence Model Summary

| Harness | Local Data | Cloud Data | Primary Storage |
|---------|-----------|------------|-----------------|
| Pi Agent | Full session content | None | Local JSONL |
| Claude Code | Full session content | None | Local JSONL |
| Kimi Code | Full session content | None | Local JSONL + state.json |
| Codex | Full session content | None | Local JSONL |
| Qwen Code | Full session content | None | Local JSONL + runtime.json |
| Grok | Full session content + streaming deltas + metrics | None | Local JSONL + SQLite |
| Devin | Full session content (SQLite) + ATIF transcripts | None | Local SQLite + JSON |
| OpenCode | None | Unknown | Unknown (ephemeral or cloud) |
| Cursor | Metadata + FTS + code attribution | Full message content | Cloud-primary, local metadata |

---

## Unified Abstraction Design Implications

### Common Concepts (easy to unify)

1. **Message** — all local harnesses have user and assistant messages with content blocks
2. **Tool call** — all local harnesses have a tool call concept with name, arguments, and ID
3. **Tool result** — all local harnesses correlate tool results to calls
4. **Session identity** — all harnesses have a session ID and creation timestamp
5. **CWD** — all local harnesses track the working directory
6. **Model** — all local harnesses track which model was used

### Divergent Concepts (require adapters)

1. **Causal model** — tree (Pi, Qwen) vs graph (Claude) vs forest (Devin) vs stream (Kimi, Codex) vs none (OpenCode) vs cloud (Cursor)
2. **Sub-agent storage** — separate files (Claude, Kimi) vs inline (Qwen) vs cloud (Cursor) vs ATIF transcripts (Devin) vs none (Pi, Codex)
3. **Timestamp format** — ISO 8601 vs Unix ms/seconds; field name `timestamp` vs `time` vs `created_at`
4. **Metadata location** — inline record (Pi, Codex, Qwen) vs per-record (Claude) vs separate file (Kimi) vs SQLite (Devin, Cursor)
5. **Reasoning model** — plain text (Pi, Claude, Kimi, Qwen, Devin) vs encrypted (Codex) vs cloud (Cursor)
6. **Content format** — OpenAI `content[]` (Pi, Claude, Kimi, Codex) vs Google `parts[]` (Qwen) vs JSON `{message_id, role, content}` (Devin)
7. **Session discovery** — flat files (Pi, Claude, Qwen) vs date-partitioned (Codex) vs workspace-hash (Kimi) vs SQLite query (Devin, Cursor) vs none (OpenCode)
8. **Persistence level** — full local (Pi, Claude, Kimi, Codex, Qwen, Devin) vs metadata+cloud (Cursor) vs none (OpenCode)

### Harness Tiers

```
Tier 1 — Full Local Access:
  Pi Agent, Claude Code, Kimi Code, Codex, Qwen Code, Devin, Grok
  → All session data readable from local files

Tier 2 — Partial Local Access:
  Cursor
  → Metadata, summaries, and code attribution locally; message content cloud-only

Tier 3 — No Local Access:
  OpenCode
  → No session data stored locally; adapter returns empty results
```

### Recommended Abstraction Layers

```
┌──────────────────────────────────────────────────────────────────┐
│                         Unified API                               │
├──────────────────────────────────────────────────────────────────┤
│  SessionStore  │  MessageStore  │  AgentStore  │  UsageStore     │
├──────────────────────────────────────────────────────────────────┤
│                       Adapter Layer                               │
│  PiAdapter │ CCAdapter │ KimiAdapter │ CXAdapter │ QwenAdapter │ DevinAdapter │ GrokAdapter │
│  CursorAdapter (partial) │ OpenCodeAdapter (null) │
├──────────────────────────────────────────────────────────────────┤
│                       Raw Storage                                 │
│  ~/.pi/agent/ │ ~/.claude/ │ ~/.kimi-code/ │ ~/.codex/           │
│  ~/.qwen/     │ ~/.cursor/ + ~/Library/Application Support/Cursor/ │
│  ~/.opencode/ │ ~/.devin/ + ~/Library/Application Support/Devin/  │
└──────────────────────────────────────────────────────────────────┘
```

### Minimal Unified Record

A minimal unified record might look like:

```typescript
interface UnifiedRecord {
  // Identity
  harness: "pi" | "claude" | "kimi" | "codex" | "qwen" | "devin" | "grok" | "cursor"
  sessionId: string
  recordId: string

  // Causality
  parentId: string | null        // Pi: parentId, Claude/Qwen: parentUuid, Kimi/Codex: previous record
  branchId: string | null        // Claude: isSidechain agentId, Kimi: agent directory, Qwen: subagent_name

  // Time
  timestamp: Date                 // Normalized to Date

  // Content
  type: "session_meta" | "user_message" | "assistant_message" | "tool_call" | "tool_result" | "thinking" | "system" | "telemetry"
  role: "user" | "assistant" | "tool" | "system" | "model"  // Qwen uses "model"
  content: ContentBlock[]         // Normalized content blocks (OpenAI or Google format)

  // Metadata
  cwd: string
  model?: string
  provider?: string
  usage?: TokenUsage

  // Raw
  raw: Record<string, unknown>    // Original harness-specific record
}
```