/**
 * Qwen Code adapter — AC layer-1 (zod validity) and layer-2 (semantic
 * invariants) plus mapping assertions against synthetic fixtures.
 *
 * Fixture layout (all hand-crafted, no real user data), mirroring ~/.qwen:
 *   a1111111-…  basic session: thought parts → thinking blocks, interleaved
 *               system records dropped, usageMetadata → record usage,
 *               runtime.json present — AC-0002-N-3/N-4
 *   b2222222-…  functionCall/functionResponse parts → tool_call/tool_result,
 *               error response → failed, unpaired call → interrupted,
 *               functionCall-only message carries usage on the tool_call —
 *               AC-0002-N-6/B-1/B-2
 *   c3333333-…  branch points: edit-resend after an assistant record
 *               (forked_from) + re-answer to a user prompt (sibling_attempt) —
 *               AC-0002-N-7
 *   d4444444-…  only system records — not an AHS session (skipped)
 *   usage/token-usage-2026-07.jsonl  per-call usage: main rows reconcile with
 *               record usageMetadata; managed-auto-memory-extractor rows have
 *               no content → no child session, merged into stats (spec §五)
 *   usage_record.jsonl  per-session summaries → stats.durationMs (summed)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { QwenCodeAdapter } from "../src/adapters/qwen/index";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import type { Usage } from "../src/schema/usage";
import { checkIdempotency, collectSessions, validateSessions } from "../src/validate/index";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "qwen",
);

const SESSION_A = "a1111111-1111-4111-8111-111111111111"; // basic + usage join
const SESSION_B = "b2222222-2222-4222-8222-222222222222"; // tool calls
const SESSION_C = "c3333333-3333-4333-8333-333333333333"; // fork synthesis
const SESSION_D = "d4444444-4444-4444-8444-444444444444"; // process-only, skipped
const FORK_EDIT = `${SESSION_C}/fork/cc000003-0000-4000-8000-000000000003`;
const FORK_RETRY = `${SESSION_C}/fork/cc000008-0000-4000-8000-000000000008`;

async function readAll(adapter: QwenCodeAdapter, sessionId: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId)) records.push(rec);
  return records;
}

function sumUsage(records: AhsRecord[]): Required<Omit<Usage, "cost" | "durationMs" | "cacheWriteTokens">> {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  for (const rec of records) {
    total.inputTokens += rec.usage?.inputTokens ?? 0;
    total.outputTokens += rec.usage?.outputTokens ?? 0;
    total.cacheReadTokens += rec.usage?.cacheReadTokens ?? 0;
    total.reasoningTokens += rec.usage?.reasoningTokens ?? 0;
  }
  return total;
}

describe("qwen adapter", () => {
  const adapter = new QwenCodeAdapter(fixturesDir);

  it("declares harness + capabilities", () => {
    expect(adapter.harness).toBe("qwen-code");
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

  it("layer 1 (AC-0001-E-1): telemetry/process fields are dropped, no schema-extra output", async () => {
    const sessions = await collectSessions(adapter);
    for (const { manifest, records } of sessions) {
      expect(() => ManifestSchema.strict().parse(manifest)).not.toThrow();
      for (const rec of records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
        expect(JSON.stringify(rec)).not.toMatch(
          /attribution_snapshot|file_history_snapshot|ui_telemetry|systemPayload|contextWindowSize|totalTokenCount/,
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

  it("lists main and fork sessions; skips process-only sessions", async () => {
    const sessions = await collectSessions(adapter);
    const ids = sessions.map((s) => s.manifest.sessionId).sort();
    expect(ids).toEqual([SESSION_A, SESSION_B, SESSION_C, FORK_EDIT, FORK_RETRY].sort());
    expect(ids).not.toContain(SESSION_D);
  });

  it("listSessions default folds lineage descendants; includeForks lists them (interface-0001)", async () => {
    const heads: string[] = [];
    for await (const m of adapter.listSessions()) heads.push(m.sessionId);
    expect(heads.sort()).toEqual([SESSION_A, SESSION_B, SESSION_C].sort());

    const all: string[] = [];
    for await (const m of adapter.listSessions({ includeForks: true })) all.push(m.sessionId);
    expect(all).toContain(FORK_EDIT);
    expect(all).toContain(FORK_RETRY);
    expect(all.length).toBe(heads.length + 2);
  });

  it("readRecords of a process-only session yields nothing; unknown sessionId throws", async () => {
    expect(await readAll(adapter, SESSION_D)).toEqual([]);
    await expect(readAll(adapter, "no-such-session")).rejects.toThrow("session not found");
  });

  it("filters sessions by harness and cwd", async () => {
    const byHarness: string[] = [];
    for await (const m of adapter.listSessions({ harness: "codex" })) byHarness.push(m.sessionId);
    expect(byHarness).toEqual([]);

    const byCwd: string[] = [];
    for await (const m of adapter.listSessions({ cwd: "/tmp/st" })) byCwd.push(m.sessionId);
    expect(byCwd).toEqual([SESSION_A, SESSION_C].sort());
    const none: string[] = [];
    for await (const m of adapter.listSessions({ cwd: "/elsewhere" })) none.push(m.sessionId);
    expect(none).toEqual([]);
  });

  it("yields nothing when the base path does not exist", async () => {
    const missing = new QwenCodeAdapter(path.join(fixturesDir, "no-such-base"));
    expect(await collectSessions(missing)).toEqual([]);
  });

  describe("basic session with usage join (fixture A)", () => {
    it("maps manifest fields from records + runtime.json (AC-0002-N-4)", async () => {
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_A)!.manifest;
      expect(manifest.harness).toBe("qwen-code");
      expect(manifest.harnessVersion).toBe("0.19.1");
      expect(manifest.ahsVersion).toBe("0.1.0");
      expect(manifest.cwd).toBe("/tmp/st");
      expect(manifest.model).toBe("deepseek-v4-flash");
      expect(manifest.git).toBeUndefined();
      expect(manifest.lineage).toBeUndefined();
      expect(manifest.invocation).toBeUndefined();
      expect(manifest.stats?.turnCount).toBe(2);
      // durationMs = 18171 + 13902 (summed across the session's entries).
      expect(manifest.stats?.durationMs).toBe(32073);
    });

    it("projects records: thought parts → thinking blocks, system records leave no gaps (AC-0002-N-1/N-3)", async () => {
      const records = await readAll(adapter, SESSION_A);
      expect(records.map((r) => r.type)).toEqual([
        "user_message",
        "assistant_message",
        "user_message",
        "assistant_message",
      ]);
      expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
      const assistant = records[1]!;
      if (assistant.type === "assistant_message") {
        expect(assistant.content).toEqual([
          {
            type: "thinking",
            text: 'The user just said "Say hello", so a friendly greeting is the right reply.',
          },
          { type: "text", text: "Hello! How can I help you today?" },
        ]);
        expect(assistant.model).toBe("deepseek-v4-flash");
      }
    });

    it("maps usageMetadata to record-level usage (AC-0002-N-4)", async () => {
      const records = await readAll(adapter, SESSION_A);
      const assistant = records[1]!;
      expect(assistant.usage).toEqual({
        inputTokens: 29849,
        outputTokens: 31,
        reasoningTokens: 20,
        cacheReadTokens: 0,
      });
      expect(sumUsage(records)).toEqual({
        inputTokens: 64413,
        outputTokens: 124,
        cacheReadTokens: 11008,
        reasoningTokens: 90,
      });
    });

    it("record usage reconciles with the global main rows; subagent usage merges into stats (spec §五)", async () => {
      const sessions = await collectSessions(adapter);
      const session = sessions.find((s) => s.manifest.sessionId === SESSION_A)!;
      const recordSum = sumUsage(session.records);
      // Global main rows for A: 29849+34564 in, 31+93 out, 0+11008 cached,
      // 20+70 thoughts — exactly the record-level sum.
      expect(recordSum).toEqual({
        inputTokens: 64413,
        outputTokens: 124,
        cacheReadTokens: 11008,
        reasoningTokens: 90,
      });
      // Subagent (managed-auto-memory-extractor) rows: 11753+12192 in,
      // 340+199 out, 0+11776 cached, 129+113 thoughts — telemetry only, no
      // child session, merged into stats.totalUsage.
      expect(session.manifest.stats?.totalUsage).toEqual({
        inputTokens: 88358,
        outputTokens: 663,
        cacheReadTokens: 22784,
        reasoningTokens: 332,
      });
      // No invocation child sessions exist anywhere.
      expect(sessions.some((s) => s.manifest.invocation !== undefined)).toBe(false);
    });
  });

  describe("tool calls in parts (fixture B)", () => {
    it("splits functionCall parts into tool_call records after the assistant record", async () => {
      const records = await readAll(adapter, SESSION_B);
      expect(records.map((r) => r.type)).toEqual([
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_call",
        "tool_result",
        "tool_result",
        "assistant_message",
        "tool_call",
        "tool_result",
        "tool_call", // functionCall-only message — session ends mid-turn
      ]);
      const grep = records[2]!;
      if (grep.type === "tool_call") {
        expect(grep.recordId).toBe("bb000002-0000-4000-8000-000000000002/functionCall/0");
        expect(grep.toolCallId).toBe("call-0001");
        expect(grep.name).toBe("Grep");
        expect(grep.args).toEqual({ pattern: "parser", path: "src" });
        expect(grep.status).toBe("completed");
      }
    });

    it("maps functionResponse parts to tool_result records; error key → failed (AC-0002-N-6)", async () => {
      const records = await readAll(adapter, SESSION_B);
      const first = records[4]!;
      if (first.type === "tool_result") {
        expect(first.recordId).toBe("bb000003-0000-4000-8000-000000000003");
        expect(first.toolCallId).toBe("call-0001");
        expect(first.status).toBe("success");
        expect(first.content).toBe(
          JSON.stringify({ matches: ["src/parser.ts:12:export function parseGenerics"] }),
        );
      }
      const second = records[5]!;
      if (second.type === "tool_result") {
        expect(second.recordId).toBe("bb000003-0000-4000-8000-000000000003/functionResponse/1");
        expect(second.toolCallId).toBe("call-0002");
      }
      const errorResult = records[8]!;
      if (errorResult.type === "tool_result") {
        expect(errorResult.status).toBe("error");
        expect(errorResult.content).toBe(
          JSON.stringify({ error: "ENOENT: no such file or directory: src/parser.ts" }),
        );
      }
      const failedCall = records[7]!;
      if (failedCall.type === "tool_call") expect(failedCall.status).toBe("failed");
    });

    it("marks the unpaired final call interrupted, no synthetic result (AC-0002-B-1)", async () => {
      const records = await readAll(adapter, SESSION_B);
      const last = records[records.length - 1]!;
      expect(last.type).toBe("tool_call");
      if (last.type === "tool_call") {
        expect(last.toolCallId).toBe("call-0004");
        expect(last.status).toBe("interrupted");
        // functionCall-only message: usage/model ride on the tool_call.
        expect(last.recordId).toBe("bb000006-0000-4000-8000-000000000006");
        expect(last.model).toBe("deepseek-v4-flash");
        expect(last.usage).toEqual({
          inputTokens: 6100,
          outputTokens: 22,
          reasoningTokens: 5,
          cacheReadTokens: 0,
        });
      }
      expect(
        records.some((r) => r.type === "tool_result" && r.toolCallId === "call-0004"),
      ).toBe(false);
    });

    it("partial usageMetadata is kept as-is (AC-0002-B-2); git.branch mapped", async () => {
      const sessions = await collectSessions(adapter);
      const session = sessions.find((s) => s.manifest.sessionId === SESSION_B)!;
      expect(session.manifest.git?.branch).toBe("main");
      expect(session.manifest.stats?.durationMs).toBe(100623);
      // Records carry usage on bb000002 + bb000006; the global main rows are
      // NOT added on top (same calls — no double counting).
      expect(session.manifest.stats?.totalUsage).toEqual({
        inputTokens: 11300,
        outputTokens: 70,
        cacheReadTokens: 300,
        reasoningTokens: 17,
      });
    });
  });

  describe("fork synthesis (fixture C, AC-0002-N-7)", () => {
    it("main chain = the chain leading to the last leaf (edit-resend branch wins by file order)", async () => {
      const main = await readAll(adapter, SESSION_C);
      expect(main.map((r) => r.recordId)).toEqual([
        "cc000001-0000-4000-8000-000000000001",
        "cc000002-0000-4000-8000-000000000002",
        "cc000005-0000-4000-8000-000000000005", // edited resubmit, not cc000003
        "cc000006-0000-4000-8000-000000000006",
        "cc000007-0000-4000-8000-000000000007",
        "cc000009-0000-4000-8000-000000000009", // the later re-answer
      ]);
      expect(main.map((r) => r.seq)).toEqual(main.map((_, i) => i));
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_C)!.manifest;
      expect(manifest.lineage).toBeUndefined();
      expect(manifest.stats?.turnCount).toBe(3);
      // No usage anywhere in this file → no totalUsage (AC-0002-B-2).
      expect(manifest.stats?.totalUsage).toBeUndefined();
      expect(manifest.stats?.durationMs).toBeUndefined();
    });

    it("edit-resend branch becomes a forked_from session anchored at the assistant record", async () => {
      const sessions = await collectSessions(adapter);
      const fork = sessions.find((s) => s.manifest.sessionId === FORK_EDIT)!;
      expect(fork.manifest.lineage).toEqual({
        type: "forked_from",
        sessionId: SESSION_C,
        atRecordId: "cc000002-0000-4000-8000-000000000002",
      });
      expect(fork.records.map((r) => r.type)).toEqual(["user_message", "assistant_message"]);
      expect(fork.records[0]!.seq).toBe(0);
    });

    it("re-answer to the same prompt becomes a sibling_attempt anchored at the user_message", async () => {
      const sessions = await collectSessions(adapter);
      const fork = sessions.find((s) => s.manifest.sessionId === FORK_RETRY)!;
      expect(fork.manifest.lineage).toEqual({
        type: "sibling_attempt",
        sessionId: SESSION_C,
        atRecordId: "cc000007-0000-4000-8000-000000000007",
      });
      expect(fork.records.map((r) => r.type)).toEqual(["assistant_message"]);
      expect(fork.records[0]!.recordId).toBe("cc000008-0000-4000-8000-000000000008");
      const main = await readAll(adapter, SESSION_C);
      expect(main.some((r) => r.recordId.startsWith("cc000008"))).toBe(false);
    });

    it("readRecords resolves fork session ids", async () => {
      expect((await readAll(adapter, FORK_EDIT)).map((r) => r.type)).toEqual([
        "user_message",
        "assistant_message",
      ]);
      expect(await readAll(adapter, FORK_RETRY)).toHaveLength(1);
    });
  });
});
