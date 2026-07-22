import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { DevinAdapter } from "../src/adapters/devin/index";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import {
  checkIdempotency,
  collectSessions,
  validateSessions,
} from "../src/validate/index";

const SIBLING_ID = "test-forest#root-10";

/** Build a tiny sessions.db fixture (created programmatically — no binary fixtures). */
function createFixtureDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
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
  const insSession = db.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode,
       created_at, last_activity_at, title, main_chain_id, hidden, metadata)
     VALUES (?, ?, 'Windsurf', ?, 'normal', ?, ?, ?, ?, 0, ?)`,
  );
  const insNode = db.prepare(
    `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const msg = (m: unknown): string => JSON.stringify(m);

  // Session 1: a forest — winning chain (main_chain_id points at the TIP,
  // a non-root node, as in real data) + one sibling root. Includes a
  // branch-retry duplicate (nodes 2 and 4 share message m-2) whose child
  // (node 5) must re-anchor to the first occurrence.
  insSession.run(
    "test-forest",
    "/home/test/forest",
    "claude-test-1",
    1784500000,
    1784503600,
    "森林会话",
    3,
    JSON.stringify({ total_credit_cost: 12.5, total_acu_cost: 3.0 }),
  );
  const forest = "test-forest";
  insNode.run(forest, 0, null, msg({ message_id: "m-0", role: "system", content: "你是 Devin。" }), 1784500001);
  insNode.run(forest, 1, 0, msg({ message_id: "m-1", role: "user", content: "修复 bug", metadata: { is_user_input: true } }), 1784500002);
  insNode.run(forest, 2, 1, msg({
    message_id: "m-2",
    role: "assistant",
    content: "我来查看。",
    thinking: { thinking: "先想一下。" },
    tool_calls: [{ id: "tc-1", name: "read", arguments: { file_path: "/a.ts" }, index: 0, kind: "function" }],
    metadata: { metrics: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, total_time_ms: 500, ttft_ms: 50 } },
  }), 1784500003);
  insNode.run(forest, 3, 2, msg({ message_id: "m-3", role: "tool", content: "file content here", tool_call_id: "tc-1" }), 1784500004);
  // Branch-retry duplicate of m-2 (same message_id, sibling node), with a child.
  insNode.run(forest, 4, 1, msg({
    message_id: "m-2",
    role: "assistant",
    content: "我来查看。",
    thinking: { thinking: "先想一下。" },
    tool_calls: [{ id: "tc-1", name: "read", arguments: { file_path: "/a.ts" }, index: 0, kind: "function" }],
  }), 1784500003);
  insNode.run(forest, 5, 4, msg({ message_id: "m-5", role: "assistant", content: "另一个分支的回复。" }), 1784500005);
  // Sibling root (competing exploration branch).
  insNode.run(forest, 10, null, msg({ message_id: "m-10", role: "user", content: "另一条探索：直接重写模块" }), 1784500006);
  insNode.run(forest, 11, 10, msg({ message_id: "m-11", role: "assistant", content: "好的，我来重写。" }), 1784500007);

  // Session 2: single root; tool-only assistant message (usage rides on the
  // first tool_call); one of two tool calls left dangling → interrupted.
  insSession.run(
    "test-single",
    "/home/test/single",
    "swe-1-6-slow",
    1784510000,
    1784510000,
    null,
    1,
    JSON.stringify({ total_credit_cost: 0, total_acu_cost: 0.0 }),
  );
  const single = "test-single";
  insNode.run(single, 0, null, msg({ message_id: "m-s0", role: "user", content: "跑个测试" }), 1784510001);
  insNode.run(single, 1, 0, msg({
    message_id: "m-s1",
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "tc-a", name: "shell", arguments: { command: "ls" }, index: 0, kind: "function" },
      { id: "tc-b", name: "read", arguments: { file_path: "/b.ts" }, index: 1, kind: "function" },
    ],
    metadata: { metrics: { input_tokens: 40, output_tokens: 6, cache_read_tokens: null, total_time_ms: 200 } },
  }), 1784510002);
  insNode.run(single, 2, 1, msg({ message_id: "m-s2", role: "tool", content: "ok", tool_call_id: "tc-a" }), 1784510003);

  db.close();
}

const tmp = mkdtempSync(path.join(tmpdir(), "devin-adapter-test-"));
const dbPath = path.join(tmp, "sessions.db");
createFixtureDb(dbPath);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function readAll(adapter: DevinAdapter, sessionId: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId)) records.push(rec);
  return records;
}

