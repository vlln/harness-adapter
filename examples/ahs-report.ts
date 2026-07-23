#!/usr/bin/env node
/**
 * ahs-report — AC layer-4 consumer proof (AC-0004), Task view (ADR-0005 §5).
 *
 * Reads ONLY an AHS archive (manifest.json + records.jsonl per session dir)
 * — never an adapter, never native storage. Given any session of a lineage
 * group, it resolves the group's HEAD pointer and renders the HEAD chain as
 * ONE continuous linear transcript: shared prefixes are stitched by walking
 * lineage back-links (parent records up to the atRecordId anchor) and each
 * fork contributes only its suffix. Invocation children (manifest
 * invocation back-links + closure-inherited fork-of-subagent links) are
 * rendered indented right after their anchoring tool_call, recursively;
 * children without an anchor render after the parent's records. Cycles are
 * cut defensively.
 *
 * Aggregation: every session contributes only the usage of its OWN rendered
 * slice (suffix-only for forks — a stitched prefix belongs to the ancestor
 * session's slice, so no prefix is ever double-counted). The total equals
 * the record-level sum over exactly the rendered records.
 *
 * Usage:
 *   node_modules/.bin/vite-node examples/ahs-report.ts <archiveRoot> <sessionId> [--all]
 *     --all   also list the lineage group's fork/attempt sessions as
 *             alternate versions (they are NOT stitched into the transcript)
 * (vite-node ships with vitest; plain `node --experimental-strip-types`
 * does not resolve the extensionless src imports.)
 *
 * `renderReport` is exported for programmatic use (tests).
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { readManifest, readRecords } from "../src/ahs/reader";
import {
  buildRelations,
  effectiveInvocation,
  groupOfSession,
  lineageParentEdge,
  type Relations,
  type RelationSession,
} from "../src/ahs/relations";
import type { Manifest } from "../src/schema/manifest";
import type { AhsRecord, ContentBlock } from "../src/schema/record";
import type { Usage } from "../src/schema/usage";

interface ArchiveSession {
  dir: string;
  manifest: Manifest;
}

/** Discover all archived sessions under a sessions root. */
async function loadArchive(archiveRoot: string): Promise<Map<string, ArchiveSession>> {
  const sessions = new Map<string, ArchiveSession>();
  for (const entry of await readdir(archiveRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(archiveRoot, entry.name);
    try {
      const manifest = await readManifest(dir);
      sessions.set(manifest.sessionId, { dir, manifest });
    } catch {
      // Not a session dir (no/invalid manifest.json) — skip.
    }
  }
  return sessions;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replaceAll("\n", " ⏎ ");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function renderBlock(block: ContentBlock): string {
  if (block.type === "thinking") return `[thinking ${block.text.length} chars]`;
  if (block.type === "text") return block.text;
  if (block.type === "image") return `[image ${block.mediaType}]`;
  return `[blob sha256-${block.sha256.slice(0, 12)}… ${block.byteLength} bytes] ${block.preview ?? ""}`;
}

function renderRecord(rec: AhsRecord): string[] {
  switch (rec.type) {
    case "user_message":
      return rec.content.map((b) => `[user] ${renderBlock(b)}`);
    case "harness_message":
      return rec.content.map((b) => `[harness] ${renderBlock(b)}`);
    case "assistant_message":
      return rec.content.map((b) => `[assistant] ${renderBlock(b)}`);
    case "tool_call": {
      const status = rec.status !== undefined ? ` (${rec.status})` : "";
      return [`→ ${rec.name}(${truncate(JSON.stringify(rec.args ?? null), 80)})${status}`];
    }
    case "tool_result": {
      const status = rec.status === "error" ? "error: " : "";
      if (typeof rec.content === "string") {
        return [`  ⤷ ${status}${truncate(rec.content.split("\n")[0] ?? "", 120)}`];
      }
      return [
        `  ⤷ ${status}[blob sha256-${rec.content.sha256.slice(0, 12)}… ${rec.content.byteLength} bytes] ${truncate(rec.content.preview ?? "", 100)}`,
      ];
    }
    case "turn_boundary":
      return [`─ turn ${rec.phase}${rec.turnId !== undefined ? ` (${rec.turnId})` : ""}`];
    case "model_change":
      return [`─ model change → ${rec.model}`];
    case "compaction":
      return [
        `─ compaction${rec.summary !== undefined ? `: ${truncate(rec.summary.split("\n")[0] ?? "", 100)}` : ""}`,
      ];
    case "goal_update":
      return [
        `─ goal ${rec.status}${rec.reason !== undefined ? `: ${truncate(rec.reason, 100)}` : ""}`,
      ];
  }
}

/** Sum `add` into `target` (token fields + durationMs; cost by currency). */
function addUsage(target: Usage, add: Usage, costs: Map<string, number>): void {
  target.inputTokens = (target.inputTokens ?? 0) + (add.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (add.outputTokens ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0);
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (add.reasoningTokens ?? 0);
  if (add.durationMs !== undefined) {
    target.durationMs = (target.durationMs ?? 0) + add.durationMs;
  }
  if (add.cost !== undefined) {
    costs.set(add.cost.currency, (costs.get(add.cost.currency) ?? 0) + add.cost.amount);
  }
}

function usageLine(prefix: string, usage: Usage, costs: Map<string, number>): string {
  const parts = [
    `input=${usage.inputTokens ?? 0}`,
    `output=${usage.outputTokens ?? 0}`,
    `cacheRead=${usage.cacheReadTokens ?? 0}`,
    `cacheWrite=${usage.cacheWriteTokens ?? 0}`,
    `reasoning=${usage.reasoningTokens ?? 0}`,
  ];
  if (usage.durationMs !== undefined) parts.push(`durationMs=${usage.durationMs}`);
  for (const [currency, amount] of [...costs.entries()].sort()) {
    parts.push(`cost=${amount} ${currency}`);
  }
  return `${prefix}${parts.join("  ")}`;
}

export interface ReportOptions {
  /** Also list the lineage group's fork/attempt sessions as alternates. */
  all?: boolean;
}

export interface ReportResult {
  text: string;
  /** Aggregated usage over exactly the rendered record slices. */
  totalUsage: Usage;
  totalCost: Map<string, number>;
  /** sessionIds whose slices were rendered (walk order, HEAD chain first). */
  aggregatedSessions: string[];
  /** The resolved Task: lineage group + HEAD pointer (ADR-0005 §5). */
  groupId: string;
  headSessionId: string;
  /** All members of the resolved lineage group (sorted). */
  alternates: string[];
}

/** An invocation child task, deduped by lineage group. */
interface ChildTask {
  groupId: string;
  /** Any member of the group (used only to locate the group). */
  entryId: string;
  /** Anchoring tool_call recordId in the parent, when known. */
  anchor?: string;
}

/**
 * Render the Task-view transcript + cost report for one archived session,
 * reading ONLY the archive. The session's lineage group + HEAD pointer are
 * resolved from the derived relations (rebuilt in-memory from manifests +
 * records; relations.jsonl is the same derivation persisted for other
 * consumers).
 */
export async function renderReport(
  archiveRoot: string,
  sessionId: string,
  options?: ReportOptions,
): Promise<ReportResult> {
  const archive = await loadArchive(archiveRoot);
  if (archive.get(sessionId) === undefined) {
    throw new Error(`session not in archive: ${sessionId}`);
  }

  // Load all records (needed for the derived relations and the rendering).
  const sessions = new Map<string, RelationSession>();
  for (const [sid, session] of [...archive.entries()].sort()) {
    const records: AhsRecord[] = [];
    for await (const rec of readRecords(session.dir)) records.push(rec);
    sessions.set(sid, { manifest: session.manifest, records });
  }
  const relations: Relations = buildRelations([...sessions.values()]);

  // Invocation children per parent session, deduped by lineage group (a
  // fork-of-subagent inherits the parent's invocation through the closure —
  // rendering the group once via its HEAD covers both the sub-agent and
  // its forks).
  const childrenOf = new Map<string, ChildTask[]>();
  for (const [sid, session] of sessions) {
    const effective = effectiveInvocation(relations, sid);
    if (effective === undefined || !sessions.has(effective.sessionId)) continue;
    const group = groupOfSession(relations, sid);
    if (group === undefined) continue;
    const anchor = session.manifest.invocation?.atRecordId ?? effective.atRecordId;
    const list = childrenOf.get(effective.sessionId) ?? [];
    const existing = list.find((c) => c.groupId === group.groupId);
    if (existing === undefined) {
      list.push({
        groupId: group.groupId,
        entryId: sid,
        ...(anchor !== undefined ? { anchor } : {}),
      });
    } else if (existing.anchor === undefined && anchor !== undefined) {
      existing.anchor = anchor;
    }
    childrenOf.set(effective.sessionId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => (a.groupId < b.groupId ? -1 : 1));

  const lines: string[] = [];
  const totalUsage: Usage = {};
  const totalCost = new Map<string, number>();
  const aggregatedSessions: string[] = [];
  const visitedGroups = new Set<string>();

  const renderTask = async (entryId: string, depth: number): Promise<void> => {
    const group = groupOfSession(relations, entryId);
    if (group === undefined) return;
    const indent = "  ".repeat(depth);
    if (visitedGroups.has(group.groupId)) {
      lines.push(`${indent}[cycle detected: group ${group.groupId} — skipped]`);
      return;
    }
    visitedGroups.add(group.groupId);

    // HEAD chain: walk lineage back-links from the HEAD to the chain root
    // (cycle-safe, staying inside the group), oldest first.
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = group.mainSessionId;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      chain.unshift(cur);
      const edge = lineageParentEdge(relations, cur);
      cur = edge !== undefined && group.members.includes(edge.from) ? edge.from : undefined;
    }

    for (let i = 0; i < chain.length; i += 1) {
      const sid = chain[i]!;
      const session = sessions.get(sid)!;
      const records = session.records;

      // Slice: the shared-prefix part this session contributes to the HEAD
      // chain. Ends at the next segment's lineage anchor (inclusive); a
      // retry-from-start child (no atRecordId) means this session
      // contributes nothing. A dangling anchor falls back to the full
      // session (defensive — AC-0002-N-7 guarantees resolution).
      let end = records.length;
      if (i + 1 < chain.length) {
        const childEdge = lineageParentEdge(relations, chain[i + 1]!);
        if (childEdge?.atRecordId === undefined) {
          end = 0;
        } else {
          const idx = records.findIndex((r) => r.recordId === childEdge.atRecordId);
          end = idx >= 0 ? idx + 1 : records.length;
        }
      }
      if (end === 0) continue;

      const isHead = i + 1 === chain.length;
      const { manifest } = session;
      const title = manifest.title !== undefined ? ` — ${manifest.title}` : "";
      const annotation =
        chain.length > 1 ? (isHead ? " (task HEAD)" : " (shared prefix, stitched)") : "";
      lines.push(`${indent}# ${sid} [${manifest.harness} · ${manifest.model}]${title}${annotation}`);

      const children = childrenOf.get(sid) ?? [];
      const anchored = new Map<string, ChildTask[]>();
      const unanchored: ChildTask[] = [];
      for (const child of children) {
        if (child.anchor !== undefined) {
          const list = anchored.get(child.anchor);
          if (list !== undefined) list.push(child);
          else anchored.set(child.anchor, [child]);
        } else {
          unanchored.push(child);
        }
      }
      const renderedChildren = new Set<string>();

      const sliceUsage: Usage = {};
      const sliceCost = new Map<string, number>();
      for (const rec of records.slice(0, end)) {
        for (const line of renderRecord(rec)) lines.push(`${indent}${line}`);
        if (rec.usage !== undefined) addUsage(sliceUsage, rec.usage, sliceCost);
        if (rec.type === "tool_call") {
          for (const child of anchored.get(rec.recordId) ?? []) {
            renderedChildren.add(child.groupId);
            await renderTask(child.entryId, depth + 1);
          }
        }
      }
      // Fallback: children whose anchor is not in the rendered slice (or who
      // have none) render after the parent's records.
      for (const child of [...anchored.values()].flat().concat(unanchored)) {
        if (renderedChildren.has(child.groupId)) continue;
        renderedChildren.add(child.groupId);
        await renderTask(child.entryId, depth + 1);
      }

      aggregatedSessions.push(sid);
      addUsage(totalUsage, sliceUsage, sliceCost);
      for (const [currency, amount] of sliceCost) {
        totalCost.set(currency, (totalCost.get(currency) ?? 0) + amount);
      }
      lines.push(usageLine(`${indent}  cost (${sid}): `, sliceUsage, sliceCost));
    }
  };

  const rootGroup = groupOfSession(relations, sessionId)!;
  await renderTask(sessionId, 0);

  lines.push("");
  lines.push(`== cost summary (${aggregatedSessions.length} session(s)) ==`);
  lines.push(usageLine("total: ", totalUsage, totalCost));

  const alternates = [...rootGroup.members].sort();
  if (options?.all === true && alternates.length > 1) {
    lines.push("");
    lines.push(`== alternate versions (group ${rootGroup.groupId}) ==`);
    lines.push(`HEAD: ${rootGroup.mainSessionId}`);
    for (const member of alternates) {
      const edge = lineageParentEdge(relations, member);
      const marker = member === rootGroup.mainSessionId ? " (HEAD)" : "";
      if (edge === undefined) {
        lines.push(`- ${member}${marker} (group root)`);
      } else {
        const anchor =
          edge.atRecordId !== undefined ? ` @ ${edge.atRecordId}` : " (retry from start)";
        lines.push(`- ${member}${marker} ${edge.lineageType ?? ""} ${edge.from}${anchor}`);
      }
    }
  }

  return {
    text: `${lines.join("\n")}\n`,
    totalUsage,
    totalCost,
    aggregatedSessions,
    groupId: rootGroup.groupId,
    headSessionId: rootGroup.mainSessionId,
    alternates,
  };
}

// CLI entry (vite-node examples/ahs-report.ts <archiveRoot> <sessionId> [--all]).
// vite-node/tsx replace argv[1] with their own binary; plain node leaves
// the script path there. Imports from tests (vitest binary) never match.
const entry = process.argv[1] ?? "";
const invokedAsScript =
  /[\\/]ahs-report\.ts$/.test(entry) || /[\\/](vite-node|tsx)(\.[cm]?[jt]s)?$/.test(entry);
if (invokedAsScript) {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const [archiveRoot, sessionId] = args.filter((a) => a !== "--all");
  if (archiveRoot === undefined || sessionId === undefined) {
    console.error("usage: ahs-report <archiveRoot> <sessionId> [--all]");
    process.exit(1);
  }
  const report = await renderReport(archiveRoot, sessionId, { all });
  process.stdout.write(report.text);
}
