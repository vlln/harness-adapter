# Cursor Session Storage Schema

## Overview

**Cursor** (by Anysphere) is a VS Code-based AI IDE. Session data is stored across multiple SQLite databases and key-value stores, with a mix of local metadata and cloud-synced content.

| Attribute | Value |
|-----------|-------|
| Vendor | Anysphere |
| Base Paths | `~/.cursor/` + `~/Library/Application Support/Cursor/` |
| Schema Model | SQLite relational + key-value (cloud-synced) |
| File Format | SQLite databases (`.vscdb`, `.db`) + JSON |
| Observed Version | VS Code-based (electron app) |

---

## Directory Structure

### `~/.cursor/` (user config)

```
~/.cursor/
├── .gitignore
├── argv.json
├── agents/                          # Empty (agent definitions)
├── ai-tracking/
│   └── ai-code-tracking.db          # AI code attribution & tracking
├── extensions/
│   ├── extensions.json
│   ├── anysphere.remote-containers-1.0.37/
│   └── anysphere.remote-ssh-1.1.11/
├── plugins/
└── projects/
    └── <workspace-id>/
        ├── canvases/                # Canvas SDK (React components for UI)
        │   ├── tsconfig.json
        │   └── node_modules/
        └── mcps/                    # MCP server configurations
            ├── cursor-app-control/
            │   ├── SERVER_METADATA.json
            │   └── tools/*.json
            └── cursor-ide-browser/
                ├── INSTRUCTIONS.md
                ├── SERVER_METADATA.json
                └── tools/*.json
```

### `~/Library/Application Support/Cursor/` (application data)

```
~/Library/Application Support/Cursor/
├── User/
│   ├── settings.json
│   ├── globalStorage/
│   │   ├── state.vscdb             # Global VS Code state (ItemTable + cursorDiskKV)
│   │   ├── storage.json
│   │   └── conversation-search.db  # Full-text search index for conversations
│   ├── workspaceStorage/
│   │   └── <workspace-id>/
│   │       └── state.vscdb         # Per-workspace state (ItemTable + cursorDiskKV + composerHeaders)
│   ├── History/
│   └── snippets/
├── blob_storage/<uuid>/
├── Cache/
├── CachedData/
├── CachedExtensionVSIXs/
├── Code Cache/
├── GPUCache/
├── IndexedDB/
├── Local Storage/
├── logs/
├── WebStorage/
└── Crashpad/
```

---

## Storage Layer 1: `state.vscdb` (VS Code State Database)

Cursor uses VS Code's `state.vscdb` format at two levels:

### Global (`globalStorage/state.vscdb`)

**Tables:**
- `ItemTable(key TEXT, value TEXT)` — typed key-value store
- `cursorDiskKV(key TEXT, value TEXT)` — persistent disk key-value store

Key session-related entries:

| Key | Description |
|-----|-------------|
| `composer.composerHeaders` | JSON array of all composer (chat) sessions metadata |
| `composer.composerHeaders.tableGateEnabled` | Feature flag |
| `composer.planMigrationToHomeDirCompleted` | Migration flag |
| `cursor/composerAutocompleteHeuristicsEnabled` | Feature flag |
| `cursor/composerAutocompleteHeuristicsAutoApplied` | Feature flag |
| `conversationClassificationScoredConversations` | Scored conversation list |
| `glass.cloudAgentProjects.v1` | Cloud agent projects |
| `glass.cloudAgentProjectMembership.v1` | Project memberships |
| `glass.localAgentProjects.v1` | Local agent projects |
| `glass.localAgentProjectMembership.v1` | Local project memberships |
| `glass.lastSignedInAuthId` | Auth ID |
| `glass.sharedApplicationStorage.gateEnabled` | Feature flag |
| `agentData.cacheStorage.agentEnvironment.slashMenuItems.v5.local.glass.<workspace>` | Agent slash menu items |
| `externalCliAnalytics.lastTimestamp.claude` | Last Claude CLI usage |
| `externalCliAnalytics.lastTimestamp.codex` | Last Codex CLI usage |

### Workspace (`workspaceStorage/<id>/state.vscdb`)

