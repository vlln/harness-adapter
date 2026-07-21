# OpenCode Session Storage Schema

## Overview

**OpenCode** (`@opencode-ai/plugin`) is a lightweight coding agent CLI. It stores **no persistent session data** locally. The `~/.opencode/` directory contains only the tool binary and its runtime dependencies.

| Attribute | Value |
|-----------|-------|
| Vendor | OpenCode AI |
| Base Path | `~/.opencode/` |
| Schema Model | N/A — no persistent sessions |
| File Format | N/A |
| Observed Version | `1.17.9` (plugin) |

---

## Directory Structure

```
~/.opencode/
├── .gitignore           # node_modules
├── package.json         # {"dependencies": {"@opencode-ai/plugin": "1.17.9"}}
├── package-lock.json
├── bun.lock             # Bun lockfile (Bun runtime)
└── bin/
    └── opencode         # Binary executable
```

That's it. No `sessions/`, no `projects/`, no `chats/`, no SQLite databases.

---

## Analysis

### What It Is

OpenCode is a **Bun-based Node.js package** (`@opencode-ai/plugin`) installed as a CLI tool. The `~/.opencode/` directory is essentially a `node_modules`-style installation, not a data directory.

### Where Sessions Go

Since no session data was found in `~/.opencode/`, `~/Library/Application Support/`, or `/tmp/`, the sessions are either:

1. **Ephemeral** — sessions exist only in memory during the CLI process lifetime
2. **Cloud-stored** — sessions are persisted on OpenCode's servers, not locally
3. **Stored elsewhere** — sessions may be stored in a project-local `.opencode/` directory (not observed in sample data)

### Package Structure

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.17.9"
  }
}
```

The tool uses Bun as its runtime (evidenced by `bun.lock`).

---

## Key Design Characteristics

1. **No local persistence** — zero session data stored on disk
2. **Minimal installation** — only the binary and its runtime
3. **Bun runtime** — uses Bun instead of Node.js
4. **Plugin architecture** — the core is `@opencode-ai/plugin`, suggesting the CLI is a thin wrapper

---

## Implications for Unified Abstraction

OpenCode is the **simplest case** for a harness adapter — it has nothing to read. The adapter would:

- Return an empty session list
- Not support session history queries
- Only be useful if/when OpenCode adds local persistence

For a unified abstraction, OpenCode can be treated as a **null adapter** that returns empty results for all queries.