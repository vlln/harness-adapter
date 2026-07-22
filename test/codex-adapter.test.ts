import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CodexAdapter } from "../src/adapters/codex/index";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import {
  checkIdempotency,
  collectSessions,
  validateSessions,
} from "../src/validate/index";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "codex",
);

const SESSION_ID = "01JTESTC0DEXSPIKE00000001";

async function readAll(adapter: CodexAdapter, sessionId: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId)) records.push(rec);
  return records;
}

describe("codex adapter", () => {
  const adapter = new CodexAdapter(fixturesDir);

  it("declares harness + capabilities", () => {
    expect(adapter.harness).toBe("codex");
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

  it("maps the manifest from session_meta + first turn_context", async () => {
    const sessions = await collectSessions(adapter);
    expect(sessions).toHaveLength(2);
    const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_ID)!.manifest;
    expect(manifest).toMatchObject({
      sessionId: SESSION_ID,
      harness: "codex",
      harnessVersion: "0.142.5",
      cwd: "/home/test/demo",
      workspaceRoots: ["/home/test/demo"],
      provider: "openai",
      model: "gpt-5.5",
      git: {
        branch: "main",
        commit: "1111111111111111111111111111111111111111",
        repoUrl: "https://github.com/test/demo.git",
      },
    });
    // turnCount from task_started count; totalUsage = sum of token_count deltas.
    expect(manifest.stats?.turnCount).toBe(2);
    expect(manifest.stats?.totalUsage).toEqual({
      inputTokens: 2500,
      outputTokens: 130,
      cacheReadTokens: 500,
      reasoningTokens: 30,
    });
  });

  it("synthesizes a deterministic linear chain with <sessionId>:<seq> ids", async () => {
    const records = await readAll(adapter, SESSION_ID);
    expect(records).toHaveLength(17);
    records.forEach((rec, i) => {
      expect(rec.recordId).toBe(`${SESSION_ID}:${i}`);
      expect(rec.seq).toBe(i);
      expect(rec.parentId).toBe(i === 0 ? null : `${SESSION_ID}:${i - 1}`);
    });
  });

  it("dedups response_item vs event_msg messages: each emitted exactly once", async () => {
    const records = await readAll(adapter, SESSION_ID);
    // Canonical counts come from response_item only — the event_msg
    // user_message/agent_message lines are duplicates and must not appear.
    const users = records.filter((r) => r.type === "user_message");
    const assistants = records.filter((r) => r.type === "assistant_message");
    expect(users).toHaveLength(2);
    expect(assistants).toHaveLength(1);
    expect(users.map((r) => r.type === "user_message" && r.content[0])).toEqual([
      { type: "text", text: "修复登录页的空指针崩溃" },
      { type: "text", text: "顺便把补丁打上" },
    ]);
    // developer-role response_item maps to harness_message.
    const harness = records.filter((r) => r.type === "harness_message");
    expect(harness).toHaveLength(1);
    // Encrypted reasoning is dropped entirely.
    expect(records.some((r) => JSON.stringify(r).includes("encrypted"))).toBe(false);
  });

  it("maps function_call/custom_tool_call, parses JSON-string arguments, dedups by call_id", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const calls = records.filter((r) => r.type === "tool_call");
    // Top-level bare function_call duplicate of call_001 must not produce a
    // second tool_call.
    expect(calls).toHaveLength(3);
    const c1 = calls.find((r) => r.type === "tool_call" && r.toolCallId === "call_001");
    expect(c1).toMatchObject({
      name: "exec_command",
      args: { cmd: "sed -n '1,80p' src/auth/login.ts", workdir: "/home/test/demo" },
      status: "completed",
    });
    const c2 = calls.find((r) => r.type === "tool_call" && r.toolCallId === "call_002");
    expect(c2).toMatchObject({ name: "apply_patch", status: "completed" });
    const results = records.filter((r) => r.type === "tool_result");
    expect(results).toHaveLength(2);
  });

  it("marks the dangling function_call interrupted, with no synthetic result (XOR)", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const c3 = records.find((r) => r.type === "tool_call" && r.toolCallId === "call_003");
    expect(c3).toMatchObject({ status: "interrupted" });
    expect(records.some((r) => r.type === "tool_result" && r.toolCallId === "call_003")).toBe(
      false,
    );
  });

  it("attaches token_count usage to the immediately preceding emitted record", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const assistant = records.find((r) => r.type === "assistant_message");
    expect(assistant?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 200,
      reasoningTokens: 10,
    });
    // Second token_count lands on the dangling tool_call.
    const c3 = records.find((r) => r.type === "tool_call" && r.toolCallId === "call_003");
    expect(c3?.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 80,
      cacheReadTokens: 300,
      reasoningTokens: 20,
    });
  });

  it("emits state events: turn boundaries, model_change, one compaction, goal updates", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const boundaries = records.filter((r) => r.type === "turn_boundary");
    expect(boundaries.map((r) => r.type === "turn_boundary" && r.phase)).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
    const modelChange = records.filter((r) => r.type === "model_change");
    expect(modelChange).toHaveLength(1);
    expect(modelChange[0]).toMatchObject({ model: "gpt-5.5-mini" });
    // compacted + context_compacted pair collapses to exactly one record.
    expect(records.filter((r) => r.type === "compaction")).toHaveLength(1);
    const goals = records.filter((r) => r.type === "goal_update");
    expect(goals).toHaveLength(2);
    expect(goals[0]).toMatchObject({ status: "pending", reason: "完成登录崩溃修复并验证" });
    expect(goals[1]).toMatchObject({ status: "met" });
  });

  it("maps sub-agent spawn declaration to a spawned_by relation (first session_meta wins)", async () => {
    const sessions = await collectSessions(adapter);
    const child = sessions.find(
      (s) => s.manifest.sessionId === "02JTESTC0DEXSPIKE00000002",
    )!.manifest;
    // The file's own session_meta comes first; the parent meta that follows
    // is a lineage header and must not hijack the session id.
    expect(child.relation).toEqual({ type: "spawned_by", sessionId: SESSION_ID });
    expect(child.stats?.turnCount).toBe(1);
  });

  it("throws for an unknown session id", async () => {
    await expect(readAll(adapter, "no-such-session")).rejects.toThrow("session not found");
  });
});
