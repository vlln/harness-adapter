#!/usr/bin/env node
/**
 * ahs-report — AC layer-4 consumer proof (AC-0004), Task view (ADR-0005 §5).
 *
 * Reads ONLY an AHS archive (manifest.json + per-branch records JSONL per
 * session dir) — never an adapter, never native storage. Given a session,
 * it walks the session's intra-session branch tree from HEAD back through
 * parentBranch to render the HEAD chain as ONE continuous linear transcript:
 * shared prefixes are stitched by walking branch parentRecordId back-links
 * and each branch contributes only its suffix. Invocation children (manifest
 * invocation back-links) are rendered indented right after their anchoring
 * tool_call, recursively; children without an anchor render after the parent's
 * records. Cycles are cut defensively.
 *
 * Aggregation: every session contributes only the usage of its OWN rendered
 * slice (suffix-only for branches — a stitched prefix belongs to the ancestor
 * branch's slice, so no prefix is ever double-counted). The total equals
 * the record-level sum over exactly the rendered records.
 *
 * Usage:
 *   node_modules/.bin/vite-node examples/ahs-report.ts <archiveRoot> <sessionId> [--all]
 *     --all   also list the session's branches as alternate versions (they are
 *             NOT stitched into the transcript)
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
  type RelationSession,
} from "../src/ahs/relations";
import type { Branch, Manifest } from "../src/schema/manifest";
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
  /** Also list the session's branches as alternate versions. */
  all?: boolean;
}

export interface ReportResult {
  text: string;
  /** Aggregated usage over exactly the rendered record slices. */
  totalUsage: Usage;
  totalCost: Map<string, number>;
  /** sessionIds whose slices were rendered (walk order). */
  aggregatedSessions: string[];
  /** The entry session ID. */
  sessionId: string;
  /** The entry session ID (same as sessionId — branching is intra-session). */
  headSessionId: string;
  /** Branch names from the entry session (sorted). */
  alternates: string[];
}

/** An invocation child session, deduped by sessionId. */
interface ChildTask {
  sessionId: string;
  /** Anchoring tool_call recordId in the parent, when known. */
  anchor?: string;
}

/**
 * Render the Task-view transcript + cost report for one archived session,
 * reading ONLY the archive. The session's intra-session branch chain is
 * resolved from the session's manifest (branches + HEAD); relations are
 * rebuilt in-memory from manifests + records for invocation children.
 */
