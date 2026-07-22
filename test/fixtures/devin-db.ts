/**
 * Programmatic SQLite fixture for the Devin adapter (AC-0003 layer-3 input).
 *
 * ALL DATA IS SYNTHETIC — hand-crafted below, never copied from a real
 * Devin installation. The schema mirrors docs/research/schemas/devin-schema.md
 * (sessions + message_nodes; the other tables exist but are unused by the
 * adapter and therefore not created here).
 *
 * Fixture shape (see devin-adapter.test.ts for what each element exercises):
 *
 *   sunny-forest    main_chain_id = 5 (a TIP, not a root — research doc erratum)
 *     ├─ root 0  system → user → assistant(thinking+text+tool_call+metrics)
 *     │          → tool result → assistant(tool-only, metrics ride on the
 *     │            tool_call) → tool result → [dup result, skipped]
 *     │          → assistant(text + dangling tool_call → interrupted)
 *     │            → unknown-role node (skipped) → user (re-anchored)
 *     │            → malformed JSON node (skipped) → user (re-anchored)
 *     │            → empty assistant (skipped)
 *     │            → user with is_user_input=false → harness_message
 *     │          └─ branch-retry DUPLICATE of m-user-1 (skipped) → its
 *     │            assistant reply re-anchors to the first occurrence
 *     ├─ root 20 (dangling parent 99 — deleted-parent gap) → sibling
 *     └─ root 30 system → user → sibling
 *   quiet-pond      minimal: no metrics, no title, metadata NULL,
 *                   main_chain_id NULL (fallback: lowest root)
 *   odd-cove        invalid metadata JSON, main_chain_id 999 (unresolvable),
 *                   node without message_id (recordId falls back to node-<id>)
 *   hidden-one      hidden = 1 → never listed
 *   cycle-gone      two nodes parenting each other → no roots → not listed
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const T0 = 1752000000; // sunny-forest created_at (unix seconds)

interface FixtureSession {
  id: string;
  workingDirectory: string;
  model: string;
  createdAt: number;
  lastActivityAt: number;
  title: string | null;
  mainChainId: number | null;
  hidden?: boolean;
  metadata: string | null;
}

interface FixtureNode {
  nodeId: number;
  parentNodeId: number | null;
  /** Structured chat_message (JSON-serialized) ... */
  message?: Record<string, unknown>;
  /** ... or a raw chat_message payload (for the malformed-JSON case). */
  rawMessage?: string;
  createdAt: number;
}

const SESSIONS: FixtureSession[] = [
  {
    id: "sunny-forest",
    workingDirectory: "/work/alpha",
    model: "claude-test-medium",
    createdAt: T0,
    lastActivityAt: T0 + 3600,
    title: "Alpha Refactor",
    mainChainId: 5,
    metadata: JSON.stringify({ total_credit_cost: 7, total_acu_cost: 0.0 }),
  },
  {
    id: "quiet-pond",
    workingDirectory: "/work/beta",
    model: "devin-mini",
    createdAt: T0 + 100000,
    lastActivityAt: T0 + 100000,
    title: null,
    mainChainId: null,
    metadata: null,
  },
  {
    id: "odd-cove",
    workingDirectory: "/work/gamma",
    model: "devin-mini",
    createdAt: T0 + 200000,
    lastActivityAt: T0 + 200060,
    title: null,
    mainChainId: 999,
    metadata: "not-json{{",
  },
  {
    id: "hidden-one",
    workingDirectory: "/work/hidden",
    model: "devin-mini",
    createdAt: T0 + 300000,
    lastActivityAt: T0 + 300000,
    title: null,
    mainChainId: null,
    hidden: true,
    metadata: null,
  },
  {
    id: "cycle-gone",
    workingDirectory: "/work/cycle",
    model: "devin-mini",
    createdAt: T0 + 400000,
    lastActivityAt: T0 + 400000,
    title: null,
    mainChainId: null,
    metadata: null,
  },
];

