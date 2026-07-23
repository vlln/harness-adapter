#!/usr/bin/env node
/**
 * ahs-report — AC layer-4 consumer proof (AC-0004).
 *
 * Reads ONLY an AHS archive (manifest.json + records.jsonl + blobs/ per
 * session dir) — never an adapter, never native storage. Renders a readable
 * transcript of one session (with spawned sub-agent sessions inlined under
 * their anchoring tool_call, recursively) and a cost summary aggregated
 * over the session and all spawned descendants.
 *
 * Usage:
 *   node_modules/.bin/vite-node examples/ahs-report.ts <archiveRoot> <sessionId>
 * (vite-node ships with vitest; plain `node --experimental-strip-types`
 * does not resolve the extensionless src imports.)
 *
 * `renderReport` is exported for programmatic use (tests).
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { readManifest, readRecords } from "../src/ahs/reader";
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

export interface ReportResult {
  text: string;
  /** Aggregated usage over the session and all spawned descendants. */
  totalUsage: Usage;
  totalCost: Map<string, number>;
  /** sessionIds included in the aggregate (invocation-graph walk order). */
  aggregatedSessions: string[];
}

/**
 * Render the transcript + cost report for one archived session, reading
 * ONLY the archive. Spawned children (manifest.invocation back-links) are
 * rendered indented right after the anchoring tool_call (children without
 * an atRecordId anchor render after the parent's records); cycles are cut
 * defensively.
 */
export async function renderReport(archiveRoot: string, sessionId: string): Promise<ReportResult> {
  const archive = await loadArchive(archiveRoot);
  const root = archive.get(sessionId);
  if (root === undefined) throw new Error(`session not in archive: ${sessionId}`);

  const childrenOf = new Map<string, ArchiveSession[]>();
  for (const session of archive.values()) {
    const invocation = session.manifest.invocation;
    if (invocation === undefined) continue;
    const list = childrenOf.get(invocation.sessionId);
    if (list !== undefined) list.push(session);
    else childrenOf.set(invocation.sessionId, [session]);
  }

  const lines: string[] = [];
  const totalUsage: Usage = {};
  const totalCost = new Map<string, number>();
  const aggregatedSessions: string[] = [];
  const visited = new Set<string>();

  const renderSession = async (session: ArchiveSession, depth: number): Promise<void> => {
    if (visited.has(session.manifest.sessionId)) {
      lines.push(`${"  ".repeat(depth)}[cycle detected: ${session.manifest.sessionId} — skipped]`);
      return;
    }
    visited.add(session.manifest.sessionId);
    aggregatedSessions.push(session.manifest.sessionId);

    const indent = "  ".repeat(depth);
    const { manifest } = session;
    const title = manifest.title !== undefined ? ` — ${manifest.title}` : "";
    lines.push(`${indent}# ${manifest.sessionId} [${manifest.harness} · ${manifest.model}]${title}`);

    const children = childrenOf.get(manifest.sessionId) ?? [];
    const anchored = new Map<string, ArchiveSession[]>();
    const unanchored: ArchiveSession[] = [];
    for (const child of children) {
      const anchor = child.manifest.invocation?.atRecordId;
      if (anchor !== undefined) {
        const list = anchored.get(anchor);
        if (list !== undefined) list.push(child);
        else anchored.set(anchor, [child]);
      } else {
        unanchored.push(child);
      }
    }

    const sessionUsage: Usage = {};
    const sessionCost = new Map<string, number>();
    for await (const rec of readRecords(session.dir)) {
      for (const line of renderRecord(rec)) lines.push(`${indent}${line}`);
      if (rec.usage !== undefined) addUsage(sessionUsage, rec.usage, sessionCost);
      if (rec.type === "tool_call") {
        for (const child of anchored.get(rec.recordId) ?? []) {
          await renderSession(child, depth + 1);
        }
      }
    }
    for (const child of unanchored) {
      await renderSession(child, depth + 1);
    }
    addUsage(totalUsage, sessionUsage, sessionCost);
    for (const [currency, amount] of sessionCost) {
      totalCost.set(currency, (totalCost.get(currency) ?? 0) + amount);
    }
    lines.push(usageLine(`${indent}  cost (${manifest.sessionId}): `, sessionUsage, sessionCost));
  };

  await renderSession(root, 0);

  lines.push("");
  lines.push(`== cost summary (${aggregatedSessions.length} session(s)) ==`);
  lines.push(usageLine("total: ", totalUsage, totalCost));

  return { text: `${lines.join("\n")}\n`, totalUsage, totalCost, aggregatedSessions };
}

// CLI entry (vite-node examples/ahs-report.ts <archiveRoot> <sessionId>).
// vite-node/tsx replace argv[1] with their own binary; plain node leaves
// the script path there. Imports from tests (vitest binary) never match.
const entry = process.argv[1] ?? "";
const invokedAsScript =
  /[\\/]ahs-report\.ts$/.test(entry) || /[\\/](vite-node|tsx)(\.[cm]?[jt]s)?$/.test(entry);
if (invokedAsScript) {
  const [archiveRoot, sessionId] = process.argv.slice(2);
  if (archiveRoot === undefined || sessionId === undefined) {
    console.error("usage: ahs-report <archiveRoot> <sessionId>");
    process.exit(1);
  }
  const report = await renderReport(archiveRoot, sessionId);
  process.stdout.write(report.text);
}
