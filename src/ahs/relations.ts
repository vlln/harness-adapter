import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { Manifest } from "../schema/manifest";
import type { AhsRecord } from "../schema/record";

/**
 * Derived relations store (ADR-0005 §6, spec "磁盘布局": relations.jsonl at
 * the archive root).
 *
 * Everything here is PURELY DERIVED from session manifests + records
 * (AR-005): nothing is authored. Deleting relations.jsonl loses nothing —
 * `buildRelations` over the same sessions rebuilds a byte-identical file.
 *
 * Contents:
 * - edges: bidirectional session-to-session navigation for both dimensions.
 *   lineage edges come from manifest lineage back-links (fork source);
 *   invocation edges come from manifest invocation back-links, reconciled
 *   with tool_result.sessionId forward links found in the records (an edge
 *   seen from both sides is stored once). One edge entry serves both
 *   directions (parent→children and child→parent are index lookups).
 * - groups: lineage groups (union-find over lineage edges) with the group
 *   HEAD pointer { groupId, mainSessionId }. The source-provided winner
 *   (e.g. Devin main_chain_id) is NOT part of session data, so at this
 *   layer HEAD = the most recently updated session of the group (its last
 *   record's timestamp; ties broken by the smaller sessionId,
 *   deterministically). A winner flip changes only this pointer, never the
 *   sessions (AC-0002-B-4).
 * - closures: transitive invocation inheritance for forks of sub-agent
 *   sessions (ADR-0005 §2: a fork's invocation is inherited along lineage,
 *   never copied onto the fork's manifest). The closure entry records which
 *   ancestor's invocation a fork inherits.
 */

/** A session as the relations builder needs it: manifest + its records. */
export interface RelationSession {
  manifest: Manifest;
  records: AhsRecord[];
}

/** One derived edge. `from` is the parent side, `to` the child side. */
export interface RelationEdge {
  type: "invocation" | "lineage";
  from: string;
  to: string;
  /**
   * Anchor record in the parent: the spawning tool_call (invocation) or the
   * divergence point (lineage). Omitted when the source has no anchor
   * (Kimi agent-level links, retry-from-start forks).
   */
  atRecordId?: string;
  /** lineage only: forked_from | sibling_attempt (ADR-0005 type judgment). */
  lineageType?: "forked_from" | "sibling_attempt";
}

/** A lineage group with its HEAD pointer (Task = group + HEAD, ADR-0005 §5). */
export interface LineageGroup {
  groupId: string;
  mainSessionId: string;
  members: string[];
}

/** Fork-of-subagent inheritance: sessionId inherits invocation from an ancestor. */
export interface InvocationClosure {
  sessionId: string;
  /** The lineage ancestor whose own invocation is inherited. */
  inheritedFrom: string;
  invocation: { sessionId: string; atRecordId?: string };
}

export interface Relations {
  edges: RelationEdge[];
  groups: LineageGroup[];
  closures: InvocationClosure[];
}

/* ------------------------------------------------------------------ *
 * Disk format (relations.jsonl): one JSON object per line, keys sorted,
 * lines in canonical section order (edges, groups, closures), each
 * section sorted — re-export over the same sessions is byte-identical.
 * ------------------------------------------------------------------ */

const EdgeLineSchema = z.object({
  kind: z.literal("edge"),
  type: z.enum(["invocation", "lineage"]),
  from: z.string(),
  to: z.string(),
  atRecordId: z.string().optional(),
  lineageType: z.enum(["forked_from", "sibling_attempt"]).optional(),
});

const GroupLineSchema = z.object({
  kind: z.literal("group"),
  groupId: z.string(),
  mainSessionId: z.string(),
  members: z.array(z.string()),
});

const ClosureLineSchema = z.object({
  kind: z.literal("closure"),
  sessionId: z.string(),
  inheritedFrom: z.string(),
  invocation: z.object({ sessionId: z.string(), atRecordId: z.string().optional() }),
});

const RelationLineSchema = z.discriminatedUnion("kind", [
  EdgeLineSchema,
  GroupLineSchema,
  ClosureLineSchema,
]);

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

