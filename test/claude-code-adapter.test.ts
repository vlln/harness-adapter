/**
 * Claude Code adapter — AC layer-1 (zod validity) and layer-2 (semantic
 * invariants) plus mapping assertions against synthetic fixtures.
 *
 * Fixture layout (all hand-crafted, no real user data):
 *   11111111-…  minimal session with goal lifecycle (sentinel → met) — AC-0002-N-3/N-4
 *   22222222-…  session with a subagent FILE + .meta.json — AC-0002-N-2
 *               (invocation anchor + tool_result.sessionId forward link)
 *   33333333-…  inline sidechain (sourceToolUseID fallback anchor) +
 *               compaction + duplicate tool_result + interrupted tool_call —
 *               AC-0002-N-6/B-1
 *   44444444-…  dropped process records (system/mode/attachment) leaving no
 *               seq gaps, multi tool_use, non-string tool_result,
 *               missing usage — AC-0001-E-1, AC-0002-B-2
 *   55555555-…  only process records — not an AHS session (skipped)
 *   66666666-…  branch points: edit-resend after an assistant record
 *               (forked_from) + re-answer to a user prompt (sibling_attempt);
 *               main chain = chain to the last leaf — AC-0002-N-7
 *   77777777-…  assistant segments sharing one message.id chain in file
 *               order (no fork); parallel result deliveries in separate user
 *               lines stay in one linear session; subagent whose
 *               meta.toolUseId resolves nowhere — AC-0002-B-3
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import type { Usage } from "../src/schema/usage";
import { checkIdempotency, collectSessions, validateSessions } from "../src/validate/index";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "claude-code",
);

const SESSION_A = "11111111-1111-4111-8111-111111111111"; // goal lifecycle
const SESSION_B = "22222222-2222-4222-8222-222222222222"; // subagent file
const SESSION_C = "33333333-3333-4333-8333-333333333333"; // inline sidechain + compaction
const SESSION_D = "44444444-4444-4444-8444-444444444444"; // edge cases
const SESSION_E = "55555555-5555-4555-8555-555555555555"; // process-only, skipped
const SESSION_F = "66666666-6666-4666-8666-666666666666"; // fork synthesis
const SESSION_G = "77777777-7777-4777-8777-777777777777"; // snapshot collapse + parallel deliveries
const FORK_EDIT = `${SESSION_F}/fork/eeee0003-0000-4000-8000-000000000003`;
const FORK_RETRY = `${SESSION_F}/fork/eeee0010-0000-4000-8000-000000000010`;

async function readAll(adapter: ClaudeCodeAdapter, sessionId: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId)) records.push(rec);
  return records;
}

function sumUsage(
  records: AhsRecord[],
): Required<Omit<Usage, "cost" | "durationMs" | "reasoningTokens">> {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const rec of records) {
    total.inputTokens += rec.usage?.inputTokens ?? 0;
    total.outputTokens += rec.usage?.outputTokens ?? 0;
    total.cacheReadTokens += rec.usage?.cacheReadTokens ?? 0;
    total.cacheWriteTokens += rec.usage?.cacheWriteTokens ?? 0;
  }
  return total;
}

describe("claude-code adapter", () => {
  const adapter = new ClaudeCodeAdapter(fixturesDir);

  it("declares harness + capabilities", () => {
    expect(adapter.harness).toBe("claude-code");
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
    // Fixture D carries system/mode/attachment records and fine usage tiers;
    // output stays schema-valid and carries no trace of dropped fields.
    const sessions = await collectSessions(adapter);
    for (const { manifest, records } of sessions) {
      expect(() => ManifestSchema.strict().parse(manifest)).not.toThrow();
      for (const rec of records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
        expect(JSON.stringify(rec)).not.toMatch(
          /ephemeral|service_tier|inference_geo|server_tool_use|permission-mode/,
        );
      }
    }
  });

  it("layer 2 (AC-0002): all semantic invariants hold on all fixtures (N-1/N-2/N-6/N-7 via validate)", async () => {
    const sessions = await collectSessions(adapter);
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("layer 2 (AC-0002-N-5): idempotent — two runs are byte-identical", async () => {
    expect(await checkIdempotency(adapter)).toEqual([]);
  });

  it("lists main, fork and child sessions; skips process-only sessions", async () => {
    const sessions = await collectSessions(adapter);
    const ids = sessions.map((s) => s.manifest.sessionId).sort();
    expect(ids).toEqual(
      [
        SESSION_A,
        SESSION_B,
        SESSION_C,
        SESSION_D,
        SESSION_F,
        SESSION_G,
        FORK_EDIT,
        FORK_RETRY,
        "abc123",
        "def456",
        "ghi789",
      ].sort(),
    );
    expect(ids).not.toContain(SESSION_E);
  });

  it("listSessions default folds lineage descendants; includeForks lists them (interface-0001)", async () => {
    const heads: string[] = [];
    for await (const m of adapter.listSessions()) heads.push(m.sessionId);
    expect(heads).not.toContain(FORK_EDIT);
    expect(heads).not.toContain(FORK_RETRY);
    // Group HEADs: main sessions (main chain = chain to the last leaf) and
    // invocation children are listed; forks are not.
    expect(heads.sort()).toEqual(
      [SESSION_A, SESSION_B, SESSION_C, SESSION_D, SESSION_F, SESSION_G, "abc123", "def456", "ghi789"].sort(),
    );

    const all: string[] = [];
    for await (const m of adapter.listSessions({ includeForks: true })) all.push(m.sessionId);
    expect(all).toContain(FORK_EDIT);
    expect(all).toContain(FORK_RETRY);
    expect(all.length).toBe(heads.length + 2);
  });

  it("readRecords of a process-only session yields nothing; unknown sessionId throws", async () => {
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

  describe("goal lifecycle session (fixture A)", () => {
    it("maps manifest fields from the source (AC-0002-N-4 usage accounting)", async () => {
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_A)!.manifest;
      expect(manifest.harness).toBe("claude-code");
      expect(manifest.harnessVersion).toBe("2.1.204");
      expect(manifest.ahsVersion).toBe("0.1.0");
      expect(manifest.cwd).toBe("/Users/test/Project/demo");
      expect(manifest.git?.branch).toBe("main");
      expect(manifest.model).toBe("claude-opus-4-1");
      expect(manifest.title).toBe("Fix the flaky login test");
      expect(manifest.titleOrigin).toBe("generated");
      expect(manifest.lineage).toBeUndefined();
      expect(manifest.invocation).toBeUndefined();
      expect(manifest.stats?.turnCount).toBe(2); // two string-content user prompts
      expect(manifest.stats?.totalUsage).toEqual({
        inputTokens: 6700,
        outputTokens: 130,
        cacheReadTokens: 2300,
        cacheWriteTokens: 300,
      });
    });

    it("projects records with message counts equal to the source (AC-0002-N-3)", async () => {
      const records = await readAll(adapter, SESSION_A);
      expect(records.map((r) => r.type)).toEqual([
        "goal_update", // initial goal_status attachment (sentinel)
        "user_message",
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "assistant_message",
        "tool_call",
        "tool_result",
        "assistant_message",
        "goal_update", // final goal_status attachment (met)
      ]);
    });

    it("maps goal_status attachments to goal_update records (sentinel → pending, met → met)", async () => {
      const records = await readAll(adapter, SESSION_A);
      const initial = records[0]!;
      expect(initial.type).toBe("goal_update");
      if (initial.type === "goal_update") {
        expect(initial.status).toBe("pending");
        expect(initial.reason).toBeUndefined();
        expect(initial.goalId).toBeUndefined();
      }
      const final = records[10]!;
      expect(final.type).toBe("goal_update");
      if (final.type === "goal_update") {
        expect(final.status).toBe("met");
        expect(final.reason).toBe(
          "The flaky timing wait was replaced with an explicit event await.",
        );
      }
    });

    it("preserves text verbatim, including slash-command XML", async () => {
      const records = await readAll(adapter, SESSION_A);
      const first = records[1]!;
      expect(first.type).toBe("user_message");
      if (first.type === "user_message") {
        expect(first.content).toEqual([
          {
            type: "text",
            text: "<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>Fix the flaky login test</command-args>",
          },
        ]);
      }
      const assistant = records[3]!;
      if (assistant.type === "assistant_message") {
        expect(assistant.content[0]).toEqual({
          type: "thinking",
          text: "The login test is flaky; I should run it first to see the failure mode.",
        });
        expect(assistant.content[1]).toEqual({
          type: "text",
          text: "I'll start by running the login test to reproduce the flakiness.",
        });
      }
    });

    it("splits tool_use blocks into tool_call records following the assistant record", async () => {
      const records = await readAll(adapter, SESSION_A);
      const toolCall = records[4]!;
      if (toolCall.type === "tool_call") {
        expect(toolCall.toolCallId).toBe("toolu_01AAAAAAAAAAAAAAAAAAAAAA");
        expect(toolCall.name).toBe("Bash");
        expect(toolCall.args).toEqual({
          command: "npx vitest run test/login.test.ts",
          description: "Run the login test",
        });
      }
      const toolResult = records[5]!;
      if (toolResult.type === "tool_result") {
        expect(toolResult.toolCallId).toBe("toolu_01AAAAAAAAAAAAAAAAAAAAAA");
        expect(toolResult.status).toBe("success");
      }
      const errorResult = records[8]!;
      if (errorResult.type === "tool_result") {
        expect(errorResult.status).toBe("error");
        expect(errorResult.content).toBe("Error: ENOENT: no such file or directory");
      }
    });

    it("derives tool_call status from the paired tool_result (AC-0002-N-6)", async () => {
      const records = await readAll(adapter, SESSION_A);
      const bash = records[4]!;
      if (bash.type === "tool_call") expect(bash.status).toBe("completed");
      const read = records[7]!;
      if (read.type === "tool_call") expect(read.status).toBe("failed");
    });

    it("keeps coarse usage and drops fine tiers (AC-0002-N-4)", async () => {
      const records = await readAll(adapter, SESSION_A);
      expect(sumUsage(records)).toEqual({
        inputTokens: 6700,
        outputTokens: 130,
        cacheReadTokens: 2300,
        cacheWriteTokens: 300,
      });
      const assistant = records[3]!;
      expect(assistant.usage).toEqual({
        inputTokens: 1200,
        outputTokens: 45,
        cacheReadTokens: 0,
        cacheWriteTokens: 300,
      });
    });

    it("assigns seq in emission order, strictly increasing and contiguous (AC-0002-N-1)", async () => {
      const records = await readAll(adapter, SESSION_A);
      expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });

  describe("session with subagent file (fixture B)", () => {
    it("maps the current ai-title line to Manifest.title (generated)", async () => {
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_B)!.manifest;
      expect(manifest.title).toBe("Refactor parser for nested generics");
      expect(manifest.titleOrigin).toBe("generated");
    });

    it("emits the subagent as a child session with an anchored invocation back-link (AC-0002-N-2)", async () => {
      const sessions = await collectSessions(adapter);
      const child = sessions.find((s) => s.manifest.sessionId === "abc123")!.manifest;
      // Back-link anchored at the parent's spawning Task tool_call record
      // (meta.json toolUseId → tool_call with that toolCallId).
      expect(child.invocation).toEqual({
        sessionId: SESSION_B,
        atRecordId: "bbbb0002-0000-4000-8000-000000000002/tool_use/0",
      });
    });

    it("writes the forward link into the parent's paired tool_result (AC-0002-N-2)", async () => {
      const main = await readAll(adapter, SESSION_B);
      const result = main.find(
        (r) => r.type === "tool_result" && r.toolCallId === "toolu_task01AAAAAAAAAAAAAAAAAA",
      )!;
      expect(result.type).toBe("tool_result");
      if (result.type === "tool_result") {
        expect(result.recordId).toBe("bbbb0003-0000-4000-8000-000000000003");
        expect(result.sessionId).toBe("abc123");
      }
      // No other record carries a forward link.
      expect(
        main.filter((r) => r.type === "tool_result" && r.sessionId !== undefined),
      ).toHaveLength(1);
    });

    it("keeps the Task tool_call in the main session; sidechain records stay out of the main session", async () => {
      const main = await readAll(adapter, SESSION_B);
      expect(main.map((r) => r.type)).toEqual([
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
      const taskCall = main.find((r) => r.type === "tool_call")!;
      if (taskCall.type === "tool_call") {
        expect(taskCall.name).toBe("Task");
        expect(taskCall.toolCallId).toBe("toolu_task01AAAAAAAAAAAAAAAAAA");
      }
      expect(main.some((r) => r.recordId.startsWith("cccc"))).toBe(false);
    });

    it("gives the child session its own linear record chain with its own usage", async () => {
      const child = await readAll(adapter, "abc123");
      expect(child.map((r) => r.type)).toEqual([
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
      expect(child[0]!.seq).toBe(0);
      expect(sumUsage(child)).toEqual({
        inputTokens: 2400,
        outputTokens: 150,
        cacheReadTokens: 400,
        cacheWriteTokens: 200,
      });
    });
  });

  describe("inline sidechain + compaction (fixture C)", () => {
    it("groups inline isSidechain records by agentId into a child session (sourceToolUseID anchor)", async () => {
      const child = await readAll(adapter, "def456");
      expect(child.map((r) => r.type)).toEqual(["user_message", "assistant_message"]);
      expect(child[0]!.seq).toBe(0);

      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === "def456")!.manifest;
      // No meta.json for inline groups: the anchor falls back to the first
      // line's sourceToolUseID.
      expect(manifest.invocation).toEqual({
        sessionId: SESSION_C,
        atRecordId: "dddd0003-0000-4000-8000-000000000003/tool_use/0",
      });

      // Forward link on the paired (first, non-duplicate) tool_result.
      const main = await readAll(adapter, SESSION_C);
      const result = main.find(
        (r) => r.type === "tool_result" && r.toolCallId === "toolu_task02AAAAAAAAAAAAAAAAAA",
      )!;
      if (result.type === "tool_result") {
        expect(result.recordId).toBe("dddd0006-0000-4000-8000-000000000006");
        expect(result.sessionId).toBe("def456");
      }
    });

    it("excludes inline sidechain records from the main session", async () => {
      const main = await readAll(adapter, SESSION_C);
      expect(
        main.some(
          (r) => r.recordId.startsWith("dddd0004") || r.recordId.startsWith("dddd0005"),
        ),
      ).toBe(false);
    });

    it("maps isCompactSummary user records to compaction records", async () => {
      const main = await readAll(adapter, SESSION_C);
      const first = main[0]!;
      expect(first.type).toBe("compaction");
      if (first.type === "compaction") {
        expect(first.summary).toBe(
          "This session is being continued from a previous conversation that ran out of context. The parser refactor was in progress.",
        );
      }
      expect(main.map((r) => r.type)).toEqual([
        "compaction",
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "assistant_message",
        "assistant_message",
        "tool_call", // no result in the source — session ends mid-turn
      ]);
    });

    it("keeps the first of duplicate tool_results and drops later ones (AC-0002-N-6)", async () => {
      const main = await readAll(adapter, SESSION_C);
      const results = main.filter(
        (r) => r.type === "tool_result" && r.toolCallId === "toolu_task02AAAAAAAAAAAAAAAAAA",
      );
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results[0])).not.toMatch(/resubmit duplicate/);
    });

    it("marks a tool_call without a paired result as interrupted, no synthetic result (AC-0002-B-1)", async () => {
      const main = await readAll(adapter, SESSION_C);
      const completed = main.find(
        (r) => r.type === "tool_call" && r.toolCallId === "toolu_task02AAAAAAAAAAAAAAAAAA",
      )!;
      if (completed.type === "tool_call") expect(completed.status).toBe("completed");

      const last = main[main.length - 1]!;
      expect(last.type).toBe("tool_call");
      if (last.type === "tool_call") {
        expect(last.toolCallId).toBe("toolu_task03AAAAAAAAAAAAAAAAAA");
        expect(last.status).toBe("interrupted");
      }
      expect(
        main.some(
          (r) => r.type === "tool_result" && r.toolCallId === "toolu_task03AAAAAAAAAAAAAAAAAA",
        ),
      ).toBe(false);
    });
  });

  describe("fork synthesis (fixture F, AC-0002-N-7)", () => {
    it("main chain = the chain leading to the last leaf (edit-resend branch wins by file order)", async () => {
      const main = await readAll(adapter, SESSION_F);
      expect(main.map((r) => r.recordId)).toEqual([
        "eeee0001-0000-4000-8000-000000000001",
        "eeee0002-0000-4000-8000-000000000002",
        "eeee0005-0000-4000-8000-000000000005", // edited resubmit, not the original eeee0003
        "eeee0006-0000-4000-8000-000000000006",
        "eeee0006-0000-4000-8000-000000000006/tool_use/0",
        "eeee0007-0000-4000-8000-000000000007",
        "eeee0008-0000-4000-8000-000000000008",
        "eeee0009-0000-4000-8000-000000000009",
        "eeee0011-0000-4000-8000-000000000011", // the retry's later answer
      ]);
      expect(main.map((r) => r.seq)).toEqual(main.map((_, i) => i));
      // The main session carries no lineage and no fork content.
      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === SESSION_F)!.manifest;
      expect(manifest.lineage).toBeUndefined();
      expect(manifest.stats?.turnCount).toBe(3);
    });

    it("edit-resend branch becomes a forked_from session anchored at the assistant record", async () => {
      const sessions = await collectSessions(adapter);
      const fork = sessions.find((s) => s.manifest.sessionId === FORK_EDIT)!;
      expect(fork.manifest.lineage).toEqual({
        type: "forked_from", // anchor is an assistant_message (agent-side)
        sessionId: SESSION_F,
        atRecordId: "eeee0002-0000-4000-8000-000000000002",
      });
      // Suffix only: the fork starts at the branch child, no shared prefix.
      expect(fork.records.map((r) => r.type)).toEqual(["user_message", "assistant_message"]);
      expect(fork.records.map((r) => r.recordId)).toEqual([
        "eeee0003-0000-4000-8000-000000000003",
        "eeee0004-0000-4000-8000-000000000004",
      ]);
      expect(fork.records[0]!.seq).toBe(0);
    });

    it("re-answer to the same prompt becomes a sibling_attempt anchored at the user_message", async () => {
      const sessions = await collectSessions(adapter);
      const fork = sessions.find((s) => s.manifest.sessionId === FORK_RETRY)!;
      expect(fork.manifest.lineage).toEqual({
        type: "sibling_attempt", // anchor is a user_message
        sessionId: SESSION_F,
        atRecordId: "eeee0009-0000-4000-8000-000000000009",
      });
      expect(fork.records.map((r) => r.type)).toEqual(["assistant_message"]);
      expect(fork.records[0]!.recordId).toBe("eeee0010-0000-4000-8000-000000000010");
      // The competing answer is NOT in the main session.
      const main = await readAll(adapter, SESSION_F);
      expect(main.some((r) => r.recordId.startsWith("eeee0010"))).toBe(false);
    });

    it("readRecords resolves fork session ids", async () => {
      const records = await readAll(adapter, FORK_EDIT);
      expect(records.map((r) => r.type)).toEqual(["user_message", "assistant_message"]);
      const retry = await readAll(adapter, FORK_RETRY);
      expect(retry).toHaveLength(1);
    });
  });

  describe("segment chaining + parallel deliveries (fixture G)", () => {
    it("chains assistant segments sharing one message.id in file order — no fork", async () => {
      const records = await readAll(adapter, SESSION_G);
      // Two segments of one logical assistant message (same message.id, both
      // parented at the user line): thinking segment, then text+tool_use
      // segment. They chain in file order; nothing is collapsed or dropped.
      expect(records.map((r) => r.type)).toEqual([
        "user_message",
        "assistant_message", // segment 1: thinking only
        "assistant_message", // segment 2: text
        "tool_call",
        "tool_call",
        "tool_result",
        "tool_result",
        "assistant_message",
      ]);
      const seg1 = records[1]!;
      expect(seg1.recordId).toBe("ffff0002-0000-4000-8000-000000000002");
      if (seg1.type === "assistant_message") {
        expect(seg1.content.map((b) => b.type)).toEqual(["thinking"]);
        // Intermediate segment: usage is a duplicate running value — dropped;
        // only the last segment of the message.id carries usage.
        expect(seg1.usage).toBeUndefined();
      }
      const seg2 = records[2]!;
      expect(seg2.recordId).toBe("ffff0003-0000-4000-8000-000000000003");
      if (seg2.type === "assistant_message") {
        expect(seg2.content.map((b) => b.type)).toEqual(["text"]);
        expect(seg2.usage).toEqual({
          inputTokens: 2100,
          outputTokens: 90,
          cacheReadTokens: 0,
          cacheWriteTokens: 500,
        });
      }
      // No fork sessions exist for this file.
      const sessions = await collectSessions(adapter);
      expect(
        sessions.filter((s) => s.manifest.sessionId.startsWith(`${SESSION_G}/fork/`)),
      ).toEqual([]);
    });

    it("keeps parallel result deliveries (separate user lines, distinct toolCallIds) in one chain", async () => {
      const records = await readAll(adapter, SESSION_G);
      const results = records.filter((r) => r.type === "tool_result");
      expect(results.map((r) => (r.type === "tool_result" ? r.toolCallId : ""))).toEqual([
        "toolu_par01AAAAAAAAAAAAAAAAAAA",
        "toolu_par02AAAAAAAAAAAAAAAAAAA",
      ]);
      // The exact duplicate delivery (ffff0006) emits nothing: par01 appears once.
      expect(
        records.filter((r) => r.type === "tool_result" && r.toolCallId === "toolu_par01AAAAAAAAAAAAAAAAAAA"),
      ).toHaveLength(1);
      const calls = records.filter((r) => r.type === "tool_call");
      for (const call of calls) {
        if (call.type === "tool_call") {
          expect(call.status).toBe(call.toolCallId.endsWith("par02AAAAAAAAAAAAAAAAAAA") ? "failed" : "completed");
        }
      }
    });

    it("falls back to an unanchored invocation when meta.toolUseId resolves nowhere (AC-0002-B-3)", async () => {
      const sessions = await collectSessions(adapter);
      const child = sessions.find((s) => s.manifest.sessionId === "ghi789")!.manifest;
      expect(child.invocation).toEqual({ sessionId: SESSION_G });
      // No forward link is written for an unanchored child.
      const main = await readAll(adapter, SESSION_G);
      expect(main.some((r) => r.type === "tool_result" && r.sessionId !== undefined)).toBe(false);
    });
  });

  describe("storage edge cases", () => {
    it("yields nothing when the base path does not exist", async () => {
      const missing = new ClaudeCodeAdapter(path.join(fixturesDir, "no-such-base"));
      const sessions = await collectSessions(missing);
      expect(sessions).toEqual([]);
    });

    it("maps a goal verdict with met:false to goal_update unmet", async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), "claude-code-unmet-"));
      afterAll(() => rmSync(tmp, { recursive: true, force: true }));
      const projectDir = path.join(tmp, "-Users-test-Project-unmet");
      mkdirSync(projectDir, { recursive: true });
      const sid = "66666666-6666-4666-8666-666666666666";
      const lines = [
        { parentUuid: null, isSidechain: false, promptId: "p1", type: "user",
          message: { role: "user", content: "Try the impossible task." },
          uuid: "f0000001-0000-4000-8000-000000000001",
          timestamp: "2026-07-19T09:00:00.000Z", userType: "external",
          entrypoint: "cli", cwd: "/Users/test/Project/unmet", sessionId: sid,
          version: "2.1.206", gitBranch: "main" },
        { parentUuid: "f0000001-0000-4000-8000-000000000001", isSidechain: false,
          attachment: { type: "goal_status", met: false,
            condition: "Try the impossible task.",
            reason: "The task could not be completed within the iteration budget.",
            iterations: 3 },
          type: "attachment", uuid: "f0000002-0000-4000-8000-000000000002",
          timestamp: "2026-07-19T09:05:00.000Z", userType: "external",
          entrypoint: "cli", cwd: "/Users/test/Project/unmet", sessionId: sid,
          version: "2.1.206", gitBranch: "main" },
      ];
      writeFileSync(
        path.join(projectDir, `${sid}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );

      const unmetAdapter = new ClaudeCodeAdapter(tmp);
      const records = await readAll(unmetAdapter, sid);
      const verdict = records[records.length - 1]!;
      expect(verdict.type).toBe("goal_update");
      if (verdict.type === "goal_update") {
        expect(verdict.status).toBe("unmet");
        expect(verdict.reason).toBe(
          "The task could not be completed within the iteration budget.",
        );
      }
    });
  });
});
