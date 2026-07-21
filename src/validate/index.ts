import type { HarnessAdapter } from "../store/adapter";
import type { Manifest } from "../schema/manifest";
import type { AhsRecord } from "../schema/record";

/**
 * Harness-agnostic AC layer-2 invariant checks (AC-0002) over projected
 * (Manifest, records) sessions. Reusable by every adapter's tests.
 */

export interface SessionData {
  manifest: Manifest;
  records: AhsRecord[];
}

export interface InvariantError {
  code:
    | "single-root"
    | "parent-resolution"
    | "seq-order"
    | "relation-session"
    | "relation-anchor"
    | "tool-result-match"
    | "not-idempotent";
  sessionId: string;
  message: string;
}

/** AC-0002-N-1: tree shape — one root, resolving parents, increasing seq. */
function checkTree(session: SessionData, errors: InvariantError[]): void {
  const { records } = session;
  const sid = session.manifest.sessionId;
  const ids = new Set(records.map((r) => r.recordId));

  const roots = records.filter((r) => r.parentId === null);
  if (roots.length !== 1) {
    errors.push({
      code: "single-root",
      sessionId: sid,
      message: `expected exactly one root record, found ${roots.length}`,
    });
  }

  for (const rec of records) {
    if (rec.parentId !== null && !ids.has(rec.parentId)) {
      errors.push({
        code: "parent-resolution",
        sessionId: sid,
        message: `record ${rec.recordId} has dangling parentId ${rec.parentId}`,
      });
    }
  }

  for (let i = 1; i < records.length; i += 1) {
    const prev = records[i - 1]!;
    const cur = records[i]!;
    if (cur.seq <= prev.seq) {
      errors.push({
        code: "seq-order",
        sessionId: sid,
        message: `seq not strictly increasing at index ${i}: ${prev.seq} -> ${cur.seq}`,
      });
    }
  }
}

/** AC-0002-N-2: relation anchors resolve across the session set. */
function checkRelations(sessions: SessionData[], errors: InvariantError[]): void {
  const byId = new Map(sessions.map((s) => [s.manifest.sessionId, s]));
  for (const session of sessions) {
    const relation = session.manifest.relation;
    if (relation === undefined) continue;
    const sid = session.manifest.sessionId;
    const parent = byId.get(relation.sessionId);
    if (parent === undefined) {
      errors.push({
        code: "relation-session",
        sessionId: sid,
        message: `relation.${relation.type} points to unknown session ${relation.sessionId}`,
      });
      continue;
    }
    if (relation.type === "spawned_by" && relation.toolCallId !== undefined) {
      const anchor = parent.records.find(
        (r) => r.type === "tool_call" && r.toolCallId === relation.toolCallId,
      );
      if (anchor === undefined) {
        errors.push({
          code: "relation-anchor",
          sessionId: sid,
          message: `spawned_by.toolCallId ${relation.toolCallId} matches no tool_call in parent session ${relation.sessionId}`,
        });
      }
    }
  }
}

/** AC-0002-N-3 (partial): every tool_call pairs with exactly one tool_result. */
function checkToolPairing(session: SessionData, errors: InvariantError[]): void {
  const sid = session.manifest.sessionId;
  const results = new Map<string, number>();
  for (const rec of session.records) {
    if (rec.type === "tool_result") {
      results.set(rec.toolCallId, (results.get(rec.toolCallId) ?? 0) + 1);
    }
  }
  for (const rec of session.records) {
    if (rec.type !== "tool_call") continue;
    const count = results.get(rec.toolCallId) ?? 0;
    if (count !== 1) {
      errors.push({
        code: "tool-result-match",
        sessionId: sid,
        message: `tool_call ${rec.toolCallId} (record ${rec.recordId}) has ${count} tool_result(s), expected exactly 1`,
      });
    }
  }
  for (const rec of session.records) {
    if (rec.type !== "tool_result") continue;
    const hasCall = session.records.some(
      (r) => r.type === "tool_call" && r.toolCallId === rec.toolCallId,
    );
    if (!hasCall) {
      errors.push({
        code: "tool-result-match",
        sessionId: sid,
        message: `tool_result ${rec.toolCallId} (record ${rec.recordId}) matches no tool_call`,
      });
    }
  }
}

/** Run all per-set invariants. Empty result = pass. */
export function validateSessions(sessions: SessionData[]): InvariantError[] {
  const errors: InvariantError[] = [];
  for (const session of sessions) {
    checkTree(session, errors);
    checkToolPairing(session, errors);
  }
  checkRelations(sessions, errors);
  return errors;
}

/** Collect the full adapter output into memory (manifests + records). */
export async function collectSessions(adapter: HarnessAdapter): Promise<SessionData[]> {
  const sessions: SessionData[] = [];
  for await (const manifest of adapter.listSessions()) {
    const records: AhsRecord[] = [];
    for await (const rec of adapter.readRecords(manifest.sessionId)) {
      records.push(rec);
    }
    sessions.push({ manifest, records });
  }
  return sessions;
}

/** JSON.stringify with recursively sorted object keys (deterministic diff). */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** AC-0002-N-5: two runs over the same input must be byte-identical. */
export async function checkIdempotency(adapter: HarnessAdapter): Promise<InvariantError[]> {
  const first = stableSerialize(await collectSessions(adapter));
  const second = stableSerialize(await collectSessions(adapter));
  if (first === second) return [];
  return [
    {
      code: "not-idempotent",
      sessionId: "*",
      message: "adapter output differs between two runs over the same input",
    },
  ];
}