**Tables:**
- `ItemTable(key TEXT, value TEXT)`
- `cursorDiskKV(key TEXT, value TEXT)`
- `composerHeaders` — per-workspace composer headers (schema same as global)

---

## Storage Layer 2: Composer Session Metadata

### `composer.composerHeaders` (JSON)

```json
{
  "allComposers": [
    {
      "type": "head",
      "composerId": "c378010d-c12b-43c1-af81-f1803d3885ea",
      "createdAt": 1784563143058,
      "unifiedMode": "agent",          // "agent" | "chat" | "edit"
      "forceMode": "edit",
      "hasUnreadMessages": false,
      "totalLinesAdded": 0,
      "totalLinesRemoved": 0,
      "hasBlockingPendingActions": false,
      "hasPendingPlan": false,
      "isArchived": false,
      "isDraft": false,
      "isEphemeral": true,
      "isWorktree": false,
      "worktreeStartedReadOnly": false,
      "isSpec": false,
      "isProject": false,
      "isBestOfNSubcomposer": false,
      "numSubComposers": 0,
      "referencedPlans": [],
      "trackedGitRepos": [],
      "workspaceIdentifier": {
        "id": "empty-window"
      }
    }
  ]
}
```

Key fields:
- `composerId` — UUIDv4 session identifier
- `unifiedMode` — `"agent"` (agent mode), `"chat"` (chat mode), or `"edit"` (edit mode)
- `forceMode` — forced mode override (e.g., `"edit"`)
- `type` — `"head"` for main composers, sub-composers have other types
- `isArchived` — whether the session is archived
- `isDraft` — whether it's a draft (never sent)
- `isEphemeral` — auto-cleaned sessions
- `hasPendingPlan` — whether plan mode is active
- `isBestOfNSubcomposer` — whether it's a "best of N" variant
- `numSubComposers` — number of sub-composer branches
- `referencedPlans` — array of referenced plan IDs
- `totalLinesAdded` / `totalLinesRemoved` — cumulative code changes
- `trackedGitRepos` — git repositories involved

**Note:** The actual message content is NOT stored in `composerHeaders`. Cursor syncs full message content to the cloud and caches it locally. The `composerHeaders` only stores metadata.

---

## Storage Layer 3: `conversation-search.db` (FTS Index)

```sql
CREATE TABLE conversations (
  fts_rowid INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('local', 'cloud-cache')),
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  is_archived INTEGER NOT NULL,
  root_fingerprint TEXT,
  cache_fingerprint TEXT,
  UNIQUE(source, scope, id)
);

CREATE VIRTUAL TABLE conversation_fts USING fts5(
  title, body,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TABLE conversation_search_candidates (
  id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);

CREATE TABLE conversation_search_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  effective_conversation_cap INTEGER NOT NULL
);
```

This provides full-text search over conversations. The `body` in `conversation_fts` contains the searchable message content. The `source` field distinguishes:
- `"local"` — conversations created locally
- `"cloud-cache"` — conversations synced from cloud, cached locally

---

## Storage Layer 4: `ai-code-tracking.db` (AI Code Attribution)