const NODES: Record<string, FixtureNode[]> = {
  "sunny-forest": [
    // Main tree (root 0).
    {
      nodeId: 0,
      parentNodeId: null,
      message: { message_id: "m-sys-0", role: "system", content: "You are Devin (test system prompt)." },
      createdAt: T0,
    },
    {
      nodeId: 1,
      parentNodeId: 0,
      message: { message_id: "m-user-1", role: "user", content: "Refactor the parser.", metadata: { is_user_input: true } },
      createdAt: T0 + 10,
    },
    {
      nodeId: 2,
      parentNodeId: 1,
      message: {
        message_id: "m-asst-2",
        role: "assistant",
        content: "I'll inspect the file.",
        thinking: { thinking: "Let me think." },
        tool_calls: [
          { id: "tc-1", name: "read_file", arguments: { path: "/work/alpha/a.ts" }, index: 0, kind: "read" },
        ],
        metadata: {
          metrics: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: null,
            cache_creation_tokens: 177,
            total_time_ms: 1500,
          },
        },
      },
      createdAt: T0 + 20,
    },
    {
      nodeId: 3,
      parentNodeId: 2,
      message: { message_id: "m-tool-3", role: "tool", tool_call_id: "tc-1", content: "file contents here" },
      createdAt: T0 + 30,
    },
    {
      nodeId: 4,
      parentNodeId: 3,
      message: {
        message_id: "m-asst-4",
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "tc-2", name: "write_file", arguments: { path: "/work/alpha/a.ts", text: "new" }, index: 0 },
        ],
        metadata: { metrics: { input_tokens: 50, output_tokens: 10, total_time_ms: 800 } },
      },
      createdAt: T0 + 40,
    },
    {
      nodeId: 5,
      parentNodeId: 4,
      message: { message_id: "m-tool-5", role: "tool", tool_call_id: "tc-2", content: "ok" },
      createdAt: T0 + 50,
    },
    // Duplicate result for tc-2: first in DFS order wins, this one is skipped.
    {
      nodeId: 8,
      parentNodeId: 5,
      message: { message_id: "m-tool-8", role: "tool", tool_call_id: "tc-2", content: "ok duplicate" },
      createdAt: T0 + 80,
    },
    // Dangling tool_call (no result) → interrupted.
    {
      nodeId: 9,
      parentNodeId: 5,
      message: {
        message_id: "m-asst-9",
        role: "assistant",
        content: "One more try.",
        tool_calls: [{ id: "tc-3", name: "run_shell", arguments: { cmd: "ls" }, index: 0 }],
      },
      createdAt: T0 + 90,
    },
    // Unknown role → skipped; child re-anchors to node's last emitted record.
    {
      nodeId: 10,
      parentNodeId: 9,
      message: { message_id: "m-unk-10", role: "telemetry", content: "{\"cpu\": 0.1}" },
      createdAt: T0 + 100,
    },
    {
      nodeId: 11,
      parentNodeId: 10,
      message: { message_id: "m-user-11", role: "user", content: "continue" },
      createdAt: T0 + 110,
    },
    // Malformed chat_message JSON → skipped; child re-anchors.
    { nodeId: 12, parentNodeId: 11, rawMessage: "not-json{{", createdAt: T0 + 120 },
    {
      nodeId: 13,
      parentNodeId: 12,
      message: { message_id: "m-user-13", role: "user", content: "again" },
      createdAt: T0 + 130,
    },
    // Empty assistant (no blocks, no tool calls) → skipped entirely.
    {
      nodeId: 14,
      parentNodeId: 13,
      message: { message_id: "m-asst-14", role: "assistant", content: "" },
      createdAt: T0 + 140,
    },
    // Harness impersonating the user → harness_message.
    {
      nodeId: 15,
      parentNodeId: 13,
      message: {
        message_id: "m-harness-15",
        role: "user",
        content: "<system-reminder>tick</system-reminder>",
        metadata: { is_user_input: false },
      },
      createdAt: T0 + 150,
    },
    // Branch-retry duplicate of m-user-1 → skipped; its reply re-anchors.
    {
      nodeId: 6,
      parentNodeId: 1,
      message: { message_id: "m-user-1", role: "user", content: "Refactor the parser." },
      createdAt: T0 + 60,
    },
    {
      nodeId: 7,
      parentNodeId: 6,
      message: { message_id: "m-asst-7", role: "assistant", content: "Alternative attempt." },
      createdAt: T0 + 70,
    },
    // Deleted-parent gap (parent 99 missing) → additional root → sibling.
    {
      nodeId: 20,
      parentNodeId: 99,
      message: { message_id: "m-sys-20", role: "system", content: "Orphaned context." },
      createdAt: T0 + 200,
    },
    // Independent second root → sibling.
    {
      nodeId: 30,
      parentNodeId: null,
      message: { message_id: "m-sys-30", role: "system", content: "Second context." },
      createdAt: T0 + 300,
    },
    {
      nodeId: 31,
      parentNodeId: 30,
      message: { message_id: "m-user-31", role: "user", content: "Try differently." },
      createdAt: T0 + 310,
    },
  ],
  "quiet-pond": [
    {
      nodeId: 0,
      parentNodeId: null,
      message: { message_id: "m-q-0", role: "user", content: "hello" },
      createdAt: T0 + 100000,
    },
  ],
  "odd-cove": [
    {
      nodeId: 0,
      parentNodeId: null,
      message: { role: "user", content: "no message id here" },
      createdAt: T0 + 200000,
    },
  ],
  "hidden-one": [
    {
      nodeId: 0,
      parentNodeId: null,
      message: { message_id: "m-h-0", role: "user", content: "hidden" },
      createdAt: T0 + 300000,
    },
  ],
  // Two nodes parenting each other: no root → the session is not listed.
  "cycle-gone": [
    {
      nodeId: 0,
      parentNodeId: 1,
      message: { message_id: "m-c-0", role: "user", content: "cycle a" },
      createdAt: T0 + 400000,
    },
    {
      nodeId: 1,
      parentNodeId: 0,
      message: { message_id: "m-c-1", role: "user", content: "cycle b" },
      createdAt: T0 + 400010,
    },
  ],
};

