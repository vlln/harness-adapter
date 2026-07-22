import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import type { Usage } from "../src/schema/usage";
import {
  checkIdempotency,
  collectSessions,
  validateSessions,
} from "../src/validate/index";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "claude-code",
);

const SESSION_A = "11111111-1111-4111-8111-111111111111"; // minimal main session
const SESSION_B = "22222222-2222-4222-8222-222222222222"; // with subagent file
const SESSION_C = "33333333-3333-4333-8333-333333333333"; // inline sidechain + compaction

async function readAll(adapter: ClaudeCodeAdapter, sessionId: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId)) records.push(rec);
  return records;
}

function sumUsage(records: AhsRecord[]): Required<Omit<Usage, "cost" | "durationMs" | "reasoningTokens">> {
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

  it("lists main sessions and child sessions (subagent file + inline sidechain)", async () => {
    const sessions = await collectSessions(adapter);
    const ids = sessions.map((s) => s.manifest.sessionId).sort();
    expect(ids).toEqual([SESSION_A, SESSION_B, SESSION_C, "abc123", "def456"].sort());
  });

  describe("minimal session (fixture A)", () => {
    it("maps manifest fields from the source", async () => {
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
      expect(manifest.relation).toBeUndefined();
      expect(manifest.stats?.turnCount).toBe(2); // two string-content user prompts
      expect(manifest.stats?.totalUsage).toEqual({
        inputTokens: 6700,
        outputTokens: 130,
        cacheReadTokens: 2300,
        cacheWriteTokens: 300,
      });
    });

    it("projects records with message counts equal to the source", async () => {
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

    it("maps goal_status attachments to goal_update records", async () => {
      const records = await readAll(adapter, SESSION_A);
      const initial = records[0]!;
      expect(initial.type).toBe("goal_update");
      if (initial.type === "goal_update") {
        expect(initial.status).toBe("pending"); // sentinel: goal registered, no verdict yet
        expect(initial.reason).toBeUndefined();
        expect(initial.goalId).toBeUndefined();
        expect(initial.parentId).toBeNull(); // session root
      }
      const final = records[10]!;
      expect(final.type).toBe("goal_update");
      if (final.type === "goal_update") {
        expect(final.status).toBe("met");
        expect(final.reason).toBe(
          "The flaky timing wait was replaced with an explicit event await.",
        );
        expect(final.parentId).toBe("aaaa0008-0000-4000-8000-000000000008");
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

    it("splits tool_use blocks into tool_call records chained off the assistant record", async () => {
      const records = await readAll(adapter, SESSION_A);
      const toolCall = records[4]!;
      if (toolCall.type === "tool_call") {
        expect(toolCall.toolCallId).toBe("toolu_01AAAAAAAAAAAAAAAAAAAAAA");
        expect(toolCall.name).toBe("Bash");
        expect(toolCall.args).toEqual({
          command: "npx vitest run test/login.test.ts",
          description: "Run the login test",
        });
        // parents to the assistant record of the same source message
        expect(toolCall.parentId).toBe("aaaa0004-0000-4000-8000-000000000004");
      }
      // next record parents to the LAST record emitted by the previous message
      const toolResult = records[5]!;
      if (toolResult.type === "tool_result") {
        expect(toolResult.toolCallId).toBe("toolu_01AAAAAAAAAAAAAAAAAAAAAA");
        expect(toolResult.status).toBe("success");
        expect(toolResult.parentId).toBe(toolCall.recordId);
      }
      // error tool_result keeps status
      const errorResult = records[8]!;
      if (errorResult.type === "tool_result") {
        expect(errorResult.status).toBe("error");
        expect(errorResult.content).toBe("Error: ENOENT: no such file or directory");
      }
    });

    it("derives tool_call status from the paired tool_result", async () => {
      const records = await readAll(adapter, SESSION_A);
      const bash = records[4]!;
      if (bash.type === "tool_call") expect(bash.status).toBe("completed");
      const read = records[7]!;
      if (read.type === "tool_call") expect(read.status).toBe("failed");
    });

    it("keeps coarse usage and drops fine tiers", async () => {
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
      // no schema-side trace of dropped fine tiers
      expect(JSON.stringify(assistant.usage)).not.toMatch(/ephemeral|service_tier|inference_geo|server_tool_use/);
    });

    it("assigns seq in emission order and keeps causal chain connected", async () => {
      const records = await readAll(adapter, SESSION_A);
      expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(records[0]!.parentId).toBeNull();
      for (let i = 1; i < records.length; i += 1) {
        const parentId = records[i]!.parentId!;
        expect(records.slice(0, i).some((r) => r.recordId === parentId)).toBe(true);
      }
    });
  });

  describe("session with subagent (fixture B)", () => {
    it("emits the subagent as a child session with a spawned_by relation anchored to the Task call", async () => {
      const sessions = await collectSessions(adapter);
      const child = sessions.find((s) => s.manifest.sessionId === "abc123")!.manifest;
      expect(child.relation).toEqual({
        type: "spawned_by",
        sessionId: SESSION_B,
        toolCallId: "toolu_task01AAAAAAAAAAAAAAAAAA",
      });
    });

    it("keeps the Task tool_call in the main session; sidechain records stay out of the main tree", async () => {
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

    it("gives the child session its own rooted record tree", async () => {
      const child = await readAll(adapter, "abc123");
      expect(child.map((r) => r.type)).toEqual([
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
      expect(child[0]!.parentId).toBeNull();
      expect(sumUsage(child)).toEqual({
        inputTokens: 2400,
        outputTokens: 150,
        cacheReadTokens: 400,
        cacheWriteTokens: 200,
      });
    });
  });

  describe("inline sidechain + compaction (fixture C)", () => {
    it("groups inline isSidechain records by agentId into a child session", async () => {
      const child = await readAll(adapter, "def456");
      expect(child.map((r) => r.type)).toEqual(["user_message", "assistant_message"]);
      expect(child[0]!.parentId).toBeNull();

      const sessions = await collectSessions(adapter);
      const manifest = sessions.find((s) => s.manifest.sessionId === "def456")!.manifest;
      // no meta.json: toolCallId falls back to the record's sourceToolUseID
      expect(manifest.relation).toEqual({
        type: "spawned_by",
        sessionId: SESSION_C,
        toolCallId: "toolu_task02AAAAAAAAAAAAAAAAAA",
      });
    });

    it("excludes inline sidechain records from the main tree", async () => {
      const main = await readAll(adapter, SESSION_C);
      expect(main.some((r) => r.recordId.startsWith("dddd0004") || r.recordId.startsWith("dddd0005"))).toBe(false);
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

    it("keeps the first of duplicate tool_results and drops later ones", async () => {
      const main = await readAll(adapter, SESSION_C);
      const results = main.filter(
        (r) => r.type === "tool_result" && r.toolCallId === "toolu_task02AAAAAAAAAAAAAAAAAA",
      );
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results[0])).not.toMatch(/resubmit duplicate/);
    });

    it("marks a tool_call without a paired result as interrupted, without synthesizing a result", async () => {
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
        main.some((r) => r.type === "tool_result" && r.toolCallId === "toolu_task03AAAAAAAAAAAAAAAAAA"),
      ).toBe(false);
    });
  });
});
