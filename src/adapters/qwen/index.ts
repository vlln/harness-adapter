import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { Lineage } from "../../schema/relation";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Qwen Code → AHS read-only projection (ADR-0005 linear-session model).
 *
 * Source layout (docs/research/schemas/qwen-schema.md):
 *   <base>/projects/-<cwd-encoded>/chats/<session-uuid>.jsonl   chat stream
 *   <base>/projects/-<cwd-encoded>/chats/<session-uuid>.runtime.json
 *                                                             runtime metadata
 *   <base>/usage/token-usage-YYYY-MM.jsonl                    per-API-call usage
 *   <base>/usage_record.jsonl                                per-session summary
 *
 * Record mapping (lossy projection, ADR-0001):
 * - Google GenAI-style content: `message.parts[]` of `{text, thought?}`.
 *   `thought: true` parts → thinking blocks; plain text parts → text blocks.
 *   `message.role` is "model" for the assistant (mapped unconditionally by
 *   the record's `type` field, which is authoritative).
 * - Tool calls/results are parts (not observed in the research sample, mapped
 *   per the GenAI model): `functionCall {id?, name, args}` parts of an
 *   assistant line → `tool_call` records; `functionResponse {id?, name,
 *   response}` parts of a user line → `tool_result` records. toolCallId is
 *   the part `id`; ids are optional in the source, so a call without one
 *   falls back to a deterministic `<uuid>/functionCall/<i>` and a response
 *   without one falls back to the function name (GenAI pairing is by name).
 * - A functionResponse object carrying an `error` key maps to status "error".
 * - tool_call status is derived after projection: "completed"/"failed" from
 *   the paired tool_result; "interrupted" when the session ends without a
 *   paired result (no synthetic result is emitted, AC-0002-B-1).
 * - `system` records (attribution_snapshot / file_history_snapshot /
 *   ui_telemetry) are process/telemetry — dropped per ADR-0001 and the
 *   spec's drop list; their children chain through them.
 *
 * Linearization (spec §五 "Tree" row):
 * - The parentUuid tree is walked; kept lines form chains in file order.
 *   functionResponse-only user lines are parallel result deliveries — they
 *   stay in the chain (file order), they never fork. A kept node with 2+
 *   remaining conversational children is a REAL branch point: the child whose
 *   subtree holds the last leaf (max file index; append-only storage ⇒ file
 *   order is recency) continues the chain, every other child subtree becomes
 *   a fork session `<sessionId>/fork/<branch-root uuid>` storing only its
 *   suffix, with lineage anchored at the branch point's first projected
 *   record (forked_from).
 * - Duplicate lines sharing a uuid keep their first occurrence; kept lines
 *   with an unknown/null parent mid-file re-anchor to the previous kept line
 *   (chain restarts), preserving a single root.
 *
 * Usage (AC-0002-N-4, spec §五):
 * - Record level: assistant `usageMetadata` →
 *   inputTokens = promptTokenCount, outputTokens = candidatesTokenCount,
 *   reasoningTokens = thoughtsTokenCount, cacheReadTokens =
 *   cachedContentTokenCount. totalTokenCount is a derivable sum — dropped.
 * - Managed subagents (e.g. auto-memory-extractor) leave only telemetry, no
 *   conversational content — they produce NO child sessions (spec §五). Their
 *   per-call usage lives only in the global `usage/token-usage-*.jsonl` files
 *   (rows joined by sessionId); rows whose `source` is not "main" are merged
 *   into the session's Manifest.stats.totalUsage so the cost is not lost.
 * - Rows with source "main" are the same calls the records' usageMetadata
 *   already reports; they are used only as a fallback when a session has NO
 *   record-level usage at all (AC-0002-B-2 — source usage is never dropped).
 * - `usage_record.jsonl` contributes stats.durationMs (summed across the
 *   session's entries — one entry is appended per CLI run of the session).
 *
 * Determinism (AC-0002-N-5): directory entries are sorted, chains
 * follow file order, recordIds are source uuids, fork ids are derived from
 * source uuids — no wall-clock reads anywhere.
 */

export const AHS_VERSION = "0.1.0";

/** Loose view of a source JSONL line; only the fields we read are typed. */
interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  model?: string;
  subtype?: string;
  message?: {
    role?: string;
    parts?: RawPart[];
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface RawPart {
  text?: string;
  thought?: boolean;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
}

interface RuntimeMeta {
  session_id?: string;
  work_dir?: string;
  qwen_version?: string;
}

/** One row of usage/token-usage-*.jsonl (per-API-call usage). */
interface TokenUsageRow {
  sessionId?: string;
  source?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  thoughtsTokens?: number;
}

/** One row of usage_record.jsonl (per-session summary). */
interface UsageRecordRow {
  sessionId?: string;
  durationMs?: number;
}

interface SessionSource {
  sessionId: string;
  filePath: string;
  runtime?: RuntimeMeta;
}

function parseJsonl<T>(content: string): T[] {
  const out: T[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}

function mapUsage(raw: NonNullable<RawLine["usageMetadata"]>): Usage {
  const usage: Usage = {};
  if (raw.promptTokenCount !== undefined) usage.inputTokens = raw.promptTokenCount;
  if (raw.candidatesTokenCount !== undefined) usage.outputTokens = raw.candidatesTokenCount;
  if (raw.thoughtsTokenCount !== undefined) usage.reasoningTokens = raw.thoughtsTokenCount;
  if (raw.cachedContentTokenCount !== undefined) {
    usage.cacheReadTokens = raw.cachedContentTokenCount;
  }
  return usage;
}

function stringifyResponse(response: unknown): string {
  if (typeof response === "string") return response;
  if (response === undefined || response === null) return "";
  return JSON.stringify(response);
}

/**
 * Project the lines of ONE chain (main line or fork suffix) into an AHS
 * record list, in the given order. Tool_call status is derived at the end
 * from the pairing outcome.
 */
export function projectRecords(lines: RawLine[]): AhsRecord[] {
  const records: AhsRecord[] = [];
  const emit = (rec: AhsRecord): void => {
    records.push(rec);
  };

  for (const line of lines) {
    const uuid = line.uuid;
    const timestamp = line.timestamp ?? "";
    if (uuid === undefined) continue;
    const parts = line.message?.parts ?? [];

    if (line.type === "user") {
      const textBlocks: ContentBlock[] = [];
      for (const part of parts) {
        if (typeof part.text === "string") textBlocks.push({ type: "text", text: part.text });
      }
      if (textBlocks.length > 0) {
        emit({ recordId: uuid, timestamp, type: "user_message", content: textBlocks });
      }
      let responseIndex = 0;
      for (const part of parts) {
        const fr = part.functionResponse;
        if (fr === undefined) continue;
        const recordId =
          responseIndex === 0 && textBlocks.length === 0
            ? uuid
            : `${uuid}/functionResponse/${responseIndex}`;
        responseIndex += 1;
        const response = fr.response;
        const isError =
          typeof response === "object" && response !== null && "error" in response;
        emit({
          recordId,
          timestamp,
          type: "tool_result",
          // GenAI pairs by name when no call id exists.
          toolCallId: fr.id ?? fr.name ?? "",
          content: stringifyResponse(response),
          status: isError ? "error" : "success",
        });
      }
    } else if (line.type === "assistant") {
      const contentBlocks: ContentBlock[] = [];
      const calls: RawPart[] = [];
      for (const part of parts) {
        if (typeof part.text === "string") {
          contentBlocks.push(
            part.thought === true
              ? { type: "thinking", text: part.text }
              : { type: "text", text: part.text },
          );
        } else if (part.functionCall !== undefined) {
          calls.push(part);
        }
      }
      const usage =
        line.usageMetadata !== undefined ? mapUsage(line.usageMetadata) : undefined;
      const extras = {
        ...(usage !== undefined ? { usage } : {}),
        ...(line.model !== undefined ? { model: line.model } : {}),
      };
      let emitted = contentBlocks.length > 0;
      if (contentBlocks.length > 0) {
        emit({
          ...extras,
          recordId: uuid,
          timestamp,
          type: "assistant_message",
          content: contentBlocks,
        });
      }
      let callIndex = 0;
      for (const part of calls) {
        const fc = part.functionCall!;
        // When no assistant_message was emitted (functionCall-only message),
        // usage/model ride on the first tool_call so usage is not lost.
        const carryExtras = !emitted && callIndex === 0 ? extras : {};
        const recordId =
          callIndex === 0 && contentBlocks.length === 0
            ? uuid
            : `${uuid}/functionCall/${callIndex}`;
        callIndex += 1;
        emit({
          ...carryExtras,
          recordId,
          timestamp,
          type: "tool_call",
          toolCallId: fc.id ?? `${uuid}/functionCall/${callIndex - 1}`,
          name: fc.name ?? "",
          args: fc.args,
        });
      }
    }
    // `system` records (attribution_snapshot / file_history_snapshot /
    // ui_telemetry) and anything else are dropped per ADR-0001.
  }

  // Derive tool_call status: a paired tool_result gives completed/failed; an
  // unpaired call at session end is interrupted (no synthetic result).
  const resultStatus = new Map<string, "success" | "error">();
  for (const rec of records) {
    if (rec.type === "tool_result" && !resultStatus.has(rec.toolCallId)) {
      resultStatus.set(rec.toolCallId, rec.status ?? "success");
    }
  }
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (rec.type !== "tool_call") continue;
    const paired = resultStatus.get(rec.toolCallId);
    records[i] = {
      ...rec,
      status: paired === undefined ? "interrupted" : paired === "error" ? "failed" : "completed",
    };
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * Linearization: source parentUuid tree → linear chains + fork specs   *
 * ------------------------------------------------------------------ */

/** What a kept line's FIRST emitted record is (drives lineage type judgment). */
type NodeKind = "user" | "delivery" | "assistant";

interface TreeNode {
  uuid: string;
  line: RawLine;
  index: number;
  kind: NodeKind;
  parent: TreeNode | null;
  children: TreeNode[];
  /** Max file index over this node's subtree (drives main-chain selection). */
  subtreeMax: number;
}

function nodeKind(line: RawLine): NodeKind | null {
  const parts = line.message?.parts ?? [];
  if (line.type === "user") {
    if (parts.some((p) => typeof p.text === "string")) return "user";
    if (parts.some((p) => p.functionResponse !== undefined)) return "delivery";
    return null;
  }
  if (line.type === "assistant") {
    const emittable = parts.some(
      (p) => typeof p.text === "string" || p.functionCall !== undefined,
    );
    return emittable ? "assistant" : null;
  }
  return null;
}

/**
 * Build the kept-record tree over one line stream. Duplicate uuids keep their
 * first occurrence. Dropped lines (system records, empty messages) forward
 * their children to the nearest kept ancestor. Kept lines whose parent chain
 * is unknown/null mid-stream re-anchor to the previous kept node.
 */
function buildTree(lines: RawLine[]): TreeNode[] {
  const byUuid = new Map<string, RawLine>();
  for (const line of lines) {
    if (line.uuid !== undefined && !byUuid.has(line.uuid)) byUuid.set(line.uuid, line);
  }

  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  let lastNode: TreeNode | null = null;
  lines.forEach((line, index) => {
    if (line.uuid === undefined || nodes.has(line.uuid)) return;
    const kind = nodeKind(line);
    if (kind === null) return;
    const node: TreeNode = {
      uuid: line.uuid,
      line,
      index,
      kind,
      parent: null,
      children: [],
      subtreeMax: index,
    };
    let parent: TreeNode | null = null;
    let p = line.parentUuid ?? null;
    const seen = new Set<string>();
    while (p !== null && !seen.has(p)) {
      seen.add(p);
      const candidate = nodes.get(p);
      if (candidate !== undefined) {
        parent = candidate;
        break;
      }
      const parentLine = byUuid.get(p);
      if (parentLine === undefined) break;
      p = parentLine.parentUuid ?? null;
    }
    if (parent === null && lastNode !== null) parent = lastNode;
    node.parent = parent;
    if (parent === null) roots.push(node);
    else parent.children.push(node);
    nodes.set(node.uuid, node);
    lastNode = node;
  });

  const order: TreeNode[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (const child of node.children) stack.push(child);
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const node = order[i]!;
    for (const child of node.children) {
      if (child.subtreeMax > node.subtreeMax) node.subtreeMax = child.subtreeMax;
    }
  }
  return roots;
}

interface ChainSpec {
  sessionId: string;
  nodes: TreeNode[];
  /** Fork chains only: the branch-point node in the parent chain. */
  anchor?: TreeNode;
  /** Fork chains only: sessionId of the chain holding the anchor. */
  parentSessionId?: string;
}

/**
 * Linearize the kept tree into chains. functionResponse-only user lines are
 * parallel result deliveries — they always stay in the chain. Remaining
 * multi-child nodes are real branch points: the child whose subtree holds the
 * last leaf continues the chain; every other becomes a fork session.
 */
function linearize(roots: TreeNode[], baseSessionId: string): ChainSpec[] {
  const chains: ChainSpec[] = [];

  const buildChain = (root: TreeNode, forks: { anchor: TreeNode; root: TreeNode }[]): TreeNode[] => {
    const out: TreeNode[] = [];
    const stack: TreeNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      out.push(node);
      if (node.children.length === 0) continue;
      const alternatives = node.children.filter((c) => c.kind !== "delivery");
      let main: TreeNode | undefined;
      for (const child of alternatives) {
        if (main === undefined || child.subtreeMax > main.subtreeMax) main = child;
      }
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i]!;
        if (child === main || child.kind === "delivery") stack.push(child);
        else forks.push({ anchor: node, root: child });
      }
    }
    return out;
  };

  const visit = (root: TreeNode, sessionId: string, anchor?: TreeNode, parentId?: string): void => {
    const forks: { anchor: TreeNode; root: TreeNode }[] = [];
    const nodes = buildChain(root, forks);
    chains.push({
      sessionId,
      nodes,
      ...(anchor !== undefined ? { anchor } : {}),
      ...(parentId !== undefined ? { parentSessionId: parentId } : {}),
    });
    for (const fork of forks) {
      visit(fork.root, `${baseSessionId}/fork/${fork.root.uuid}`, fork.anchor, sessionId);
    }
  };

  if (roots.length === 0) return chains;
  visit(roots[0]!, baseSessionId);
  for (let i = 1; i < roots.length; i += 1) {
    const extra = buildChain(roots[i]!, []);
    chains[0]!.nodes.push(...extra);
  }
  return chains;
}

/* ------------------------------------------------------------------ */

/** Global per-call usage, joined by sessionId (usage/token-usage-*.jsonl). */
interface SessionGlobalUsage {
  /** Rows with source "main" (or no source): same calls as record usage. */
  main: TokenUsageRow[];
  /** Rows from managed subagents (e.g. auto-memory-extractor): telemetry-only. */
  subagent: TokenUsageRow[];
}

function addRow(target: Usage, row: TokenUsageRow): void {
  target.inputTokens = (target.inputTokens ?? 0) + (row.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (row.outputTokens ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (row.cachedTokens ?? 0);
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (row.thoughtsTokens ?? 0);
}

function addUsage(target: Usage, add: Usage): void {
  target.inputTokens = (target.inputTokens ?? 0) + (add.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (add.outputTokens ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0);
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (add.reasoningTokens ?? 0);
}

/** Build the session-level Manifest from raw lines + projected records. */
function buildManifest(
  sessionId: string,
  lines: RawLine[],
  records: AhsRecord[],
  runtime: RuntimeMeta | undefined,
  globalUsage: SessionGlobalUsage | undefined,
  durationMs: number | undefined,
  branches?: Record<string, { parentRecordId: string }>,
): Manifest {
  const firstWith = <K extends keyof RawLine>(key: K): string | undefined => {
    for (const line of lines) {
      const value = line[key];
      if (typeof value === "string" && value !== "") return value;
    }
    return undefined;
  };

  let model: string | undefined;
  for (const line of lines) {
    if (line.type === "assistant" && typeof line.model === "string") {
      model = line.model;
      break;
    }
  }

  // Exclusive aggregation (spec §四): this session's own records, plus — for
  // the base session only — the managed-subagent usage that exists ONLY in
  // the global per-call files (telemetry without content, spec §五).
  const totalUsage: Usage = {};
  let recordUsageCount = 0;
  for (const rec of records) {
    if (rec.usage !== undefined) {
      recordUsageCount += 1;
      addUsage(totalUsage, rec.usage);
    }
  }
  if (globalUsage !== undefined) {
    // Fallback: the source recorded per-call usage but no record-level
    // usageMetadata — never drop it (AC-0002-B-2).
    if (recordUsageCount === 0) {
      for (const row of globalUsage.main) addRow(totalUsage, row);
    }
    for (const row of globalUsage.subagent) addRow(totalUsage, row);
  }
  for (const key of Object.keys(totalUsage) as (keyof Usage)[]) {
    if (totalUsage[key] === 0) delete totalUsage[key];
  }

  let turnCount = 0;
  for (const rec of records) {
    if (rec.type === "user_message") turnCount += 1;
  }

  const branch = firstWith("gitBranch");
  const branchRegistry: Manifest["branches"] = {
    main: { parentBranch: null, parentRecordId: null },
  };
  if (branches !== undefined) {
    for (const [name, info] of Object.entries(branches)) {
      branchRegistry[name] = { parentBranch: "main", parentRecordId: info.parentRecordId };
    }
  }
  const lastRecordId = records.length > 0 ? records[records.length - 1]!.recordId : null;
  const hasUsage = Object.keys(totalUsage).length > 0;
  return {
    sessionId,
    harness: "qwen-code",
    harnessVersion: firstWith("version") ?? runtime?.qwen_version ?? "unknown",
    ahsVersion: AHS_VERSION,
    cwd: firstWith("cwd") ?? runtime?.work_dir ?? "",
    ...(branch !== undefined ? { git: { branch } } : {}),
    model: model ?? "unknown",
    branches: branchRegistry,
    HEAD: { branch: "main", recordId: lastRecordId },
    stats: {
      turnCount,
      ...(hasUsage ? { totalUsage } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
  };
}

interface ProjectedSession {
  manifest: Manifest;
  /** Main branch records. */
  records: AhsRecord[];
  /** Branch name → records. */
  branchRecords: Map<string, AhsRecord[]>;
}

interface ProjectedFile {
  session: ProjectedSession | null;
}

export class QwenCodeAdapter implements HarnessAdapter {
  readonly harness = "qwen-code";
  readonly capabilities = { history: "full", control: false } as const;

  private readonly basePath: string;
  /** Per-file projection memo; projection is a pure function of file content. */
  private readonly fileCache = new Map<string, Promise<ProjectedFile>>();
  private globalUsageCache: Promise<Map<string, SessionGlobalUsage>> | undefined;
  private durationCache: Promise<Map<string, number>> | undefined;

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(homedir(), ".qwen");
  }

  /** Discover chat sessions under projects/-<cwd>/chats/, deterministically. */
  private async discover(): Promise<SessionSource[]> {
    const sessions: SessionSource[] = [];
    let projectDirs: string[];
    try {
      projectDirs = (await readdir(path.join(this.basePath, "projects"), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }

    for (const projectDir of projectDirs) {
      const chatsDir = path.join(this.basePath, "projects", projectDir, "chats");
      let entries: string[];
      try {
        entries = (await readdir(chatsDir)).sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const sessionId = entry.slice(0, -".jsonl".length);
        let runtime: RuntimeMeta | undefined;
        try {
          runtime = JSON.parse(
            await readFile(path.join(chatsDir, `${sessionId}.runtime.json`), "utf8"),
          ) as RuntimeMeta;
        } catch {
          runtime = undefined;
        }
        sessions.push({
          sessionId,
          filePath: path.join(chatsDir, entry),
          ...(runtime !== undefined ? { runtime } : {}),
        });
      }
    }
    return sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  /** Load usage/token-usage-*.jsonl once, grouped by sessionId and source. */
  private loadGlobalUsage(): Promise<Map<string, SessionGlobalUsage>> {
    this.globalUsageCache ??= (async () => {
      const bySession = new Map<string, SessionGlobalUsage>();
      let files: string[];
      try {
        files = (await readdir(path.join(this.basePath, "usage")))
          .filter((f) => f.startsWith("token-usage-") && f.endsWith(".jsonl"))
          .sort();
      } catch {
        return bySession;
      }
      for (const file of files) {
        const rows = parseJsonl<TokenUsageRow>(
          await readFile(path.join(this.basePath, "usage", file), "utf8"),
        );
        for (const row of rows) {
          if (typeof row.sessionId !== "string") continue;
          let entry = bySession.get(row.sessionId);
          if (entry === undefined) {
            entry = { main: [], subagent: [] };
            bySession.set(row.sessionId, entry);
          }
          if (row.source === undefined || row.source === "main") entry.main.push(row);
          else entry.subagent.push(row);
        }
      }
      return bySession;
    })();
    return this.globalUsageCache;
  }

  /** Load usage_record.jsonl once: sessionId → summed durationMs. */
  private loadDurations(): Promise<Map<string, number>> {
    this.durationCache ??= (async () => {
      const durations = new Map<string, number>();
      try {
        const rows = parseJsonl<UsageRecordRow>(
          await readFile(path.join(this.basePath, "usage_record.jsonl"), "utf8"),
        );
        for (const row of rows) {
          if (typeof row.sessionId !== "string" || typeof row.durationMs !== "number") continue;
          durations.set(row.sessionId, (durations.get(row.sessionId) ?? 0) + row.durationMs);
        }
      } catch {
        // No summary file — durationMs stays absent.
      }
      return durations;
    })();
    return this.durationCache;
  }

  /**
   * Project one chat file into sessions (main chain + fork sessions).
   * Pure in the file contents; memoized. Global usage/duration join only the
   * base session (fork ids are synthetic — no global rows exist for them).
   */
  private projectFile(session: SessionSource): Promise<ProjectedFile> {
    let cached = this.fileCache.get(session.filePath);
    if (cached === undefined) {
      cached = this.doProjectFile(session);
      this.fileCache.set(session.filePath, cached);
    }
    return cached;
  }

  private async doProjectFile(session: SessionSource): Promise<ProjectedFile> {
    const lines = parseJsonl<RawLine>(await readFile(session.filePath, "utf8"));
    const roots = buildTree(lines);
    const chains = linearize(roots, session.sessionId);
    const globalUsage = (await this.loadGlobalUsage()).get(session.sessionId);
    const durationMs = (await this.loadDurations()).get(session.sessionId);

    let mainRecords: AhsRecord[] = [];
    const branchRecords = new Map<string, AhsRecord[]>();
    const branchMeta: Record<string, { parentRecordId: string }> = {};
    let branchIndex = 0;
    let isBaseChain = true;

    for (const chain of chains) {
      const chainLines = chain.nodes.map((n) => n.line);
      const records = projectRecords(chainLines);

      if (chain.anchor === undefined || chain.parentSessionId === undefined) {
        // Main chain
        mainRecords = records;
      } else {
        // Fork → branch. Resolve the anchor to the nearest ancestor with a
        // projected record in the parent chain.
        let node: TreeNode | null = chain.anchor;
        let anchorRec: AhsRecord | undefined;
        const parentRecords = chain.parentSessionId === session.sessionId
          ? mainRecords
          : branchRecords.get(chain.parentSessionId) ?? [];
        while (node !== null && anchorRec === undefined) {
          anchorRec = parentRecords.find((r) => r.recordId === node!.uuid);
          node = node.parent;
        }
        branchIndex += 1;
        const branchName = `b${String(branchIndex).padStart(3, "0")}`;
        if (records.length > 0) {
          branchRecords.set(branchName, records);
          branchMeta[branchName] = {
            parentRecordId: anchorRec?.recordId ?? "",
          };
        }
      }
      isBaseChain = false;
    }

    if (mainRecords.length === 0) return { session: null };

    const manifest = buildManifest(
      session.sessionId,
      lines,
      mainRecords,
      session.runtime,
      globalUsage,
      durationMs,
      branchMeta,
    );
    return { session: { manifest, records: mainRecords, branchRecords } };
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    if (filter?.harness !== undefined && filter.harness !== this.harness) return;
    for (const session of await this.discover()) {
      const { session: projected } = await this.projectFile(session);
      if (projected === null) continue;
      if (filter?.cwd !== undefined && projected.manifest.cwd !== filter.cwd) continue;
      yield projected.manifest;
    }
  }

  async readManifest(sessionId: string): Promise<Manifest> {
    const discovered = await this.discover();
    for (const session of discovered) {
      if (session.sessionId === sessionId) {
        const { session: projected } = await this.projectFile(session);
        if (projected === null) break;
        return projected.manifest;
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }

  async *readRecords(sessionId: string, branchName?: string): AsyncIterable<AhsRecord> {
    const discovered = await this.discover();
    for (const session of discovered) {
      if (session.sessionId === sessionId) {
        const { session: projected } = await this.projectFile(session);
        if (projected === null) throw new Error(`session not found: ${sessionId}`);
        const targetBranch = branchName ?? "main";
        if (targetBranch === "main") {
          yield* projected.records;
        } else {
          const brecords = projected.branchRecords.get(targetBranch);
          if (brecords === undefined) throw new Error(`branch not found: ${targetBranch}`);
          yield* brecords;
        }
        return;
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }
}
