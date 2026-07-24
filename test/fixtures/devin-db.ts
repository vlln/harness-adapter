/**
 * Programmatic SQLite fixture for the Devin adapter (AC-0003 layer-3 input).
 *
 * ALL DATA IS SYNTHETIC — hand-crafted below, never copied from a real
 * Devin installation. The schema mirrors docs/research/schemas/devin-schema.md
 * (sessions + message_nodes; the other tables exist but are unused by the
 * adapter and therefore not created here).
 *
 * Fixture shape (ADR-0005 linear sessions; see devin-adapter.test.ts for what
 * each element exercises). Branch shapes mirror the observed real-data
 * patterns: twin child nodes carrying the same assistant message_id, and
 * cross-root shared system prefixes.
 *
 *   sunny-forest    main_chain_id = 18 (the base tree's TIP — real data:
 *                   main_chain_id always points at a tip, not a root)
 *     base tree (root 0) → AHS session "sunny-forest":
 *       system → user → [TWIN BRANCH: nodes 2/3 both carry m-asst-2; node 2
 *       is a dead end — no fork session] → tool result → assistant
 *       (tool-only, metrics ride on the tool_call) → tool result → [dup
 *       result node 7, skipped] → assistant(text + dangling tool_call →
 *       interrupted) → unknown-role node (skipped) → user → malformed JSON
 *       node (skipped) → user → empty assistant (skipped) → user with
 *       is_user_input=false → harness_message → [REAL FORK: nodes 15/16
 *       both carry m-asst-15 (text + tool_call tc-4) and BOTH continue;
 *       node 15's subtree holds the last leaf so it stays main; node 16 →
 *       "sunny-forest#fork-16" anchored at m-asst-15/tool_call/0
 *       (rewound_from); the fork's tool_result for tc-4 is ancestor-orphaned
 *       → dropped; suffix = user + assistant]
 *     root 30 (dangling parent 99 — deleted-parent gap): shares nothing →
 *       anchor-less rewound_from → "sunny-forest#root-30"
 *     root 40: leading copy of m-sys-0 → anchored at the harness_message
 *       m-sys-0 (rewound_from — the real-data cross-root anchor role) →
 *       "sunny-forest#root-40", suffix user + assistant
 *     root 50: leading copies of m-sys-0 + m-user-1 → anchored at the
 *       user_message m-user-1 (rewound_from) → "sunny-forest#root-50",
 *       suffix = one assistant re-answer
 *   quiet-pond      minimal: no metrics, no title, metadata NULL,
 *                   main_chain_id NULL (HEAD fallback: latest record)
 *   odd-cove        invalid metadata JSON, main_chain_id 999 (unresolvable),
 *                   node without message_id (recordId falls back to node-<id>)
 *   hidden-one      hidden = 1 → never listed
 *   cycle-gone      two nodes parenting each other → no roots → not listed
 *
 * AC-0002-B-4: createDevinFixture takes an optional sunnyMainChainId —
 * flipping it (18 = base tip → 42 = root-40 tip) must leave the session set
 * byte-identical and move only the HEAD yielded by default listSessions.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const T0 = 1752000000; // sunny-forest created_at (unix seconds)

/** Base-tree tip node (default winner) and root-40 tip node (flipped winner). */
export const BASE_TIP_NODE = 18;
export const ROOT40_TIP_NODE = 42;

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

