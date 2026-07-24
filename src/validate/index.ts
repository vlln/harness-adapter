import type { HarnessAdapter } from "../store/adapter";
import type { Manifest } from "../schema/manifest";
import type { AhsRecord } from "../schema/record";

/**
 * Harness-agnostic AC layer-2 invariant checks (AC-0002 v2, linear-session
 * model per ADR-0005) over projected (Manifest, records) sessions.
 * Reusable by every adapter's tests.
 *
 * Relation checks (N-2 invocation reconciliation, N-7 lineage anchors) are
 * cross-session: `validateSessions` takes the FULL session set, and
 * `collectSessions` gathers an adapter's complete output for exactly that.
 */

export interface SessionData {
  manifest: Manifest;
  records: AhsRecord[];
}

export interface InvariantError {
  code:
    | "seq-order"
    | "invocation-session"
    | "invocation-anchor"
    | "invocation-mismatch"
    | "lineage-session"
    | "lineage-anchor"
    | "lineage-type"
    | "tool-result-match"
    | "not-idempotent";
  sessionId: string;
  message: string;
}

/**
 * AC-0002-N-1: linear shape. The schema already forbids structural fields
 * other than seq (no parentId/branch); here seq must be strictly increasing
 * AND contiguous (step exactly 1) in file order. The first record is the
 * root — there is no parent resolution to check anymore.
 */
function checkLinear(session: SessionData, errors: InvariantError[]): void {
  const { records } = session;
  const sid = session.manifest.sessionId;
  for (let i = 1; i < records.length; i += 1) {
    const prev = records[i - 1]!;
    const cur = records[i]!;
    if (cur.seq !== prev.seq + 1) {
      errors.push({
        code: "seq-order",
        sessionId: sid,
        message: `seq not strictly increasing and contiguous at index ${i}: ${prev.seq} -> ${cur.seq}`,
      });
    }
  }
}

/**
 * AC-0002-N-2 (cross-session): invocation two-link reconciliation.
 * For every manifest with `invocation`:
 * - the parent session must exist in the session set;
 * - if atRecordId is present, it must resolve to an existing tool_call
 *   record in the parent;
 * - the parent's tool_result paired with that tool_call must INCLUDE the
 *   child's sessionId in its `sessionIds` array (forward/back-link
 *   reconciliation; one call may produce several child sessions).
 * AC-0002-B-3 form (atRecordId omitted, e.g. Kimi): the anchor and
 * reconciliation checks are skipped; the parent must still exist.
 */
function checkInvocations(sessions: SessionData[], errors: InvariantError[]): void {
  const byId = new Map(sessions.map((s) => [s.manifest.sessionId, s]));
  for (const session of sessions) {
    const invocation = session.manifest.invocation;
    if (invocation === undefined) continue;
    const sid = session.manifest.sessionId;
    const parent = byId.get(invocation.sessionId);
    if (parent === undefined) {
      errors.push({
        code: "invocation-session",
        sessionId: sid,
        message: `invocation points to unknown session ${invocation.sessionId}`,
      });
      continue;
    }
    if (invocation.atRecordId === undefined) continue; // AC-0002-B-3
    const anchor = parent.records.find((r) => r.recordId === invocation.atRecordId);
    if (anchor === undefined || anchor.type !== "tool_call") {
      errors.push({
        code: "invocation-anchor",
        sessionId: sid,
        message: `invocation.atRecordId ${invocation.atRecordId} resolves to no tool_call in parent session ${invocation.sessionId}`,
      });
      continue;
    }
    const paired = parent.records.find(
      (r) => r.type === "tool_result" && r.toolCallId === anchor.toolCallId,
    );
    if (
      paired === undefined ||
      paired.type !== "tool_result" ||
      !(paired.sessionIds ?? []).includes(sid)
    ) {
      errors.push({
        code: "invocation-mismatch",
        sessionId: sid,
        message: `parent tool_result paired with tool_call ${anchor.toolCallId} does not include sessionId ${sid} in its sessionIds (forward/back-link reconciliation failed)`,
      });
    }
  }
}

/**
 * AC-0002-N-7 (cross-session): lineage anchor resolution + type judgment.
 * For every manifest with `lineage`:
 * - root === true: self-contained, lineage is metadata only — all checks
 *   are skipped.
 * - root === false: the lineage is a structural dependency that must be
 *   validated.
 *   atRecordId tri-state (ADR-0005 amendment): null = anchor
 *   source-unavailable → ALL lineage checks are skipped (the parent itself
 *   may be missing from the store); absent = retry from start → only the
 *   parent-existence check applies;
 *   - otherwise (anchored): the parent session must exist in the session set,
 *     atRecordId must resolve to an existing record in the parent, and the
 *     lineage type must be "rewound_from".
 */
function checkLineages(sessions: SessionData[], errors: InvariantError[]): void {
  const byId = new Map(sessions.map((s) => [s.manifest.sessionId, s]));
  for (const session of sessions) {
    const lineage = session.manifest.lineage;
    if (lineage === undefined) continue;
    // root === true: lineage is metadata only, skip validation.
    if (session.manifest.root) continue;
    const sid = session.manifest.sessionId;
    if (lineage.atRecordId === null) continue; // anchor source-unavailable
    const parent = byId.get(lineage.sessionId);
    if (parent === undefined) {
      errors.push({
        code: "lineage-session",
        sessionId: sid,
        message: `lineage.${lineage.type} points to unknown session ${lineage.sessionId}`,
      });
      continue;
    }
    if (lineage.atRecordId === undefined) continue; // retry from start
    const anchor = parent.records.find((r) => r.recordId === lineage.atRecordId);
    if (anchor === undefined) {
      errors.push({
        code: "lineage-anchor",
        sessionId: sid,
        message: `lineage.atRecordId ${lineage.atRecordId} resolves to no record in parent session ${lineage.sessionId}`,
      });
      continue;
    }
    const expected = "rewound_from";
    if (lineage.type !== expected) {
      errors.push({
        code: "lineage-type",
        sessionId: sid,
        message: `lineage anchored at ${anchor.type} record ${anchor.recordId} must be "rewound_from", got "${lineage.type}"`,
      });
    }
  }
}

/**
 * AC-0002-N-6: every tool_call has exactly one paired tool_result, XOR
 * status === "interrupted" (AC-0002-B-1: interrupted calls are explicitly
 * marked, never silently omitted and never given a synthetic result).
 * Every tool_result must reference an existing tool_call.
 */
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
    const interrupted = rec.status === "interrupted";
    if (count === 1 && interrupted) {
      errors.push({
        code: "tool-result-match",
        sessionId: sid,
        message: `tool_call ${rec.toolCallId} (record ${rec.recordId}) is marked interrupted but has a paired tool_result`,
      });
    } else if (count !== 1 && !interrupted) {
      errors.push({
        code: "tool-result-match",
        sessionId: sid,
        message: `tool_call ${rec.toolCallId} (record ${rec.recordId}) has ${count} tool_result(s) and is not marked interrupted`,
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
    checkLinear(session, errors);
    checkToolPairing(session, errors);
  }
  checkInvocations(sessions, errors);
  checkLineages(sessions, errors);
  return errors;
}

/** Collect the full adapter output into memory (manifests + records). */
export async function collectSessions(adapter: HarnessAdapter): Promise<SessionData[]> {
  const sessions: SessionData[] = [];
  // Cross-session invariants need the FULL set, lineage descendants included.
  for await (const manifest of adapter.listSessions({ includeForks: true })) {
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
