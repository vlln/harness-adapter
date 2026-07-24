/**
 * Pi Agent adapter — AC layer-1 (zod validity) and layer-2 (semantic
 * invariants) plus mapping assertions against synthetic fixtures.
 *
 * Fixture layout (all hand-crafted, no real user data), under
 * test/fixtures/pi/--Users-test-Project-demo--/:
 *   aaaa…00a1  minimal session with cost-bearing usage — AC-0002-N-3/N-4,
 *              cost mapping (pi is the only harness with cost)
 *   bbbb…00b2  parallel tool calls (chained results, one isError),
 *              mid-session model_change, an error assistant message
 *              (empty content, projects nothing) — AC-0001-E-1, AC-0002-N-6
 *   cccc…00c3  branch points: edit-resend after an assistant record
 *              (rewound_from) + re-answer to a user prompt (rewound_from);
 *              main chain = chain to the last leaf — AC-0002-N-7
 *   dddd…00d4  thinking_level_change before any model_change (dropped),
 *              assistant without usage, interrupted tool_call — AC-0002-B-1/B-2
 *   eeee…00e5  session record only — not an AHS session (skipped)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PiAdapter } from "../src/adapters/pi/index";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import type { Usage } from "../src/schema/usage";
import { checkIdempotency, collectSessions, validateSessions } from "../src/validate/index";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pi",
);

const SESSION_A = "019f4000-aaaa-7000-8000-0000000000a1"; // minimal + cost
const SESSION_B = "019f4000-bbbb-7000-8000-0000000000b2"; // tools + model switch + error msg
const SESSION_C = "019f4000-cccc-7000-8000-0000000000c3"; // forks
const SESSION_D = "019f4000-dddd-7000-8000-0000000000d4"; // edge cases
const SESSION_E = "019f4000-eeee-7000-8000-0000000000e5"; // session record only, skipped
// Fork constants removed — forks are now intra-session branches (ADR-0006).

async function readAll(adapter: PiAdapter, sessionId: string, branchName?: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId, branchName)) records.push(rec);
  return records;
}

function sumUsage(records: AhsRecord[]): Required<Omit<Usage, "cost" | "durationMs">> {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  for (const rec of records) {
    total.inputTokens += rec.usage?.inputTokens ?? 0;
    total.outputTokens += rec.usage?.outputTokens ?? 0;
    total.cacheReadTokens += rec.usage?.cacheReadTokens ?? 0;
    total.cacheWriteTokens += rec.usage?.cacheWriteTokens ?? 0;
    total.reasoningTokens += rec.usage?.reasoningTokens ?? 0;
  }
  return total;
}

describe("pi adapter", () => {
  const adapter = new PiAdapter(fixturesDir);

  it("declares harness + capabilities", () => {
    expect(adapter.harness).toBe("pi");
    expect(adapter.capabilities).toEqual({ history: "full", control: false });
  });

  it("layer 1 (AC-0001-N-1): every manifest and record passes the zod schemas", async () => {
    const sessions = await collectSessions(adapter);
    expect(sessions.length).toBeGreaterThan(0);
    for (const { manifest, records } of sessions) {
      expect(() => ManifestSchema.parse(manifest)).not.toThrow();
      for (const rec of records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
      }
    }
  });

  it("layer 1 (AC-0001-E-1): unmappable source fields are dropped, no schema-extra output", async () => {
    // Fixture B carries api/responseId/stopReason/thinkingSignature/
    // errorMessage/totalTokens/message-level ms timestamps; output stays
    // schema-valid and carries no trace of dropped fields.
    const sessions = await collectSessions(adapter);
    for (const { manifest, records } of sessions) {
      expect(() => ManifestSchema.strict().parse(manifest)).not.toThrow();
      for (const rec of records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
        expect(JSON.stringify(rec)).not.toMatch(
          /thinkingSignature|responseId|stopReason|errorMessage|totalTokens|thinkingLevel/,
        );
      }
    }
  });

  it("layer 2 (AC-0002): all semantic invariants hold on all fixtures (N-1/N-6/N-7 via validate)", async () => {
    const sessions = await collectSessions(adapter);
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("layer 2 (AC-0002-N-5): idempotent — two runs are byte-identical", async () => {
    expect(await checkIdempotency(adapter)).toEqual([]);
  });

  it("lists main sessions; forks are intra-session branches (ADR-0006)", async () => {
    const sessions = await collectSessions(adapter);
    const ids = sessions.map((s) => s.manifest.sessionId).sort();
    expect(ids).toEqual([SESSION_A, SESSION_B, SESSION_C, SESSION_D].sort());
    expect(ids).not.toContain(SESSION_E);
  });

  it("listSessions always lists all sessions; includeForks is a no-op (ADR-0006)", async () => {
    const heads: string[] = [];
    for await (const m of adapter.listSessions()) heads.push(m.sessionId);
    expect(heads.sort()).toEqual([SESSION_A, SESSION_B, SESSION_C, SESSION_D].sort());

    const all: string[] = [];
    for await (const m of adapter.listSessions({ includeForks: true })) all.push(m.sessionId);
    expect(all.sort()).toEqual([SESSION_A, SESSION_B, SESSION_C, SESSION_D].sort());
  });

  it("readRecords of a session-record-only file yields nothing; unknown sessionId throws", async () => {
    expect(await readAll(adapter, SESSION_E)).toEqual([]);
    await expect(readAll(adapter, "no-such-session")).rejects.toThrow("session not found");
  });

  it("filters sessions by harness and cwd", async () => {
    const byHarness: string[] = [];
    for await (const m of adapter.listSessions({ harness: "codex" })) byHarness.push(m.sessionId);
    expect(byHarness).toEqual([]);

    const byCwd: string[] = [];
    for await (const m of adapter.listSessions({ cwd: "/Users/test/Project/demo" })) {
      byCwd.push(m.sessionId);
    }
    expect(byCwd.length).toBeGreaterThan(0);
    const none: string[] = [];
    for await (const m of adapter.listSessions({ cwd: "/elsewhere" })) none.push(m.sessionId);
    expect(none).toEqual([]);
  });

  describe("minimal session with cost (fixture A)", () => {
    it("maps manifest fields from the session + first model_change records", async () => {
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_A)!.manifest;
      expect(manifest.harness).toBe("pi");
      expect(manifest.harnessVersion).toBe("3"); // storage protocol version
      expect(manifest.ahsVersion).toBe("0.1.0");
      expect(manifest.cwd).toBe("/Users/test/Project/demo");
      expect(manifest.model).toBe("DeepSeek-V4-Flash");
      expect(manifest.provider).toBe("ollama");
      expect(manifest.lineage).toBeUndefined();
      expect(manifest.invocation).toBeUndefined();
      expect(manifest.stats?.turnCount).toBe(1);
      expect(manifest.stats?.totalUsage).toEqual({
        inputTokens: 1918,
        outputTokens: 409,
        cacheReadTokens: 256,
        cost: { amount: 0.0007, currency: "USD" },
      });
    });

    it("projects model_change + thinking_level_change as model_change records (thinkingLevel dropped)", async () => {
      const records = await readAll(adapter, SESSION_A);
      expect(records.map((r) => r.type)).toEqual([
        "model_change",
        "model_change", // thinking_level_change → current model, thinkingLevel dropped
        "user_message",
        "assistant_message",
      ]);
      const initial = records[0]!;
      if (initial.type === "model_change") {
        expect(initial.model).toBe("DeepSeek-V4-Flash");
        expect(initial.provider).toBe("ollama");
      }
      const thinking = records[1]!;
      if (thinking.type === "model_change") {
        expect(thinking.recordId).toBe("aa000002");
        expect(thinking.model).toBe("DeepSeek-V4-Flash");
        expect(thinking.provider).toBe("ollama");
      }
      expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    });

    it("preserves text and thinking verbatim (AC-0002-N-3)", async () => {
      const records = await readAll(adapter, SESSION_A);
      const user = records[2]!;
      if (user.type === "user_message") {
        expect(user.content).toEqual([{ type: "text", text: "say hello" }]);
      }
      const assistant = records[3]!;
      if (assistant.type === "assistant_message") {
        expect(assistant.content).toEqual([
          { type: "thinking", text: "The user wants a greeting." },
          { type: "text", text: "Hello!" },
        ]);
      }
    });

    it("maps usage including cost and reasoning; drops totalTokens (AC-0002-N-4)", async () => {
      const records = await readAll(adapter, SESSION_A);
      const assistant = records[3]!;
      expect(assistant.model).toBe("DeepSeek-V4-Flash");
      expect(assistant.usage).toEqual({
        inputTokens: 1918,
        outputTokens: 409,
        cacheReadTokens: 256,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: { amount: 0.0007, currency: "USD" },
      });
    });
  });

  describe("tools + model switch + error message (fixture B)", () => {
    it("splits parallel toolCall blocks into tool_call records after the assistant record", async () => {
      const records = await readAll(adapter, SESSION_B);
      expect(records.map((r) => r.type)).toEqual([
        "model_change",
        "model_change",
        "user_message",
        "assistant_message", // thinking only
        "tool_call",
        "tool_call",
        "tool_result",
        "tool_result",
        "model_change", // mid-session switch
        "assistant_message", // the error message (empty content) projects nothing
      ]);
      const assistant = records[3]!;
      if (assistant.type === "assistant_message") {
        expect(assistant.content).toEqual([
          { type: "thinking", text: "Two independent reads; run them in parallel." },
        ]);
        expect(assistant.usage).toMatchObject({ reasoningTokens: 64, cacheWriteTokens: 300 });
      }
      const call0 = records[4]!;
      if (call0.type === "tool_call") {
        expect(call0.recordId).toBe("bb000004/toolCall/0");
        expect(call0.toolCallId).toBe("call_00_AAAA");
        expect(call0.name).toBe("bash");
        expect(call0.args).toEqual({ command: "npx vitest run" });
        expect(call0.status).toBe("completed");
      }
      const call1 = records[5]!;
      if (call1.type === "tool_call") {
        expect(call1.recordId).toBe("bb000004/toolCall/1");
        expect(call1.status).toBe("failed"); // paired result isError: true
      }
    });

    it("maps toolResult messages to tool_result records with isError status (AC-0002-N-6)", async () => {
      const records = await readAll(adapter, SESSION_B);
      const ok = records[6]!;
      if (ok.type === "tool_result") {
        expect(ok.toolCallId).toBe("call_00_AAAA");
        expect(ok.content).toBe("12 tests passed");
        expect(ok.status).toBe("success");
      }
      const err = records[7]!;
      if (err.type === "tool_result") {
        expect(err.toolCallId).toBe("call_01_BBBB");
        expect(err.status).toBe("error");
        expect(err.content).toBe("Error: ENOENT: no such file or directory");
      }
    });

    it("maps the mid-session model_change; the error assistant message projects nothing", async () => {
      const records = await readAll(adapter, SESSION_B);
      const switchRec = records[8]!;
      if (switchRec.type === "model_change") {
        expect(switchRec.recordId).toBe("bb000007");
        expect(switchRec.model).toBe("grok-4.5");
        expect(switchRec.provider).toBe("grok");
      }
      // bb000008 (stopReason error, empty content, all-zero usage) emits no
      // record; the retry assistant carries the new model per-record.
      expect(records.some((r) => r.recordId === "bb000008")).toBe(false);
      const final = records[9]!;
      expect(final.recordId).toBe("bb000009");
      expect(final.model).toBe("grok-4.5");
      // Usage sums reconcile with the source (zero-usage error message adds 0).
      expect(sumUsage(records)).toEqual({
        inputTokens: 3100,
        outputTokens: 160,
        cacheReadTokens: 100,
        cacheWriteTokens: 300,
        reasoningTokens: 64,
      });
    });
  });

  describe("fork synthesis (fixture C, AC-0002-N-7, ADR-0006 branches)", () => {
    it("main chain = the chain leading to the last leaf (edited resend + latest retry answer)", async () => {
      const main = await readAll(adapter, SESSION_C);
      expect(main.map((r) => r.recordId)).toEqual([
        "cc000001",
        "cc000002",
        "cc000003",
        "cc000004",
        "cc000007", // edited follow-up, not the original cc000005
        "cc000008",
        "cc000009",
        "cc00000b", // the retry's later answer
      ]);
      expect(main.map((r) => r.seq)).toEqual(main.map((_, i) => i));
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_C)!.manifest;
      expect(manifest.lineage).toBeUndefined();
      expect(manifest.stats?.turnCount).toBe(3);
    });

    it("manifest registers fork branches with parentRecordId anchors", async () => {
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_C)!.manifest;
      expect(Object.keys(manifest.branches).sort()).toEqual(["b001", "b002", "main"]);
      expect(manifest.branches.main).toEqual({ parentBranch: null, parentRecordId: null });
      // b001: edit-resend fork, anchored at the assistant record cc000004
      expect(manifest.branches.b001!.parentBranch).toBe("main");
      expect(manifest.branches.b001!.parentRecordId).toBe("cc000004");
      // b002: re-answer fork, anchored at the user_message cc000009
      expect(manifest.branches.b002!.parentBranch).toBe("main");
      expect(manifest.branches.b002!.parentRecordId).toBe("cc000009");
    });

    it("edit-resend branch (b001) stores suffix-only records", async () => {
      const records = await readAll(adapter, SESSION_C, "b001");
      expect(records.map((r) => r.recordId)).toEqual(["cc000005", "cc000006"]);
      expect(records[0]!.seq).toBe(0);
    });

    it("re-answer branch (b002) stores the alternate answer, not in the main chain", async () => {
      const records = await readAll(adapter, SESSION_C, "b002");
      expect(records.map((r) => r.recordId)).toEqual(["cc00000a"]);
      // The competing answer is NOT in the main session.
      const main = await readAll(adapter, SESSION_C);
      expect(main.some((r) => r.recordId === "cc00000a")).toBe(false);
    });

    it("readRecords of old fork session IDs throws session not found", async () => {
      await expect(readAll(adapter, `${SESSION_C}/fork/cc000005`))
        .rejects.toThrow("session not found");
      await expect(readAll(adapter, `${SESSION_C}/fork/cc00000a`))
        .rejects.toThrow("session not found");
    });
  });

  describe("storage edge cases (fixture D)", () => {
    it("drops a thinking_level_change before any model_change (no current model)", async () => {
      const records = await readAll(adapter, SESSION_D);
      expect(records.some((r) => r.recordId === "dd000001")).toBe(false);
      expect(records.map((r) => r.type)).toEqual(["user_message", "tool_call"]);
      expect(records.map((r) => r.seq)).toEqual([0, 1]);
    });

    it("marks a tool_call without a paired result as interrupted, no synthetic result (AC-0002-B-1)", async () => {
      const records = await readAll(adapter, SESSION_D);
      const call = records[1]!;
      if (call.type === "tool_call") {
        expect(call.toolCallId).toBe("call_99_ZZZZ");
        expect(call.status).toBe("interrupted");
      }
      expect(records.some((r) => r.type === "tool_result")).toBe(false);
    });

    it("allows missing usage (AC-0002-B-2); manifest model falls back to unknown", async () => {
      const records = await readAll(adapter, SESSION_D);
      expect(records[1]!.usage).toBeUndefined();
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_D)!.manifest;
      expect(manifest.model).toBe("unknown");
      expect(manifest.stats?.totalUsage).toBeUndefined();
    });

    it("yields nothing when the base path does not exist", async () => {
      const missing = new PiAdapter(path.join(fixturesDir, "no-such-base"));
      const sessions = await collectSessions(missing);
      expect(sessions).toEqual([]);
    });
  });
});
