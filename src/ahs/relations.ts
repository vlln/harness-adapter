import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

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
 * (AR-005): nothing is authored. Deleting relations.jsonl loses nothing —
 * `buildRelations` over the same sessions rebuilds a byte-identical file.
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

/* ------------------------------------------------------------------ *
 * Disk format (relations.jsonl): one JSON object per line, keys sorted,
 * lines in canonical order, re-export over the same sessions is
 * byte-identical.
 * ------------------------------------------------------------------ */

const EdgeLineSchema = z.object({
  kind: z.literal("edge"),
  type: z.literal("invocation"),
  from: z.string(),
  to: z.string(),
  atRecordId: z.string().nullable().optional(),
});

const RelationLineSchema = EdgeLineSchema;

export const RELATIONS_FILENAME = "relations.jsonl";

/** JSON.stringify with recursively sorted object keys (deterministic). */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
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

/** Write relations.jsonl at the archive root. Returns the file path. */
export async function writeRelations(outDir: string, relations: Relations): Promise<string> {
  const lines: string[] = [];
  for (const edge of relations.edges) lines.push(stableStringify({ kind: "edge", ...edge }));
  const file = path.join(outDir, RELATIONS_FILENAME);
  await mkdir(outDir, { recursive: true });
  await writeFile(file, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
  return file;
}

/** Read and validate relations.jsonl from an archive root. */
export async function readRelations(outDir: string): Promise<Relations> {
  const raw = await readFile(path.join(outDir, RELATIONS_FILENAME), "utf8");
  const edges: RelationEdge[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = RelationLineSchema.parse(JSON.parse(trimmed));
    edges.push({
      type: parsed.type,
      from: parsed.from,
      to: parsed.to,
      ...(parsed.atRecordId !== undefined ? { atRecordId: parsed.atRecordId } : {}),
    });
  }
  return { edges };
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