function compareStrings(a: string | undefined, b: string | undefined): number {
  return (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;
}

/**
 * Derive the relations index from a full session set. Deterministic: edge
 * order, group order, member order and HEAD tie-breaks are all content-
 * addressed, never wall-clock or iteration-order dependent.
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
    // tool_result.sessionId): first writer wins; both describe the same edge.
    const key = JSON.stringify([edge.type, edge.from, edge.to]);
    if (!edges.has(key)) edges.set(key, edge);
  };

  for (const session of byId.values()) {
    const sid = session.manifest.sessionId;
    const { lineage, invocation } = session.manifest;
    // Edges are only navigable when both endpoints are archived (a partial
    // archive drops the edge; the back-link itself stays on the manifest).
    if (lineage !== undefined && byId.has(lineage.sessionId)) {
      addEdge({
        type: "lineage",
        from: lineage.sessionId,
        to: sid,
        ...(lineage.atRecordId !== undefined ? { atRecordId: lineage.atRecordId } : {}),
        lineageType: lineage.type,
      });
    }
    if (invocation !== undefined && byId.has(invocation.sessionId)) {
      addEdge({
        type: "invocation",
        from: invocation.sessionId,
        to: sid,
        ...(invocation.atRecordId !== undefined ? { atRecordId: invocation.atRecordId } : {}),
      });
    }
  }
  // Forward links: tool_result.sessionId in the parent's records.
  for (const session of byId.values()) {
    const sid = session.manifest.sessionId;
    const callByToolCallId = new Map<string, string>(); // toolCallId → tool_call recordId
    for (const rec of session.records) {
      if (rec.type === "tool_call" && !callByToolCallId.has(rec.toolCallId)) {
        callByToolCallId.set(rec.toolCallId, rec.recordId);
      }
    }
    for (const rec of session.records) {
      if (rec.type !== "tool_result" || rec.sessionId === undefined) continue;
      if (!byId.has(rec.sessionId) || rec.sessionId === sid) continue;
      const anchor = callByToolCallId.get(rec.toolCallId);
      addEdge({
        type: "invocation",
        from: sid,
        to: rec.sessionId,
        ...(anchor !== undefined ? { atRecordId: anchor } : {}),
      });
    }
  }

  const edgeList = [...edges.values()].sort(
    (a, b) =>
      compareStrings(a.type, b.type) ||
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.atRecordId, b.atRecordId),
  );

  // --- Lineage groups (union-find) + HEAD pointers --------------------
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const id of byId.keys()) parent.set(id, id);
  for (const edge of edgeList) {
    if (edge.type !== "lineage") continue;
    const ra = find(edge.from);
    const rb = find(edge.to);
    if (ra !== rb) parent.set(ra, rb);
  }
  const membersByRoot = new Map<string, string[]>();
  for (const id of byId.keys()) {
    const root = find(id);
    const list = membersByRoot.get(root);
    if (list !== undefined) list.push(id);
    else membersByRoot.set(root, [id]);
  }

  const lastTimestamp = (id: string): string => {
    const records = byId.get(id)!.records;
    return records.length > 0 ? records[records.length - 1]!.timestamp : "";
  };
  const groups: LineageGroup[] = [...membersByRoot.values()].map((members) => {
    members.sort();
    // HEAD heuristic (source winner unavailable at this layer): the most
    // recently updated session; deterministic tie-break = smaller sessionId.
    let head = members[0]!;
    for (const id of members.slice(1)) {
      if (
        lastTimestamp(id) > lastTimestamp(head) ||
        (lastTimestamp(id) === lastTimestamp(head) && id < head)
      ) {
        head = id;
      }
    }
    return { groupId: members[0]!, mainSessionId: head, members };
  });
  groups.sort((a, b) => compareStrings(a.groupId, b.groupId));

  // --- Transitive closure: fork-of-subagent invocation inheritance -----
  // A fork never copies its invocation onto the manifest (ADR-0005 §2); it
  // inherits the invocation of the first lineage ancestor that has one.
  const invocationBack = new Map<string, RelationEdge>();
  const lineageBack = new Map<string, RelationEdge>();
  for (const edge of edgeList) {
    if (edge.type === "invocation" && !invocationBack.has(edge.to)) invocationBack.set(edge.to, edge);
    if (edge.type === "lineage" && !lineageBack.has(edge.to)) lineageBack.set(edge.to, edge);
  }
  const closures: InvocationClosure[] = [];
  for (const id of [...byId.keys()].sort()) {
    if (invocationBack.has(id) || !lineageBack.has(id)) continue;
    // Walk lineage ancestors (cycle-safe) to the first invoked ancestor.
    const seen = new Set<string>([id]);
    let cur = lineageBack.get(id)!.from;
    while (!seen.has(cur)) {
      seen.add(cur);
      const invoked = invocationBack.get(cur);
      if (invoked !== undefined) {
        closures.push({
          sessionId: id,
          inheritedFrom: cur,
          invocation: {
            sessionId: invoked.from,
            ...(invoked.atRecordId !== undefined ? { atRecordId: invoked.atRecordId } : {}),
          },
        });
        break;
      }
      const up = lineageBack.get(cur);
      if (up === undefined) break;
      cur = up.from;
    }
  }

  return { edges: edgeList, groups, closures };
}

/** Write relations.jsonl at the archive root. Returns the file path. */
export async function writeRelations(outDir: string, relations: Relations): Promise<string> {
  const lines: string[] = [];
  for (const edge of relations.edges) lines.push(stableStringify({ kind: "edge", ...edge }));
  for (const group of relations.groups) lines.push(stableStringify({ kind: "group", ...group }));
  for (const closure of relations.closures) {
    lines.push(stableStringify({ kind: "closure", ...closure }));
  }
  const file = path.join(outDir, RELATIONS_FILENAME);
  await mkdir(outDir, { recursive: true });
  await writeFile(file, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
  return file;
}

/** Read and validate relations.jsonl from an archive root. */
export async function readRelations(outDir: string): Promise<Relations> {
  const raw = await readFile(path.join(outDir, RELATIONS_FILENAME), "utf8");
  const edges: RelationEdge[] = [];
  const groups: LineageGroup[] = [];
  const closures: InvocationClosure[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = RelationLineSchema.parse(JSON.parse(trimmed));
    if (parsed.kind === "edge") {
      // Rebuild explicitly: zod `.optional()` infers `| undefined`, while the
      // Relations interfaces use exactOptionalPropertyTypes.
      edges.push({
        type: parsed.type,
        from: parsed.from,
        to: parsed.to,
        ...(parsed.atRecordId !== undefined ? { atRecordId: parsed.atRecordId } : {}),
        ...(parsed.lineageType !== undefined ? { lineageType: parsed.lineageType } : {}),
      });
    } else if (parsed.kind === "group") {
      groups.push({
        groupId: parsed.groupId,
        mainSessionId: parsed.mainSessionId,
        members: parsed.members,
      });
    } else {
      closures.push({
        sessionId: parsed.sessionId,
        inheritedFrom: parsed.inheritedFrom,
        invocation: {
          sessionId: parsed.invocation.sessionId,
          ...(parsed.invocation.atRecordId !== undefined
            ? { atRecordId: parsed.invocation.atRecordId }
            : {}),
        },
      });
    }
  }
  return { edges, groups, closures };
}

/* ------------------------------------------------------------------ *
 * Navigation helpers over an in-memory Relations (used by consumers
 * like examples/ahs-report.ts).
 * ------------------------------------------------------------------ */

/** The lineage group a session belongs to (always exactly one). */
export function groupOfSession(relations: Relations, sessionId: string): LineageGroup | undefined {
  return relations.groups.find((g) => g.members.includes(sessionId));
}

/** The session's own lineage back-edge (child → parent), if any. */
export function lineageParentEdge(relations: Relations, sessionId: string): RelationEdge | undefined {
  return relations.edges.find((e) => e.type === "lineage" && e.to === sessionId);
}

/** Direct invocation children (parent → children, forward direction). */
export function invocationChildEdges(relations: Relations, sessionId: string): RelationEdge[] {
  return relations.edges.filter((e) => e.type === "invocation" && e.from === sessionId);
}

/**
 * The session's effective invocation: its own manifest back-link when
 * present, else the closure-inherited one (fork-of-subagent). This is the
 * call-dimension parent used by task-view rendering and aggregation.
 */
export function effectiveInvocation(
  relations: Relations,
  sessionId: string,
): { sessionId: string; atRecordId?: string } | undefined {
  const own = relations.edges.find((e) => e.type === "invocation" && e.to === sessionId);
  if (own !== undefined) {
    return {
      sessionId: own.from,
      ...(own.atRecordId !== undefined ? { atRecordId: own.atRecordId } : {}),
    };
  }
  const inherited = relations.closures.find((c) => c.sessionId === sessionId);
  return inherited?.invocation;
}