/**
 * Create the synthetic sessions.db under `dir` and return its path.
 * The database is written with plain DDL/DML (no WAL), then closed.
 */
export function createDevinFixture(dir: string): string {
  const dbPath = path.join(dir, "sessions.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        working_directory TEXT NOT NULL,
        backend_type TEXT NOT NULL,
        model TEXT NOT NULL,
        agent_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        title TEXT,
        main_chain_id INTEGER,
        shell_last_seen_index INTEGER DEFAULT 0,
        cogs_json TEXT,
        workspace_dirs TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        metadata TEXT
      );
      CREATE TABLE message_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        parent_node_id INTEGER,
        chat_message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT,
        UNIQUE(session_id, node_id)
      );
    `);
    const insertSession = db.prepare(
      `INSERT INTO sessions
         (id, working_directory, backend_type, model, agent_mode, created_at,
          last_activity_at, title, main_chain_id, hidden, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of SESSIONS) {
      insertSession.run(
        s.id,
        s.workingDirectory,
        "Windsurf",
        s.model,
        "normal",
        s.createdAt,
        s.lastActivityAt,
        s.title,
        s.mainChainId,
        s.hidden === true ? 1 : 0,
        s.metadata,
      );
    }
    const insertNode = db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [sessionId, nodes] of Object.entries(NODES)) {
      for (const n of nodes) {
        insertNode.run(
          sessionId,
          n.nodeId,
          n.parentNodeId,
          n.rawMessage ?? JSON.stringify(n.message),
          n.createdAt,
        );
      }
    }
  } finally {
    db.close();
  }
  return dbPath;
}