export async function renderReport(
  archiveRoot: string,
  sessionId: string,
  options?: ReportOptions,
): Promise<ReportResult> {
  const archive = await loadArchive(archiveRoot);
  const entrySession = archive.get(sessionId);
  if (entrySession === undefined) {
    throw new Error(`session not in archive: ${sessionId}`);
  }

  // Load all records (needed for the derived relations and the rendering).
  const sessions = new Map<string, RelationSession>();
  for (const [sid, session] of [...archive.entries()].sort()) {
    const records: AhsRecord[] = [];
    for (const branchName of Object.keys(session.manifest.branches)) {
      for await (const rec of readRecords(session.dir, branchName)) {
        records.push(rec);
      }
    }
    sessions.set(sid, { manifest: session.manifest, records });
  }
  const relations = buildRelations([...sessions.values()]);

  // Invocation children per parent session, deduped by sessionId.
  const childrenOf = new Map<string, ChildTask[]>();
  for (const [sid, session] of sessions) {
    const effective = effectiveInvocation(relations, sid);
    if (effective === undefined || !sessions.has(effective.sessionId)) continue;
    const anchor = session.manifest.invocation?.atRecordId ?? effective.atRecordId;
    const list = childrenOf.get(effective.sessionId) ?? [];
    const existing = list.find((c) => c.sessionId === sid);
    if (existing === undefined) {
      list.push({
        sessionId: sid,
        ...(anchor !== undefined ? { anchor } : {}),
      });
    } else if (existing.anchor === undefined && anchor !== undefined) {
      existing.anchor = anchor;
    }
    childrenOf.set(effective.sessionId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));

  const lines: string[] = [];
  const totalUsage: Usage = {};
  const totalCost = new Map<string, number>();
  const aggregatedSessions: string[] = [];
  const visitedSessions = new Set<string>();

  const renderTask = async (entryId: string, depth: number): Promise<void> => {
    const session = sessions.get(entryId);
    if (session === undefined) return;
    const indent = "  ".repeat(depth);
    if (visitedSessions.has(entryId)) {
      lines.push(`${indent}[cycle detected: session ${entryId} — skipped]`);
      return;
    }
    visitedSessions.add(entryId);

    const { manifest } = session;

    // HEAD chain: walk from HEAD branch back through parentBranch to root
    // branch (cycle-safe), oldest first.
    const chain: { branchName: string; records: AhsRecord[] }[] = [];
    const seen = new Set<string>();
    let curBranch: string | null = manifest.HEAD.branch;
    while (curBranch !== null && !seen.has(curBranch)) {
      seen.add(curBranch);
      const branchDef: Branch | undefined = manifest.branches[curBranch];
      const branchRecords: AhsRecord[] = [];
      const sessionDir = archive.get(entryId)!.dir;
      for await (const rec of readRecords(sessionDir, curBranch)) {
        branchRecords.push(rec);
      }
      chain.unshift({ branchName: curBranch, records: branchRecords });
      curBranch = branchDef?.parentBranch ?? null;
    }

    aggregatedSessions.push(entryId);

    for (let i = 0; i < chain.length; i += 1) {
      const segment = chain[i]!;
      const records = segment.records;

      // Slice: ends at the next segment's parentRecordId (inclusive).
      // null parentRecordId = keep full parent slice.
      let end = records.length;
      if (i + 1 < chain.length) {
        const nextBranchName = chain[i + 1]!.branchName;
        const nextBranchDef = manifest.branches[nextBranchName];
        const parentRecordId = nextBranchDef?.parentRecordId;
        if (parentRecordId !== null && parentRecordId !== undefined) {
          const idx = records.findIndex((r) => r.recordId === parentRecordId);
          end = idx >= 0 ? idx + 1 : records.length;
        }
        // null parentRecordId: keep full parent slice.
      }
      if (end === 0) continue;

      const isHead = i + 1 === chain.length;
      const title = manifest.title !== undefined ? ` — ${manifest.title}` : "";
      const annotation =
        chain.length > 1 ? (isHead ? " (task HEAD)" : " (shared prefix, stitched)") : "";
      lines.push(`${indent}# ${entryId} [${manifest.harness} · ${manifest.model}]${title}${annotation}`);

      const children = childrenOf.get(entryId) ?? [];
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
            renderedChildren.add(child.sessionId);
            await renderTask(child.sessionId, depth + 1);
          }
        }
      }
      // Fallback: children whose anchor is not in the rendered slice.
      for (const child of [...anchored.values()].flat().concat(unanchored)) {
        if (renderedChildren.has(child.sessionId)) continue;
        renderedChildren.add(child.sessionId);
        await renderTask(child.sessionId, depth + 1);
      }

      addUsage(totalUsage, sliceUsage, sliceCost);
      for (const [currency, amount] of sliceCost) {
        totalCost.set(currency, (totalCost.get(currency) ?? 0) + amount);
      }
      lines.push(usageLine(`${indent}  cost (${entryId}): `, sliceUsage, sliceCost));
    }
  };

  await renderTask(sessionId, 0);

  lines.push("");
  lines.push(`== cost summary (${aggregatedSessions.length} session(s)) ==`);
  lines.push(usageLine("total: ", totalUsage, totalCost));

  const entryManifest = entrySession.manifest;
  const alternates = Object.keys(entryManifest.branches).sort();
  if (options?.all === true && alternates.length > 1) {
    lines.push("");
    lines.push(`== alternate versions (session ${sessionId}) ==`);
    lines.push(`HEAD: ${entryManifest.HEAD.branch}`);
    for (const branchName of alternates) {
      const branchDef = entryManifest.branches[branchName]!;
      const marker = branchName === entryManifest.HEAD.branch ? " (HEAD)" : "";
      if (branchDef.parentBranch === null) {
        lines.push(`- ${branchName}${marker} (root branch)`);
      } else {
        const anchor =
          branchDef.parentRecordId === null
            ? " (anchor source-unavailable)"
            : branchDef.parentRecordId !== undefined && branchDef.parentRecordId !== null
              ? ` @ ${branchDef.parentRecordId}`
              : "";
        lines.push(`- ${branchName}${marker} forked_from ${branchDef.parentBranch}${anchor}`);
      }
    }
  }

  return {
    text: `${lines.join("\n")}\n`,
    totalUsage,
    totalCost,
    aggregatedSessions,
    sessionId,
    headSessionId: sessionId,
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