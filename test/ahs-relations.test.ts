/**
 * Derived relations store tests (ADR-0006):
 * - invocation edges derived from manifest back-links + tool_result.sessionId
 *   forward links (deduped), both directions navigable.
 */

import { describe, expect, it } from "vitest";

import {
  buildRelations,
  effectiveInvocation,
  invocationChildEdges,
} from "../src/ahs/relations";
import type { SessionData } from "../src/validate/index";
import {
  assistantMessage,
  makeSession,
  toolCall,
  toolResult,
  userMessage,
} from "./builders";

const T1 = "2026-07-20T10:00:00.000Z";
const T2 = "2026-07-20T11:00:00.000Z";
const T3 = "2026-07-20T12:00:00.000Z";

/**
 * A root session that spawns a sub-agent; the sub-agent forks (fork-of-
 * subagent); the fork forks again (transitive inheritance). Plus an
 * independent two-session lineage group for the HEAD heuristic.
 */
function fixtureSessions(): SessionData[] {
  const root = makeSession("root", [
    userMessage("do the task", { timestamp: T1 }),
    toolCall("tc-task", { name: "Task", status: "completed", recordId: "root-call" }),
    toolResult("tc-task", "sub-agent done", { sessionIds: ["sub"], timestamp: T1 }),
    assistantMessage("wrapped up", { timestamp: T2 }),
  ]);
  const sub = makeSession(
    "sub",
    [userMessage("subtask", { timestamp: T1 }), assistantMessage("sub work", { timestamp: T1 })],
    { invocation: { sessionId: "root", atRecordId: "root-call" } },
  );
  // Fork of the sub-agent: lineage only — invocation is NOT copied (ADR-0005).
  const subFork = makeSession(
    "sub/fork-1",
    [assistantMessage("fork direction", { timestamp: T2 })],
    { lineage: { type: "forked_from", sessionId: "sub", atRecordId: "sub-r1" } },
  );
  // Nested fork: transitive inheritance across two lineage hops.
  const subFork2 = makeSession(
    "sub/fork-2",
    [assistantMessage("nested fork", { timestamp: T3 })],
    { lineage: { type: "forked_from", sessionId: "sub/fork-1" } },
  );
  // Independent lineage group for the HEAD heuristic: beta updated after
  // alpha; gamma has the same timestamp as beta (tie → smaller id wins).
  const alpha = makeSession("alpha", [userMessage("v1", { timestamp: T1 })]);
  const beta = makeSession("beta", [userMessage("v2", { timestamp: T3 })], {
    lineage: { type: "forked_from", sessionId: "alpha", atRecordId: "r0" },
  });
  const gamma = makeSession("gamma", [userMessage("v3", { timestamp: T3 })], {
    lineage: { type: "forked_from", sessionId: "alpha", atRecordId: "r0" },
  });
  // A dangling back-link (parent not archived): no edge, singleton group.
  const orphan = makeSession("orphan", [userMessage("alone", { timestamp: T1 })], {
    lineage: { type: "forked_from", sessionId: "not-archived" },
    invocation: { sessionId: "not-archived" },
  });
  return [root, sub, subFork, subFork2, alpha, beta, gamma, orphan];
}

// Fix the lineage anchor recordIds used above ("sub-r1" must exist in sub).
function materialize(sessions: SessionData[]): SessionData[] {
  const sub = sessions.find((s) => s.manifest.sessionId === "sub")!;
  sub.records[1] = { ...sub.records[1]!, recordId: "sub-r1" };
  return sessions;
}

describe("buildRelations", () => {
  const relations = buildRelations(materialize(fixtureSessions()));

  it("derives invocation edges from the back-link AND the forward link, deduped", () => {
    // root→sub appears once even though both the manifest invocation
    // back-link and the tool_result.sessionId forward link describe it.
    const invocations = relations.edges.filter((e) => e.type === "invocation");
    expect(invocations).toEqual([
      { type: "invocation", from: "root", to: "sub", atRecordId: "root-call" },
    ]);
    // Parent → children (forward) and child → parent (back) navigation.
    expect(invocationChildEdges(relations, "root")).toEqual(invocations);
    expect(effectiveInvocation(relations, "sub")).toEqual({
      sessionId: "root",
      atRecordId: "root-call",
    });
  });

  it("drops edges whose endpoints are not archived (partial archives)", () => {
    expect(relations.edges.some((e) => e.from === "not-archived" || e.to === "not-archived")).toBe(
      false,
    );
  });
});
