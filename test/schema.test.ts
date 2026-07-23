import { describe, expect, it } from "vitest";
import {
  AhsRecordSchema,
  InvocationSchema,
  LineageSchema,
  ManifestSchema,
  type AhsRecord,
} from "../src/schema";

const base = {
  recordId: "r1",
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
      lineage: { type: "forked_from", sessionId: "parent-1", atRecordId: "r7" },
      invocation: { sessionId: "parent-1", atRecordId: "r9" },
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
    { ...base, type: "tool_result", toolCallId: "tc1", content: "ok", status: "success" },
    {
      ...base,
      type: "tool_result",
      toolCallId: "tc1",
      content: "done",
      sessionId: "child-session-1",
    },
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

  it("rejects an unknown record type", () => {
    const bad = { ...base, type: "thinking" };
    expect(AhsRecordSchema.safeParse(bad).success).toBe(false);
  });
});

describe("lineage / invocation", () => {
  it("parses a forked_from lineage with anchor", () => {
    const lin = { type: "forked_from", sessionId: "parent-1", atRecordId: "r7" };
    expect(LineageSchema.parse(lin)).toEqual(lin);
  });

  it("parses a sibling_attempt lineage without anchor (retry from start)", () => {
    const lin = { type: "sibling_attempt", sessionId: "root-1" };
    expect(LineageSchema.parse(lin)).toEqual(lin);
  });

  it("rejects an unknown lineage type", () => {
    expect(LineageSchema.safeParse({ type: "spawned_by", sessionId: "x" }).success).toBe(false);
  });

  it("parses an invocation with and without anchor", () => {
    const anchored = { sessionId: "parent-1", atRecordId: "r9" };
    expect(InvocationSchema.parse(anchored)).toEqual(anchored);
    const bare = { sessionId: "parent-1" };
    expect(InvocationSchema.parse(bare)).toEqual(bare);
  });
});

// Type-level smoke check: the inferred union narrows on `type`.
const record: AhsRecord = { ...base, type: "compaction" };
void record;