function sessions(sunnyMainChainId: number): FixtureSession[] {
  return [
    {
      id: "sunny-forest",
      workingDirectory: "/work/alpha",
      model: "claude-test-medium",
      createdAt: T0,
      lastActivityAt: T0 + 3600,
      title: "Alpha Refactor",
      mainChainId: sunnyMainChainId,
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
}

const NODES: Record<string, FixtureNode[]> = {
  "sunny-forest": [
    // Base tree (root 0) → bare-slug session.
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
    // TWIN BRANCH (the dominant real-data shape): nodes 2 and 3 carry the
    // same assistant message; node 2 is a dead end → no fork session.
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
      createdAt: T0 + 21,
    },
    {
      nodeId: 4,
      parentNodeId: 3,
      message: { message_id: "m-tool-4", role: "tool", tool_call_id: "tc-1", content: "file contents here" },
      createdAt: T0 + 30,
    },
    {
      nodeId: 5,
      parentNodeId: 4,
      message: {
        message_id: "m-asst-5",
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
      nodeId: 6,
      parentNodeId: 5,
      message: { message_id: "m-tool-6", role: "tool", tool_call_id: "tc-2", content: "ok" },
      createdAt: T0 + 50,
    },
    // Duplicate result for tc-2 on the same chain: first in chain order wins.
    {
      nodeId: 7,
      parentNodeId: 6,
      message: { message_id: "m-tool-7", role: "tool", tool_call_id: "tc-2", content: "ok duplicate" },
      createdAt: T0 + 60,
    },
    // Dangling tool_call (no result) → interrupted.
    {
      nodeId: 8,
      parentNodeId: 7,
      message: {
        message_id: "m-asst-8",
        role: "assistant",
        content: "One more try.",
        tool_calls: [{ id: "tc-3", name: "run_shell", arguments: { cmd: "ls" }, index: 0 }],
      },
      createdAt: T0 + 70,
    },
    // Unknown role → skipped; the chain continues through it.
    {
      nodeId: 9,
      parentNodeId: 8,
      message: { message_id: "m-unk-9", role: "telemetry", content: "{\"cpu\": 0.1}" },
      createdAt: T0 + 80,
    },
    {
      nodeId: 10,
      parentNodeId: 9,
      message: { message_id: "m-user-10", role: "user", content: "continue" },
      createdAt: T0 + 90,
    },
    // Malformed chat_message JSON → skipped; the chain continues through it.
    { nodeId: 11, parentNodeId: 10, rawMessage: "not-json{{", createdAt: T0 + 100 },
    {
      nodeId: 12,
      parentNodeId: 11,
      message: { message_id: "m-user-12", role: "user", content: "again" },
      createdAt: T0 + 110,
    },
    // Empty assistant (no blocks, no tool calls) → skipped entirely.
    {
      nodeId: 13,
      parentNodeId: 12,
      message: { message_id: "m-asst-13", role: "assistant", content: "" },
      createdAt: T0 + 120,
    },
    // Harness impersonating the user → harness_message.
    {
      nodeId: 14,
      parentNodeId: 13,
      message: {
        message_id: "m-harness-14",
        role: "user",
        content: "<system-reminder>tick</system-reminder>",
        metadata: { is_user_input: false },
      },
      createdAt: T0 + 130,
    },
    // REAL FORK: nodes 15 and 16 are twins (same assistant message, text +
    // tool_call tc-4) and BOTH continue. Node 15's subtree holds the last
    // leaf (node 18) → stays main; node 16 → fork session.
    {
      nodeId: 15,
      parentNodeId: 14,
      message: {
        message_id: "m-asst-15",
        role: "assistant",
        content: "Final answer.",
        tool_calls: [{ id: "tc-4", name: "run_shell", arguments: { cmd: "make test" }, index: 0 }],
      },
      createdAt: T0 + 140,
    },
    {
      nodeId: 16,
      parentNodeId: 14,
      message: {
        message_id: "m-asst-15",
        role: "assistant",
        content: "Final answer.",
        tool_calls: [{ id: "tc-4", name: "run_shell", arguments: { cmd: "make test" }, index: 0 }],
      },
      createdAt: T0 + 141,
    },
    {
      nodeId: 17,
      parentNodeId: 15,
      message: { message_id: "m-tool-17", role: "tool", tool_call_id: "tc-4", content: "main result" },
      createdAt: T0 + 150,
    },
    {
      nodeId: 18,
      parentNodeId: 17,
      message: { message_id: "m-user-18", role: "user", content: "next" },
      createdAt: T0 + 160,
    },
    // Fork branch: the tc-4 result is ancestor-orphaned → dropped in the
    // fork session; suffix = user + assistant.
    {
      nodeId: 19,
      parentNodeId: 16,
      message: { message_id: "m-tool-19", role: "tool", tool_call_id: "tc-4", content: "fork result" },
      createdAt: T0 + 151,
    },
    {
      nodeId: 20,
      parentNodeId: 19,
      message: { message_id: "m-user-20", role: "user", content: "fork direction" },
      createdAt: T0 + 152,
    },
    {
      nodeId: 21,
      parentNodeId: 20,
      message: { message_id: "m-asst-21", role: "assistant", content: "Fork answer." },
      createdAt: T0 + 153,
    },
    // Deleted-parent gap (parent 99 missing) → additional root; shares no
    // message with the base tree → anchor-less rewound_from.
    {
      nodeId: 30,
      parentNodeId: 99,
      message: { message_id: "m-sys-30", role: "system", content: "Orphaned context." },
      createdAt: T0 + 200,
    },
    // Root sharing only the system prompt (the real-data cross-root shape)
    // → rewound_from anchored at harness_message m-sys-0.
    {
      nodeId: 40,
      parentNodeId: null,
      message: { message_id: "m-sys-0", role: "system", content: "You are Devin (test system prompt)." },
      createdAt: T0 + 300,
    },
    {
      nodeId: 41,
      parentNodeId: 40,
      message: { message_id: "m-user-41", role: "user", content: "Try differently." },
      createdAt: T0 + 310,
    },
    {
      nodeId: 42,
      parentNodeId: 41,
      message: { message_id: "m-asst-42", role: "assistant", content: "Alternative exploration." },
      createdAt: T0 + 320,
    },
    // Root sharing [system, user] prefix → rewound_from anchored at
    // user_message m-user-1 (a re-answer to the same prompt).
    {
      nodeId: 50,
      parentNodeId: null,
      message: { message_id: "m-sys-0", role: "system", content: "You are Devin (test system prompt)." },
      createdAt: T0 + 400,
    },
    {
      nodeId: 51,
      parentNodeId: 50,
      message: { message_id: "m-user-1", role: "user", content: "Refactor the parser.", metadata: { is_user_input: true } },
      createdAt: T0 + 401,
    },
    {
      nodeId: 52,
      parentNodeId: 51,
      message: { message_id: "m-asst-52", role: "assistant", content: "Different answer to the same prompt." },
      createdAt: T0 + 402,
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
 * `sunnyMainChainId` flips the winner for AC-0002-B-4 (default: base tip).
 */
export function createDevinFixture(dir: string, sunnyMainChainId = BASE_TIP_NODE): string {
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
    for (const s of sessions(sunnyMainChainId)) {
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
