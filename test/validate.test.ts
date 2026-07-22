/**
 * AC layer-2 invariant checker tests (AC-0002) over hand-built sessions.
 */

import { describe, expect, it } from "vitest";

import {
  checkIdempotency,
  collectSessions,
  stableSerialize,
  validateSessions,
} from "../src/validate/index";
import type { HarnessAdapter } from "../src/store/adapter";
import {
  assistantMessage,
  fakeAdapter,
  makeManifest,
  makeSession,
  toolCall,
  toolResult,
  userMessage,
} from "./builders";

describe("AC-0002-N-1 causal completeness (tree shape)", () => {
  it("passes a single-rooted session with resolving parents and increasing seq", () => {
    const session = makeSession("sess-1", [
      userMessage(0, null, "go"),
      assistantMessage(1, "r0", "working"),
      toolCall(2, "r1", "tc1"),
      toolResult(3, "r2", "tc1", "ok"),
    ]);
    expect(validateSessions([session])).toEqual([]);
  });

  it("flags zero or multiple root records (single-root)", () => {
    const twoRoots = makeSession("sess-1", [
      userMessage(0, null, "a"),
      userMessage(1, null, "b"),
    ]);
    const errors = validateSessions([twoRoots]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "single-root", sessionId: "sess-1" });

    const noRoots = makeSession("sess-1", [
      userMessage(0, "ghost", "a"),
      assistantMessage(1, "r0", "b"),
    ]);
    expect(validateSessions([noRoots]).map((e) => e.code)).toContain("single-root");
  });

  it("flags a dangling parentId (parent-resolution)", () => {
    const session = makeSession("sess-1", [
      userMessage(0, null, "a"),
      assistantMessage(1, "no-such-record", "b"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("parent-resolution");
  });

  it("flags non-monotonic seq (seq-order)", () => {
    const session = makeSession("sess-1", [
      userMessage(0, null, "a"),
      { ...assistantMessage(1, "r0", "b"), seq: 0 },
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("seq-order");
  });
});

describe("AC-0002-N-2 relation completeness (spawned_by anchors)", () => {
  const parent = makeSession("parent", [
    userMessage(0, null, "go"),
    toolCall(1, "r0", "tc-task", { name: "Task" }),
    toolResult(2, "r1", "tc-task", "done"),
  ]);

  it("passes when the parent session and the tool_call anchor exist", () => {
    const child = makeSession("child", undefined, {
      relation: { type: "spawned_by", sessionId: "parent", toolCallId: "tc-task" },
    });
    expect(validateSessions([parent, child])).toEqual([]);
  });

  it("passes when toolCallId is omitted (AC-0002-B-3: agent-level link only)", () => {
    const child = makeSession("child", undefined, {
      relation: { type: "spawned_by", sessionId: "parent" },
    });
    expect(validateSessions([parent, child])).toEqual([]);
  });

  it("flags a relation pointing at an unknown session (relation-session)", () => {
    const child = makeSession("child", undefined, {
      relation: { type: "spawned_by", sessionId: "ghost-parent", toolCallId: "tc-task" },
    });
    const errors = validateSessions([parent, child]);
    expect(errors.map((e) => e.code)).toContain("relation-session");
  });

  it("flags a toolCallId anchor matching no tool_call in the parent (relation-anchor)", () => {
    const child = makeSession("child", undefined, {
      relation: { type: "spawned_by", sessionId: "parent", toolCallId: "tc-missing" },
    });
    const errors = validateSessions([parent, child]);
    expect(errors.map((e) => e.code)).toContain("relation-anchor");
  });
});

describe("AC-0002-N-6 tool pairing (XOR: paired result | interrupted)", () => {
  const wrap = (middle: Parameters<typeof makeSession>[1]) =>
    makeSession("sess-1", [userMessage(0, null, "go"), ...(middle ?? [])]);

  it("case 1: tool_call with exactly one paired tool_result passes", () => {
    const session = wrap([toolCall(1, "r0", "tc1"), toolResult(2, "r1", "tc1", "ok")]);
    expect(validateSessions([session])).toEqual([]);
  });

  it("case 2: interrupted tool_call with no tool_result passes (AC-0002-B-1)", () => {
    const session = wrap([toolCall(1, "r0", "tc1", { status: "interrupted" })]);
    expect(validateSessions([session])).toEqual([]);
  });

  it("case 3: tool_call with no result and not interrupted is flagged", () => {
    const session = wrap([toolCall(1, "r0", "tc1")]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("case 4: interrupted tool_call that still has a paired result is flagged", () => {
    const session = wrap([
      toolCall(1, "r0", "tc1", { status: "interrupted" }),
      toolResult(2, "r1", "tc1", "ok"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("flags a tool_call with multiple results (adapter must keep file-order first only)", () => {
    const session = wrap([
      toolCall(1, "r0", "tc1"),
      toolResult(2, "r1", "tc1", "first"),
      toolResult(3, "r2", "tc1", "second"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("flags a tool_result matching no tool_call", () => {
    const session = wrap([toolCall(1, "r0", "tc1", { status: "interrupted" }), toolResult(2, "r1", "tc-orphan", "ok")]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });
});

describe("AC-0002-N-5 idempotency helper", () => {
  it("passes when two runs over the same input are byte-identical", async () => {
    const adapter = fakeAdapter([
      makeSession("sess-1", [userMessage(0, null, "go"), assistantMessage(1, "r0", "ok")]),
    ]);
    expect(await checkIdempotency(adapter)).toEqual([]);
  });

  it("flags an adapter whose output changes between runs", async () => {
    let run = 0;
    const flaky: HarnessAdapter = {
      harness: "fake",
      capabilities: { history: "full", control: false },
      async *listSessions() {
        run += 1;
        yield makeManifest({ sessionId: "sess-1", title: `run-${run}` });
      },
      async *readRecords() {
        yield userMessage(0, null, "go");
      },
    };
    const errors = await checkIdempotency(flaky);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "not-idempotent" });
  });

  it("stableSerialize is key-order independent", () => {
    expect(stableSerialize({ b: 1, a: { d: [2, 1], c: 3 } })).toBe(
      stableSerialize({ a: { c: 3, d: [2, 1] }, b: 1 }),
    );
  });

  it("collectSessions gathers manifests and records from the adapter", async () => {
    const adapter = fakeAdapter([
      makeSession("sess-1"),
      makeSession("sess-2", [userMessage(0, null, "second")]),
    ]);
    const collected = await collectSessions(adapter);
    expect(collected.map((s) => s.manifest.sessionId)).toEqual(["sess-1", "sess-2"]);
    expect(collected[1]?.records[0]).toMatchObject({ type: "user_message" });
  });
});
