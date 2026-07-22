import { describe, expect, it } from "vitest";
import {
  AhsRecordSchema,
  ManifestSchema,
  RelationSchema,
  type AhsRecord,
} from "../src/schema";

const base = {
  recordId: "r1",
  parentId: null,
  seq: 0,
  timestamp: "2026-07-21T10:00:00Z",
};

describe("Manifest", () => {
  it("parses a valid manifest", () => {
    const manifest = {
      sessionId: "01J2EXAMPLEULID",
      harness: "claude-code",
      harnessVersion: "1.0.0",
      ahsVersion: "0.1.0",
      cwd: "/Users/x/project",
      workspaceRoots: ["/Users/x/project"],
      git: { branch: "main", commit: "abc123", repoUrl: "git@github.com:x/y.git" },
      model: "claude-sonnet-4",
      provider: "anthropic",
      title: "Fix login bug",
      titleOrigin: "generated",
      isMainChain: true,
      acpBinding: { agentId: "claude", sessionId: "native-id" },
      stats: {
        totalUsage: { inputTokens: 100, outputTokens: 50, cost: { amount: 0.01, currency: "USD" } },
        turnCount: 3,
        durationMs: 1200,
      },
    };
    expect(ManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("parses a minimal manifest", () => {
    const minimal = {
      sessionId: "s1",
      harness: "codex",
      harnessVersion: "0.1.0",
      ahsVersion: "0.1.0",
      cwd: "/tmp",
      model: "gpt-5",
    };
    expect(ManifestSchema.parse(minimal).sessionId).toBe("s1");
  });
});

describe("records", () => {
  const valid: Record<string, unknown>[] = [
    { ...base, type: "user_message", content: [{ type: "text", text: "hi" }] },
    {
      ...base,
      type: "harness_message",
      content: [{ type: "text", text: "Background task completed: npm test" }],
    },
    {
      ...base,
      type: "assistant_message",
      content: [
        { type: "thinking", text: "hmm" },
        { type: "text", text: "hello" },
      ],
      model: "claude-sonnet-4",
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, durationMs: 100 },
    },
    { ...base, type: "tool_call", toolCallId: "tc1", name: "Bash", args: { command: "ls" } },
    { ...base, type: "tool_call", toolCallId: "tc1", name: "Bash", args: {}, kind: "shell" },
    { ...base, type: "tool_call", toolCallId: "tc1", name: "Bash", args: {}, status: "completed" },
    { ...base, type: "tool_call", toolCallId: "tc1", name: "Bash", args: {}, status: "failed" },
    { ...base, type: "tool_call", toolCallId: "tc1", name: "Bash", args: {}, status: "interrupted" },
    { ...base, type: "tool_result", toolCallId: "tc1", content: "ok", status: "success" },
    {
      ...base,
      type: "tool_result",
      toolCallId: "tc1",
      content: { type: "blob_ref", sha256: "deadbeef", mediaType: "text/plain", byteLength: 70000, preview: "..." },
    },
    { ...base, type: "turn_boundary", phase: "start", turnId: "t1" },
    { ...base, type: "turn_boundary", phase: "end" },
    { ...base, type: "model_change", model: "gpt-5", provider: "openai" },
    { ...base, type: "compaction", summary: "context summarized" },
    { ...base, type: "compaction" },
    { ...base, type: "goal_update", status: "met", reason: "greeting contained hello" },
    { ...base, type: "goal_update", goalId: "goal-1", status: "unmet" },
    { ...base, type: "goal_update", status: "pending" },
  ];

  it.each(valid)("parses a valid $type record", (record) => {
    expect(AhsRecordSchema.parse(record)).toEqual(record);
  });

  it("rejects a record with a bad timestamp", () => {
    const bad = { ...base, type: "user_message", content: [], timestamp: "not-a-date" };
    expect(AhsRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a tool_result without toolCallId", () => {
    const bad = { ...base, type: "tool_result", content: "ok" };
    expect(AhsRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a goal_update without status", () => {
    const bad = { ...base, type: "goal_update", reason: "no status" };
    expect(AhsRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a goal_update with a status outside the closed enum", () => {
    const bad = { ...base, type: "goal_update", status: "in-progress" };
    expect(AhsRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a tool_call with an unknown status", () => {
    const bad = { ...base, type: "tool_call", toolCallId: "tc1", name: "Bash", args: {}, status: "crashed" };
    expect(AhsRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown record type", () => {
    const bad = { ...base, type: "thinking" };
    expect(AhsRecordSchema.safeParse(bad).success).toBe(false);
  });
});

describe("relation", () => {
  it("parses a spawned_by relation with anchor", () => {
    const rel = { type: "spawned_by", sessionId: "parent-1", toolCallId: "tc-9" };
    expect(RelationSchema.parse(rel)).toEqual(rel);
  });

  it("parses a sibling_attempt relation without toolCallId", () => {
    const rel = { type: "sibling_attempt", sessionId: "root-1" };
    expect(RelationSchema.parse(rel)).toEqual(rel);
  });

  it("rejects an unknown relation type", () => {
    expect(RelationSchema.safeParse({ type: "child_of", sessionId: "x" }).success).toBe(false);
  });
});

// Type-level smoke check: the inferred union narrows on `type`.
const record: AhsRecord = { ...base, type: "compaction" };
void record;
