/**
 * AC layer-2 invariant checker tests (AC-0002 v2, linear-session model)
 * over hand-built sessions.
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

describe("AC-0002-N-1 linear shape (seq strictly increasing and contiguous)", () => {
  it("passes a linear session with contiguous seq", () => {
    const session = makeSession("sess-1", [
      userMessage(0, "go"),
      assistantMessage(1, "working"),
      toolCall(2, "tc1"),
      toolResult(3, "tc1", "ok"),
    ]);
    expect(validateSessions([session])).toEqual([]);
  });

  it("flags non-monotonic seq (seq-order)", () => {
    const session = makeSession("sess-1", [
      userMessage(0, "a"),
      { ...assistantMessage(1, "b"), seq: 0 },
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("seq-order");
  });

  it("flags a seq gap (not contiguous)", () => {
    const session = makeSession("sess-1", [
      userMessage(0, "a"),
      { ...assistantMessage(1, "b"), seq: 2 },
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("seq-order");
  });
});

describe("AC-0002-N-2 invocation completeness (forward/back-link reconciliation)", () => {
  const parent = makeSession("parent", [
    userMessage(0, "go"),
    toolCall(1, "tc-task", { name: "Task", recordId: "p-call" }),
    toolResult(2, "tc-task", "done", { recordId: "p-result", sessionId: "child" }),
  ]);

  it("passes when the parent, tool_call anchor and forward link reconcile", () => {
    const child = makeSession("child", undefined, {
      invocation: { sessionId: "parent", atRecordId: "p-call" },
    });
    expect(validateSessions([parent, child])).toEqual([]);
  });

  it("passes when atRecordId is omitted (AC-0002-B-3: agent-level link only)", () => {
    const child = makeSession("child", undefined, {
      invocation: { sessionId: "parent" },
    });
    expect(validateSessions([parent, child])).toEqual([]);
  });

  it("flags an invocation pointing at an unknown session (invocation-session)", () => {
    const child = makeSession("child", undefined, {
      invocation: { sessionId: "ghost-parent", atRecordId: "p-call" },
    });
    const errors = validateSessions([parent, child]);
    expect(errors.map((e) => e.code)).toContain("invocation-session");
  });

  it("flags an atRecordId resolving to no tool_call in the parent (invocation-anchor)", () => {
    const missing = makeSession("child", undefined, {
      invocation: { sessionId: "parent", atRecordId: "no-such-record" },
    });
    expect(validateSessions([parent, missing]).map((e) => e.code)).toContain(
      "invocation-anchor",
    );

    // Anchored at a non-tool_call record is equally invalid.
    const wrongType = makeSession("child", undefined, {
      invocation: { sessionId: "parent", atRecordId: "p-result" },
    });
    expect(validateSessions([parent, wrongType]).map((e) => e.code)).toContain(
      "invocation-anchor",
    );
  });

  it("flags a forward link that does not point back at the child (invocation-mismatch)", () => {
    const badParent = makeSession("parent", [
      userMessage(0, "go"),
      toolCall(1, "tc-task", { name: "Task", recordId: "p-call" }),
      toolResult(2, "tc-task", "done", { recordId: "p-result" }), // no sessionId forward link
    ]);
    const child = makeSession("child", undefined, {
      invocation: { sessionId: "parent", atRecordId: "p-call" },
    });
    const errors = validateSessions([badParent, child]);
    expect(errors.map((e) => e.code)).toContain("invocation-mismatch");

    const wrongTarget = makeSession("parent", [
      userMessage(0, "go"),
      toolCall(1, "tc-task", { name: "Task", recordId: "p-call" }),
      toolResult(2, "tc-task", "done", { recordId: "p-result", sessionId: "other-child" }),
    ]);
    expect(validateSessions([wrongTarget, child]).map((e) => e.code)).toContain(
      "invocation-mismatch",
    );
  });
});

describe("AC-0002-N-7 lineage completeness (anchor resolution + type judgment)", () => {
  const parent = makeSession("parent", [
    userMessage(0, "fix the bug", { recordId: "p-user" }),
    assistantMessage(1, "working on it", { recordId: "p-asst" }),
  ]);

  it("passes a forked_from anchored at an agent-side record", () => {
    const fork = makeSession("fork", [userMessage(0, "new direction")], {
      lineage: { type: "forked_from", sessionId: "parent", atRecordId: "p-asst" },
    });
    expect(validateSessions([parent, fork])).toEqual([]);
  });

  it("passes a sibling_attempt anchored at a user_message", () => {
    const sibling = makeSession("sibling", [assistantMessage(0, "another answer")], {
      lineage: { type: "sibling_attempt", sessionId: "parent", atRecordId: "p-user" },
    });
    expect(validateSessions([parent, sibling])).toEqual([]);
  });

  it("passes a retry-from-start lineage (atRecordId omitted)", () => {
    const retry = makeSession("retry", [userMessage(0, "fix the bug")], {
      lineage: { type: "sibling_attempt", sessionId: "parent" },
    });
    expect(validateSessions([parent, retry])).toEqual([]);
  });

  it("flags a lineage pointing at an unknown session (lineage-session)", () => {
    const fork = makeSession("fork", undefined, {
      lineage: { type: "forked_from", sessionId: "ghost-parent", atRecordId: "p-asst" },
    });
    const errors = validateSessions([parent, fork]);
    expect(errors.map((e) => e.code)).toContain("lineage-session");
  });

  it("flags an atRecordId resolving to no record in the parent (lineage-anchor)", () => {
    const fork = makeSession("fork", undefined, {
      lineage: { type: "forked_from", sessionId: "parent", atRecordId: "no-such-record" },
    });
    const errors = validateSessions([parent, fork]);
    expect(errors.map((e) => e.code)).toContain("lineage-anchor");
  });

  it("flags a wrong type judgment both ways (lineage-type)", () => {
    const wrongFork = makeSession("fork", undefined, {
      lineage: { type: "sibling_attempt", sessionId: "parent", atRecordId: "p-asst" },
    });
    expect(validateSessions([parent, wrongFork]).map((e) => e.code)).toContain("lineage-type");

    const wrongSibling = makeSession("sibling", undefined, {
      lineage: { type: "forked_from", sessionId: "parent", atRecordId: "p-user" },
    });
    expect(validateSessions([parent, wrongSibling]).map((e) => e.code)).toContain("lineage-type");
  });
});

describe("AC-0002-N-6 tool pairing (XOR: paired result | interrupted)", () => {
  const wrap = (middle: Parameters<typeof makeSession>[1]) =>
    makeSession("sess-1", [userMessage(0, "go"), ...(middle ?? [])]);

  it("case 1: tool_call with exactly one paired tool_result passes", () => {
    const session = wrap([toolCall(1, "tc1"), toolResult(2, "tc1", "ok")]);
    expect(validateSessions([session])).toEqual([]);
  });

  it("case 2: interrupted tool_call with no tool_result passes (AC-0002-B-1)", () => {
    const session = wrap([toolCall(1, "tc1", { status: "interrupted" })]);
    expect(validateSessions([session])).toEqual([]);
  });

  it("case 3: tool_call with no result and not interrupted is flagged", () => {
    const session = wrap([toolCall(1, "tc1")]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("case 4: interrupted tool_call that still has a paired result is flagged", () => {
    const session = wrap([
      toolCall(1, "tc1", { status: "interrupted" }),
      toolResult(2, "tc1", "ok"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("flags a tool_call with multiple results (adapter must keep file-order first only)", () => {
    const session = wrap([
      toolCall(1, "tc1"),
      toolResult(2, "tc1", "first"),
      toolResult(3, "tc1", "second"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("flags a tool_result matching no tool_call", () => {
    const session = wrap([
      toolCall(1, "tc1", { status: "interrupted" }),
      toolResult(2, "tc-orphan", "ok"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });
});

describe("AC-0002-N-5 idempotency helper", () => {
  it("passes when two runs over the same input are byte-identical", async () => {
    const adapter = fakeAdapter([
      makeSession("sess-1", [userMessage(0, "go"), assistantMessage(1, "ok")]),
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
        yield userMessage(0, "go");
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
      makeSession("sess-2", [userMessage(0, "second")]),
    ]);
    const collected = await collectSessions(adapter);
    expect(collected.map((s) => s.manifest.sessionId)).toEqual(["sess-1", "sess-2"]);
    expect(collected[1]?.records[0]).toMatchObject({ type: "user_message" });
  });
});
