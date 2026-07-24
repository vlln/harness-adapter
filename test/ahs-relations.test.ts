/**
 * Derived relations store tests (ADR-0006):
 * - invocation edges derived from manifest back-links + tool_result.sessionId
 *   forward links (deduped), both directions navigable;
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
  invocationChildEdges,
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
    { lineage: { type: "forked_from", sessionId: "sub/fork-1" } },
  );
  // Independent lineage group for the HEAD heuristic: beta updated after
  // alpha; gamma has the same timestamp as beta (tie → smaller id wins).
  const alpha = makeSession("alpha", [userMessage(0, "v1", { timestamp: T1 })]);
  const beta = makeSession("beta", [userMessage(0, "v2", { timestamp: T3 })], {
    lineage: { type: "forked_from", sessionId: "alpha", atRecordId: "r0" },
  });
  const gamma = makeSession("gamma", [userMessage(0, "v3", { timestamp: T3 })], {
    lineage: { type: "forked_from", sessionId: "alpha", atRecordId: "r0" },
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

  it("drops edges whose endpoints are not archived (partial archives)", () => {
    expect(relations.edges.some((e) => e.from === "not-archived" || e.to === "not-archived")).toBe(
      false,
    );
  });
});

describe("relations.jsonl (write/read)", () => {
  it("round-trips: buildRelations(writeRelations-read-back) deep-equals the original", async () => {
    const outDir = path.join(tmp, "round-trip");
    const sessions = materialize(fixtureSessions());
    const adapter = fakeAdapter(sessions);
    await exportSessions(adapter, outDir, undefined, { relations: true });

    const original = buildRelations(sessions);
    const readBack = await readRelations(outDir);
    expect(readBack).toEqual(original);
  });

  it("is purely derived (AR-005): deleting the file loses nothing — rebuild is byte-identical", async () => {
    const outDir = path.join(tmp, "derived");
    const sessions = materialize(fixtureSessions());
    await exportSessions(fakeAdapter(sessions), outDir, undefined, { relations: true });

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

  it("exportSessions writes relations.jsonl when opted in; skips by default", async () => {
    const withRelations = path.join(tmp, "opt-in");
    await exportSessions(fakeAdapter(materialize(fixtureSessions())), withRelations, undefined, {
      relations: true,
    });
    expect(() => readFileSync(path.join(withRelations, RELATIONS_FILENAME), "utf8")).not.toThrow();

    const without = path.join(tmp, "opt-out");
    await exportSessions(fakeAdapter(materialize(fixtureSessions())), without);
    expect(() => readFileSync(path.join(without, RELATIONS_FILENAME), "utf8")).toThrow();
  });
});
