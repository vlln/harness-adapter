/**
 * Derived relations store tests (ADR-0005 §6, AR-005):
 * - edges derived from manifest back-links + tool_result.sessionId forward
 *   links (deduped), both dimensions navigable both ways;
 * - lineage groups (union-find) + HEAD pointer heuristic (most recently
 *   updated, deterministic tie-break);
 * - fork-of-subagent transitive invocation closure;
 * - relations.jsonl round-trip and pure derivability (deleting the file
 *   loses nothing: a rebuild is byte-identical).
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildRelations,
  effectiveInvocation,
  groupOfSession,
  invocationChildEdges,
  lineageParentEdge,
  readRelations,
  RELATIONS_FILENAME,
  writeRelations,
  type RelationSession,
} from "../src/ahs/relations";
import { exportSessions } from "../src/ahs/writer";
import type { SessionData } from "../src/validate/index";
import {
  assistantMessage,
  fakeAdapter,
  makeSession,
  toolCall,
  toolResult,
  userMessage,
} from "./builders";

const tmp = mkdtempSync(path.join(tmpdir(), "ahs-relations-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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
    userMessage(0, "do the task", { timestamp: T1 }),
    toolCall(1, "tc-task", { name: "Task", status: "completed", recordId: "root-call" }),
    toolResult(2, "tc-task", "sub-agent done", { sessionIds: ["sub"], timestamp: T1 }),
    assistantMessage(3, "wrapped up", { timestamp: T2 }),
  ]);
  const sub = makeSession(
    "sub",
    [userMessage(0, "subtask", { timestamp: T1 }), assistantMessage(1, "sub work", { timestamp: T1 })],
    { invocation: { sessionId: "root", atRecordId: "root-call" } },
  );
  // Fork of the sub-agent: lineage only — invocation is NOT copied (ADR-0005).
  const subFork = makeSession(
    "sub/fork-1",
    [assistantMessage(0, "fork direction", { timestamp: T2 })],
    { lineage: { type: "forked_from", sessionId: "sub", atRecordId: "sub-r1" } },
  );
  // Nested fork: transitive inheritance across two lineage hops.
  const subFork2 = makeSession(
    "sub/fork-2",
    [assistantMessage(0, "nested fork", { timestamp: T3 })],
    { lineage: { type: "sibling_attempt", sessionId: "sub/fork-1" } },
  );
  // Independent lineage group for the HEAD heuristic: beta updated after
  // alpha; gamma has the same timestamp as beta (tie → smaller id wins).
  const alpha = makeSession("alpha", [userMessage(0, "v1", { timestamp: T1 })]);
  const beta = makeSession("beta", [userMessage(0, "v2", { timestamp: T3 })], {
    lineage: { type: "forked_from", sessionId: "alpha", atRecordId: "r0" },
  });
  const gamma = makeSession("gamma", [userMessage(0, "v3", { timestamp: T3 })], {
    lineage: { type: "sibling_attempt", sessionId: "alpha", atRecordId: "r0" },
  });
  // A dangling back-link (parent not archived): no edge, singleton group.
  const orphan = makeSession("orphan", [userMessage(0, "alone", { timestamp: T1 })], {
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

  it("derives lineage edges with the type judgment attached", () => {
    const lineage = relations.edges.filter((e) => e.type === "lineage");
    expect(lineage).toContainEqual({
      type: "lineage",
      from: "sub",
      to: "sub/fork-1",
      atRecordId: "sub-r1",
      lineageType: "forked_from",
    });
    expect(lineage).toContainEqual({
      type: "lineage",
      from: "sub/fork-1",
      to: "sub/fork-2",
      lineageType: "sibling_attempt",
    });
    expect(lineageParentEdge(relations, "sub/fork-1")?.from).toBe("sub");
  });

  it("preserves the atRecordId tri-state on lineage edges (null = source-unavailable)", () => {
    const sessions: SessionData[] = [
      makeSession("p", [userMessage(0, "q", { timestamp: T1 })]),
      makeSession("f-null", [userMessage(0, "v2", { timestamp: T2 })], {
        lineage: { type: "forked_from", sessionId: "p", atRecordId: null },
      }),
      makeSession("f-retry", [userMessage(0, "v3", { timestamp: T2 })], {
        lineage: { type: "sibling_attempt", sessionId: "p" },
      }),
    ];
    const rel = buildRelations(sessions);
    // null (source-unavailable) is preserved, distinct from absent (retry-from-start).
    expect(lineageParentEdge(rel, "f-null")).toMatchObject({ atRecordId: null });
    expect(lineageParentEdge(rel, "f-retry")).not.toHaveProperty("atRecordId");
  });

  it("groups lineage-connected sessions (union-find) and picks HEAD by recency", () => {
    const subGroup = groupOfSession(relations, "sub/fork-2");
    expect(subGroup?.groupId).toBe("sub");
    expect(subGroup?.members).toEqual(["sub", "sub/fork-1", "sub/fork-2"]);
    // sub/fork-2 has the latest last-record timestamp (T3).
    expect(subGroup?.mainSessionId).toBe("sub/fork-2");

    const alphaGroup = groupOfSession(relations, "gamma");
    expect(alphaGroup?.members).toEqual(["alpha", "beta", "gamma"]);
    // beta and gamma tie at T3 → deterministic tie-break: smaller sessionId.
    expect(alphaGroup?.mainSessionId).toBe("beta");

    // Root has no lineage: singleton group, its own HEAD.
    const rootGroup = groupOfSession(relations, "root");
    expect(rootGroup?.members).toEqual(["root"]);
    expect(rootGroup?.mainSessionId).toBe("root");
  });

  it("drops edges whose endpoints are not archived (partial archives)", () => {
    expect(relations.edges.some((e) => e.from === "not-archived" || e.to === "not-archived")).toBe(
      false,
    );
    expect(groupOfSession(relations, "orphan")?.members).toEqual(["orphan"]);
  });

  it("computes the fork-of-subagent transitive closure (ADR-0005 §2)", () => {
    // The fork itself carries no invocation — the closure inherits it.
    expect(effectiveInvocation(relations, "sub/fork-1")).toEqual({
      sessionId: "root",
      atRecordId: "root-call",
    });
    // Transitively across two lineage hops.
    expect(effectiveInvocation(relations, "sub/fork-2")).toEqual({
      sessionId: "root",
      atRecordId: "root-call",
    });
    const closure = relations.closures.find((c) => c.sessionId === "sub/fork-2");
    expect(closure?.inheritedFrom).toBe("sub");
    // Directly invoked sessions get no closure entry.
    expect(relations.closures.some((c) => c.sessionId === "sub")).toBe(false);
  });
});

describe("relations.jsonl (write/read)", () => {
  it("round-trips: buildRelations(writeRelations-read-back) deep-equals the original", async () => {
    const outDir = path.join(tmp, "round-trip");
    const sessions = materialize(fixtureSessions());
    const adapter = fakeAdapter(sessions);
    await exportSessions(adapter, outDir);

    const original = buildRelations(sessions);
    const readBack = await readRelations(outDir);
    expect(readBack).toEqual(original);
  });

  it("is purely derived (AR-005): deleting the file loses nothing — rebuild is byte-identical", async () => {
    const outDir = path.join(tmp, "derived");
    const sessions = materialize(fixtureSessions());
    await exportSessions(fakeAdapter(sessions), outDir);

    const file = path.join(outDir, RELATIONS_FILENAME);
    const firstBytes = readFileSync(file, "utf8");
    unlinkSync(file);

    // Rebuild from the archived sessions alone (no adapter involved).
    const reread: RelationSession[] = [];
    for (const { manifest, records } of sessions) {
      reread.push({ manifest, records });
    }
    await writeRelations(outDir, buildRelations(reread));
    expect(readFileSync(file, "utf8")).toBe(firstBytes);
  });

  it("serializes deterministically (sorted keys, stable section order)", async () => {
    const outDir = path.join(tmp, "deterministic");
    const sessions = materialize(fixtureSessions());
    const relations = buildRelations(sessions);
    await writeRelations(outDir, relations);
    const first = readFileSync(path.join(outDir, RELATIONS_FILENAME), "utf8");
    // Rebuild from a shuffled input order: same bytes.
    const shuffled = [...sessions].reverse();
    await writeRelations(outDir, buildRelations(shuffled));
    expect(readFileSync(path.join(outDir, RELATIONS_FILENAME), "utf8")).toBe(first);
    // Keys sorted within each line (spot-check: "from" < "kind" < "to").
    const edgeLine = first.split("\n").find((l) => l.includes('"kind":"edge"'))!;
    expect(edgeLine.indexOf('"from"')).toBeLessThan(edgeLine.indexOf('"kind"'));
    expect(edgeLine.indexOf('"kind"')).toBeLessThan(edgeLine.indexOf('"to"'));
  });

  it("exportSessions writes relations.jsonl by default; opt-out skips it", async () => {
    const withRelations = path.join(tmp, "opt-default");
    await exportSessions(fakeAdapter(materialize(fixtureSessions())), withRelations);
    expect(() => readFileSync(path.join(withRelations, RELATIONS_FILENAME), "utf8")).not.toThrow();

    const without = path.join(tmp, "opt-out");
    await exportSessions(fakeAdapter(materialize(fixtureSessions())), without, undefined, {
      relations: false,
    });
    expect(() => readFileSync(path.join(without, RELATIONS_FILENAME), "utf8")).toThrow();
  });
});