```sql
CREATE TABLE ai_code_hashes (
  hash TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  fileExtension TEXT,
  fileName TEXT,
  requestId TEXT,
  conversationId TEXT,
  timestamp INTEGER,
  model TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE scored_commits (
  commitHash TEXT NOT NULL,
  branchName TEXT NOT NULL,
  scoredAt INTEGER NOT NULL,
  linesAdded INTEGER, linesDeleted INTEGER,
  tabLinesAdded INTEGER, tabLinesDeleted INTEGER,
  composerLinesAdded INTEGER, composerLinesDeleted INTEGER,
  humanLinesAdded INTEGER, humanLinesDeleted INTEGER,
  blankLinesAdded INTEGER, blankLinesDeleted INTEGER,
  commitMessage TEXT,
  commitDate TEXT,
  v1AiPercentage TEXT,
  v2AiPercentage TEXT,
  PRIMARY KEY (commitHash, branchName)
);

CREATE TABLE conversation_summaries (
  conversationId TEXT PRIMARY KEY,
  title TEXT,
  tldr TEXT,
  overview TEXT,
  summaryBullets TEXT,
  model TEXT,
  mode TEXT,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE tracked_file_content (
  gitPath TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  conversationId TEXT,
  model TEXT,
  fileExtension TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE ai_deleted_files (
  gitPath TEXT NOT NULL,
  composerId TEXT,
  conversationId TEXT,
  model TEXT,
  deletedAt INTEGER NOT NULL,
  PRIMARY KEY (gitPath, deletedAt)
);

CREATE TABLE tracking_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

This database tracks:
- **`ai_code_hashes`** — content hashes of AI-generated code, linked to `conversationId` and `requestId`
- **`scored_commits`** — git commit analysis: how much was AI-generated vs human-written
- **`conversation_summaries`** — title, TLDR, overview, and bullet summaries of conversations
- **`tracked_file_content`** — snapshots of AI-generated files
- **`ai_deleted_files`** — audit trail of AI-deleted files
- **`tracking_state`** — `trackingStartTime` timestamp

---

## Storage Layer 5: Glass/Agent Tabs

### `cursor/glass.tabs.v2/<workspace>/state.json`

```json
{
  "version": 1,
  "stableTabs": [],
  "workspaceTabs": [
    {
      "id": "stable-diff",
      "kind": "diff",
      "props": {},
      "closable": true,
      "label": "Changes",
      "lastActiveTime": 1784563166435,
      "groupId": "editor-panel-group"
    }
  ],
  "activeTarget": {
    "scope": "workspace",
    "tabId": "stable-diff"
  },
  "browserSessions": []
}
```

---

## Message Content Model

Message content in Cursor is **not stored in plain files** — it's synced to Anysphere's cloud and cached in the VS Code state database. The storage format is internal to Cursor and not directly accessible as JSONL.

What IS available locally:

| Data | Location |
|------|----------|
| Session metadata | `composer.composerHeaders` |
| Session title | `conversation-summaries.title` |
| Session summary | `conversation-summaries.overview`, `conversation-summaries.summaryBullets` |
| Searchable body | `conversation_fts.body` (FTS index) |
| AI code attribution | `ai_code_hashes` |
| Git commit analysis | `scored_commits` |
| File snapshots | `tracked_file_content` |

---

## Additional Features

| Feature | Support |
|---------|---------|
| Plan mode | ✅ `hasPendingPlan` in composer headers |
| Sub-composers | ✅ `numSubComposers`, `isBestOfNSubcomposer` |
| Agent mode | ✅ `unifiedMode: "agent"` |
| Chat mode | ✅ `unifiedMode: "chat"` |
| Edit mode | ✅ `unifiedMode: "edit"` / `forceMode: "edit"` |
| Cloud sync | ✅ All sessions synced to Anysphere cloud |
| FTS search | ✅ `conversation_fts` with FTS5 |
| AI code tracking | ✅ `ai-code-tracking.db` with hashes, commits, summaries |
| Git-aware | ✅ Branch tracking, commit scoring |
| MCP support | ✅ `projects/<id>/mcps/` with tool definitions |
| Canvas SDK | ✅ React-based UI components for rendered output |
| Memory | ❌ No MEMORY.md equivalent |
| Goal tracking | ❌ Not observed |
| Context compaction | ❌ Not observed (cloud-side) |

---

## Key Design Characteristics

1. **Cloud-primary** — message content is stored in Anysphere's cloud, not locally
2. **SQLite-based** — all local storage uses SQLite, not flat files
3. **Rich metadata locally** — session headers, summaries, code attribution available offline
4. **VS Code infrastructure** — uses standard VS Code `state.vscdb` format
5. **Multi-mode** — agent, chat, and edit modes in the same session system
6. **Git-integrated** — tracks AI vs human contributions at the commit level
7. **FTS-enabled** — full-text search index for conversation content

---

## Implications for Unified Abstraction

Cursor is a **hybrid local/cloud harness**:

- **Available locally:** Session metadata, summaries, code attribution, FTS index
- **Not available locally:** Full message content (requires cloud API or sync)

For a unified abstraction:
- Session listing and metadata queries work from local data
- Message content reading requires either cloud API access or Cursor's internal deserialization
- The `conversation_fts` table provides a searchable body of message content
- `conversation_summaries` provides structured overviews even without full messages
- Code attribution data (`ai-code-tracking.db`) is a unique feature not found in other harnesses