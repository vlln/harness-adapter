import { describe, expect, it } from "vitest";

import type { Manifest } from "../src/schema/manifest";
import type { AhsRecord } from "../src/schema/record";
import { validateSessions, type SessionData } from "../src/validate/index";

function manifest(sessionId: string, relation?: Manifest["relation"]): Manifest {
  return {
    sessionId,
    harness: "test-harness",
    harnessVersion: "0.0.0",
    ahsVersion: "0.1.0",
    cwd: "/tmp/test",
    model: "test-model",
    ...(relation !== undefined ? { relation } : {}),
  };
}

let seqCounter = 0;
function rec(partial: Partial<AhsRecord> & { recordId: string }): AhsRecord {
  const seq = seqCounter;
  seqCounter += 1;
  return {
    parentId: null,
    seq,
    timestamp: "2026-07-14T05:15:46.655Z",
    type: "user_message",
    content: [{ type: "text", text: "x" }],
    ...partial,
  } as AhsRecord;
}

/** Minimal valid session: root user message, assistant, tool_call + tool_result. */
function validSession(sessionId: string, relation?: Manifest["relation"]): SessionData {
  seqCounter = 0;
  return {
    manifest: manifest(sessionId, relation),
    records: [
      rec({ recordId: `${sessionId}-r0`, parentId: null }),
      rec({
        recordId: `${sessionId}-r1`,
        parentId: `${sessionId}-r0`,
        type: "assistant_message",
        content: [{ type: "text", text: "y" }],
      }),
      rec({
        recordId: `${sessionId}-r2`,
        parentId: `${sessionId}-r1`,
        type: "tool_call",
        toolCallId: "call-1",
        name: "Bash",
        args: {},
      }),
      rec({
        recordId: `${sessionId}-r3`,
        parentId: `${sessionId}-r2`,
        type: "tool_result",
        toolCallId: "call-1",
        content: "ok",
        status: "success",
      }),
    ],
  };
}

describe("validateSessions (AC layer-2 invariants)", () => {
  it("accepts a valid session set, including a spawned child", () => {
    const parent = validSession("parent");
    const child = validSession("child", {
      type: "spawned_by",
      sessionId: "parent",
      toolCallId: "call-1",
    });
    expect(validateSessions([parent, child])).toEqual([]);
  });

  it("rejects a dangling parentId", () => {
    const session = validSession("s");
    session.records[1]!.parentId = "does-not-exist";
    const errors = validateSessions([session]);
    expect(errors.some((e) => e.code === "parent-resolution")).toBe(true);
  });

  it("rejects sessions with zero or two roots", () => {
    const twoRoots = validSession("s");
    twoRoots.records[1]!.parentId = null;
    expect(
      validateSessions([twoRoots]).some((e) => e.code === "single-root"),
    ).toBe(true);

    const noRoot = validSession("s");
    noRoot.records[0]!.parentId = "s-r3";
    const errors = validateSessions([noRoot]);
    expect(errors.some((e) => e.code === "single-root")).toBe(true);
  });

  it("rejects non-increasing seq", () => {
    const session = validSession("s");
    session.records[2]!.seq = 1;
    expect(validateSessions([session]).some((e) => e.code === "seq-order")).toBe(true);
  });

  it("rejects a tool_call without exactly one tool_result", () => {
    const missing = validSession("s");
    missing.records = missing.records.filter((r) => r.type !== "tool_result");
    expect(
      validateSessions([missing]).some((e) => e.code === "tool-result-match"),
    ).toBe(true);

    const duplicated = validSession("s");
    duplicated.records.push(
      rec({
        recordId: "s-r4",
        parentId: "s-r3",
        type: "tool_result",
        toolCallId: "call-1",
        content: "again",
      }),
    );
    expect(
      validateSessions([duplicated]).some((e) => e.code === "tool-result-match"),
    ).toBe(true);
  });

  it("rejects relation anchors that do not resolve", () => {
    const orphan = validSession("child", { type: "spawned_by", sessionId: "ghost" });
    expect(
      validateSessions([orphan]).some((e) => e.code === "relation-session"),
    ).toBe(true);

    const parent = validSession("parent");
    const badAnchor = validSession("child", {
      type: "spawned_by",
      sessionId: "parent",
      toolCallId: "no-such-call",
    });
    expect(
      validateSessions([parent, badAnchor]).some((e) => e.code === "relation-anchor"),
    ).toBe(true);
  });
});
