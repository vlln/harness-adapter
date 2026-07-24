import type { Manifest } from "../schema/manifest";
import type { AhsRecord } from "../schema/record";

/**
 * Derived relations store (ADR-0006: simplified — invocation edges only).
 *
 * Lineage edges, groups, and closures are retired (ADR-0006):
 * - rewind is now intra-session branching (Manifest.branches);
 * - fork lineage is metadata-only (no structural dependency);
 * - invocation closure is unnecessary (invocation is a session-level
 *   property, not inherited through forks).
 *
 * Everything here is PURELY DERIVED from session manifests + records
 * (AR-005): nothing is authored. `buildRelations` over the same sessions
 * always produces a byte-identical edge list.
 */

/** A session as the relations builder needs it: manifest + its records. */
export interface RelationSession {
  manifest: Manifest;
  records: AhsRecord[];
}

/** One derived invocation edge. `from` is the parent side, `to` the child side. */
export interface RelationEdge {
  type: "invocation";
  from: string;
  to: string;
  /**
   * Anchor record in the parent: the spawning tool_call.
   * Tri-state: a value = anchored; null = anchor source-unavailable;
   * absent = no anchor (agent-level invocation links).
   */
  atRecordId?: string | null;
}

export interface Relations {
  edges: RelationEdge[];
}

function compareStrings(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;
}

/**
 * Derive the invocation-edge index from a full session set. Deterministic:
 * edge order is content-addressed, never wall-clock or iteration-order
 * dependent.
 */
export function buildRelations(sessions: RelationSession[]): Relations {
  const byId = new Map<string, RelationSession>();
  for (const session of sessions) {
    if (!byId.has(session.manifest.sessionId)) byId.set(session.manifest.sessionId, session);
  }

  // --- Edges ---------------------------------------------------------
  const edges = new Map<string, RelationEdge>();
  const addEdge = (edge: RelationEdge): void => {
    // Dedupe a link seen from both sides (manifest back-link + forward
    // tool_result.sessionIds): first writer wins; both describe the same edge.
    const key = JSON.stringify([edge.type, edge.from, edge.to]);
    if (!edges.has(key)) edges.set(key, edge);
  };

  for (const session of byId.values()) {
    const sid = session.manifest.sessionId;
    const { invocation } = session.manifest;
    if (invocation !== undefined && byId.has(invocation.sessionId)) {
      addEdge({
        type: "invocation",
        from: invocation.sessionId,
        to: sid,
        ...(invocation.atRecordId !== undefined ? { atRecordId: invocation.atRecordId } : {}),
      });
    }
  }
  // Forward links: tool_result.sessionIds in the parent's records.
  for (const session of byId.values()) {
    const sid = session.manifest.sessionId;
    const callByToolCallId = new Map<string, string>(); // toolCallId → tool_call recordId
    for (const rec of session.records) {
      if (rec.type === "tool_call" && !callByToolCallId.has(rec.toolCallId)) {
        callByToolCallId.set(rec.toolCallId, rec.recordId);
      }
    }
    for (const rec of session.records) {
      if (rec.type !== "tool_result" || rec.sessionIds === undefined) continue;
      const anchor = callByToolCallId.get(rec.toolCallId);
      for (const childId of rec.sessionIds) {
        if (!byId.has(childId) || childId === sid) continue;
        addEdge({
          type: "invocation",
          from: sid,
          to: childId,
          ...(anchor !== undefined ? { atRecordId: anchor } : {}),
        });
      }
    }
  }

  const edgeList = [...edges.values()].sort(
    (a, b) =>
      compareStrings(a.type, b.type) ||
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.atRecordId, b.atRecordId),
  );

  return { edges: edgeList };
}

/* ------------------------------------------------------------------ *
 * Navigation helpers over an in-memory Relations (used by consumers
 * like examples/ahs-report.ts). These remain for backward compatibility
 * but now operate only on invocation edges.
 * ------------------------------------------------------------------ */

/**
 * Direct invocation children (parent → children, forward direction).
 * The primary navigation helper for the call dimension.
 */
export function invocationChildEdges(relations: Relations, sessionId: string): RelationEdge[] {
  return relations.edges.filter((e) => e.type === "invocation" && e.from === sessionId);
}

/**
 * The session's effective invocation back-link. In ADR-0006, invocation is
 * a session-level property — read directly from the manifest. This helper
 * reads the invocation edge (derived from the manifest back-link) for
 * consumers that use the relations index.
 */
export function effectiveInvocation(
  relations: Relations,
  sessionId: string,
): { sessionId: string; atRecordId?: string } | undefined {
  const own = relations.edges.find((e) => e.type === "invocation" && e.to === sessionId);
  if (own !== undefined) {
    return {
      sessionId: own.from,
      ...(own.atRecordId != null ? { atRecordId: own.atRecordId } : {}),
    };
  }
  return undefined;
}
