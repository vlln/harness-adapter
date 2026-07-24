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

describe("AC-0002-N-2 invocation completeness (forward/back-link reconciliation)", () => {
  const parent = makeSession("parent", [
    userMessage("go"),
    toolCall("tc-task", { name: "Task", recordId: "p-call" }),
    toolResult("tc-task", "done", { recordId: "p-result", sessionIds: ["child"] }),
  ]);

  it("passes when the parent, tool_call anchor and forward link reconcile", () => {
    const child = makeSession("child", undefined, {
      invocation: { sessionId: "parent", atRecordId: "p-call" },
    });
    expect(validateSessions([parent, child])).toEqual([]);
  });

  it("passes when one call lists MULTIPLE children in sessionIds (each reconciles)", () => {
    const swarm = makeSession("parent", [
      userMessage("go"),
      toolCall("tc-task", { name: "AgentSwarm", recordId: "p-call" }),
      toolResult("tc-task", "done", { recordId: "p-result", sessionIds: ["c1", "c2"] }),
    ]);
    const c1 = makeSession("c1", undefined, {
      invocation: { sessionId: "parent", atRecordId: "p-call" },
    });
    const c2 = makeSession("c2", undefined, {
      invocation: { sessionId: "parent", atRecordId: "p-call" },
    });
    expect(validateSessions([swarm, c1, c2])).toEqual([]);
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
      userMessage("go"),
      toolCall("tc-task", { name: "Task", recordId: "p-call" }),
      toolResult("tc-task", "done", { recordId: "p-result" }), // no sessionId forward link
    ]);
    const child = makeSession("child", undefined, {
      invocation: { sessionId: "parent", atRecordId: "p-call" },
    });
    const errors = validateSessions([badParent, child]);
    expect(errors.map((e) => e.code)).toContain("invocation-mismatch");

    const wrongTarget = makeSession("parent", [
      userMessage("go"),
      toolCall("tc-task", { name: "Task", recordId: "p-call" }),
      toolResult("tc-task", "done", { recordId: "p-result", sessionIds: ["other-child"] }),
    ]);
    expect(validateSessions([wrongTarget, child]).map((e) => e.code)).toContain(
      "invocation-mismatch",
    );
  });
});

describe("AC-0002-N-6 tool pairing (XOR: paired result | interrupted)", () => {
  const wrap = (middle: Parameters<typeof makeSession>[1]) =>
    makeSession("sess-1", [userMessage("go"), ...(middle ?? [])]);

  it("case 1: tool_call with exactly one paired tool_result passes", () => {
    const session = wrap([toolCall("tc1"), toolResult("tc1", "ok")]);
    expect(validateSessions([session])).toEqual([]);
  });

  it("case 2: interrupted tool_call with no tool_result passes (AC-0002-B-1)", () => {
    const session = wrap([toolCall("tc1", { status: "interrupted" })]);
    expect(validateSessions([session])).toEqual([]);
  });

  it("case 3: tool_call with no result and not interrupted is flagged", () => {
    const session = wrap([toolCall("tc1")]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("case 4: interrupted tool_call that still has a paired result is flagged", () => {
    const session = wrap([
      toolCall("tc1", { status: "interrupted" }),
      toolResult("tc1", "ok"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("flags a tool_call with multiple results (adapter must keep file-order first only)", () => {
    const session = wrap([
      toolCall("tc1"),
      toolResult("tc1", "first"),
      toolResult("tc1", "second"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });

  it("flags a tool_result matching no tool_call", () => {
    const session = wrap([
      toolCall("tc1", { status: "interrupted" }),
      toolResult("tc-orphan", "ok"),
    ]);
    const errors = validateSessions([session]);
    expect(errors.map((e) => e.code)).toContain("tool-result-match");
  });
});

describe("AC-0002-N-5 idempotency helper", () => {
  it("passes when two runs over the same input are byte-identical", async () => {
    const adapter = fakeAdapter([
      makeSession("sess-1", [userMessage("go"), assistantMessage("ok")]),
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
        yield userMessage("go");
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
      makeSession("sess-2", [userMessage("second")]),
    ]);
    const collected = await collectSessions(adapter);
    expect(collected.map((s) => s.manifest.sessionId)).toEqual(["sess-1", "sess-2"]);
    expect(collected[1]?.records[0]).toMatchObject({ type: "user_message" });
  });
});