describe("devin adapter", () => {
  const adapter = new DevinAdapter(dbPath);

  it("declares harness + capabilities", () => {
    expect(adapter.harness).toBe("devin");
    expect(adapter.capabilities).toEqual({ history: "full", control: false });
  });

  it("layer 1 (AC-0001): every manifest and record passes the zod schemas", async () => {
    const sessions = await collectSessions(adapter);
    expect(sessions.length).toBeGreaterThan(0);
    for (const { manifest, records } of sessions) {
      expect(() => ManifestSchema.parse(manifest)).not.toThrow();
      for (const rec of records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
      }
    }
  });

  it("layer 2 (AC-0002): all semantic invariants hold on all fixtures", async () => {
    const sessions = await collectSessions(adapter);
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("layer 2 (AC-0002-N-5): idempotent — two runs are byte-identical", async () => {
    expect(await checkIdempotency(adapter)).toEqual([]);
  });

  it("forest → multi-session: main chain + sibling_attempt, isMainChain on exactly one", async () => {
    const sessions = await collectSessions(adapter);
    const ids = sessions.map((s) => s.manifest.sessionId).sort();
    expect(ids).toEqual([SIBLING_ID, "test-forest", "test-single"].sort());

    const main = sessions.find((s) => s.manifest.sessionId === "test-forest")!.manifest;
    expect(main.isMainChain).toBe(true);
    expect(main.relation).toBeUndefined();

    const sibling = sessions.find((s) => s.manifest.sessionId === SIBLING_ID)!.manifest;
    expect(sibling.isMainChain).toBeUndefined();
    expect(sibling.relation).toEqual({ type: "sibling_attempt", sessionId: "test-forest" });

    // Single-root session is its own main chain.
    const single = sessions.find((s) => s.manifest.sessionId === "test-single")!.manifest;
    expect(single.isMainChain).toBe(true);
  });

  it("maps the manifest: cwd, model, title, credit cost, durationMs", async () => {
    const sessions = await collectSessions(adapter);
    const main = sessions.find((s) => s.manifest.sessionId === "test-forest")!.manifest;
    expect(main).toMatchObject({
      harness: "devin",
      harnessVersion: "unknown",
      cwd: "/home/test/forest",
      model: "claude-test-1",
      title: "森林会话",
      titleOrigin: "custom",
    });
    expect(main.stats?.turnCount).toBe(1); // user messages in the main tree
    expect(main.stats?.durationMs).toBe(3600 * 1000);
    expect(main.stats?.totalUsage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      durationMs: 500,
      cost: { amount: 12.5, currency: "credit" },
    });
  });

  it("projects the main tree: roles, thinking block, tool pairing, real parent links", async () => {
    const records = await readAll(adapter, "test-forest");
    // m-0 system → harness_message (root); m-1 user; m-2 assistant (thinking
    // + text + usage); tool_call; m-3 tool_result; m-5 re-anchored branch.
    expect(records.map((r) => r.type)).toEqual([
      "harness_message",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    records.forEach((rec, i) => expect(rec.seq).toBe(i));
    expect(records[0]).toMatchObject({ recordId: "m-0", parentId: null });
    expect(records[1]).toMatchObject({ recordId: "m-1", parentId: "m-0" });
    expect(records[2]).toMatchObject({
      recordId: "m-2",
      parentId: "m-1",
      content: [
        { type: "thinking", text: "先想一下。" },
        { type: "text", text: "我来查看。" },
      ],
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, durationMs: 500 },
    });
    expect(records[3]).toMatchObject({
      recordId: "m-2/tool_call/0",
      parentId: "m-2",
      toolCallId: "tc-1",
      name: "read",
      args: { file_path: "/a.ts" },
      kind: "function",
      status: "completed",
    });
    expect(records[4]).toMatchObject({
      recordId: "m-3",
      parentId: "m-2/tool_call/0",
      toolCallId: "tc-1",
      content: "file content here",
    });
    // Dedup: m-2 appears exactly once; node 5 re-anchors to its tool_call.
    expect(records.filter((r) => r.recordId === "m-2")).toHaveLength(1);
    expect(records[5]).toMatchObject({ recordId: "m-5", parentId: "m-2/tool_call/0" });
  });

  it("projects the sibling root as its own single-rooted tree", async () => {
    const records = await readAll(adapter, SIBLING_ID);
    expect(records.map((r) => r.type)).toEqual(["user_message", "assistant_message"]);
    expect(records[0]).toMatchObject({ recordId: "m-10", parentId: null });
    expect(records[1]).toMatchObject({ recordId: "m-11", parentId: "m-10" });
  });

  it("tool-only assistant message: usage rides the first tool_call; dangling call interrupted", async () => {
    const records = await readAll(adapter, "test-single");
    expect(records.map((r) => r.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "tool_result",
    ]);
    expect(records[1]).toMatchObject({
      toolCallId: "tc-a",
      status: "completed",
      usage: { inputTokens: 40, outputTokens: 6, durationMs: 200 },
    });
    expect(records[2]).toMatchObject({ toolCallId: "tc-b", status: "interrupted" });
    expect(records.some((r) => r.type === "tool_result" && r.toolCallId === "tc-b")).toBe(false);
  });

  it("throws for an unknown session id", async () => {
    await expect(readAll(adapter, "no-such-session")).rejects.toThrow("session not found");
    await expect(readAll(adapter, "test-forest#root-999")).rejects.toThrow("session not found");
  });
});
