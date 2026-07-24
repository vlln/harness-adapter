import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Pi Agent → AHS read-only projection (ADR-0005 linear-session model).
 *
 * Source layout (docs/research/schemas/pi-agent-schema.md):
 *   <base>/--<cwd-sanitized>--/<iso-ts>_<session-ulid>.jsonl
 * One JSONL file per session, protocol version 3. The first record is the
 * `session` record (id/cwd/timestamp); every later record links via
 * `parentId` into a causal tree of 4 record types: model_change,
 * thinking_level_change, message.
 *
 * Linearization (spec §五 "Tree" row):
 * - The tree is linear in practice: parallel tool results of one assistant
 *   message are CHAINED (each toolResult parents the next), so multi-child
 *   nodes are genuine branch points (edit-resend / retry — observed in real
 *   storage as one assistant message with several user-message children).
 * - Main chain = the child subtree holding the last leaf (max file index;
 *   append-only storage ⇒ file order is recency). Every other child subtree
 *   becomes a fork session storing only its suffix: sessionId
 *   `<main>/fork/<branch-root id>`, lineage atRecordId = the anchor node's
 *   first projected record in the parent session, type by that record's
 *   type (forked_from).
 * - Chain restarts (parentId null/unknown mid-file) re-anchor to the
 *   previous kept line, preserving a single root.
 *
 * Record mapping (lossy projection, ADR-0001):
 * - Source hex8 `id` → recordId as-is.
 * - `model_change` → `model_change` record { model: modelId, provider }.
 * - `thinking_level_change` → `model_change` record carrying the CURRENT
 *   model/provider (source-derived from the latest model_change); the
 *   thinkingLevel itself has no AHS home and is dropped (container mapping
 *   rule). A thinking_level_change before any model_change is dropped.
 * - `message` role user → `user_message` (text blocks, verbatim).
 * - role assistant → `assistant_message` (text + thinking blocks in order;
 *   thinkingSignature dropped) with toolCall blocks split out into their own
 *   `tool_call` records (assistant_message first, then tool_calls, in
 *   emission order). A tool-call-only message emits no assistant_message; its usage and
 *   model ride on the first tool_call so usage is not lost (AC-0002-N-4).
 * - role toolResult → `tool_result`; text blocks joined with "\n"; status
 *   from the source `isError` flag. Duplicate deliveries of one toolCallId
 *   keep the first in file order (AC-0002-N-6).
 * - Assistant `stopReason` ("stop"/"toolUse"/"error"/"aborted"),
 *   `errorMessage`, `api`, `responseId` and the message-level Unix-ms
 *   `timestamp` have no AHS home and are dropped; the record-level ISO
 *   `timestamp` is the single timestamp (dual-timestamp unification).
 *   Error messages carry empty content and all-zero usage — they project
 *   nothing (zero usage contributes nothing to the sums).
 * - The session record's `parentSession` pointer (cross-file
 *   continue-from) maps to lineage { type: "forked_from", sessionId }.
 *   The child file re-logs the shared prefix (full copy = fork pattern).
 *
 * Usage: the most complete of all harnesses — input/output/cacheRead/
 * cacheWrite/reasoning tokens plus a cost breakdown. Mapping: tokens as-is;
 * cost omitted when the source provides no currency (AHS requires currency;
 * Pi records none — cost is dropped rather than assuming USD).
 * `totalTokens` is dropped (sum of the parts, redundant).
 *
 * Determinism (AC-0002-N-5): directory entries are sorted, chains
 * follow file order, recordIds are source ids, fork ids derive from source
 * ids — no wall-clock reads anywhere.
 */

export const AHS_VERSION = "0.1.0";

/** Loose view of a source JSONL line; only the fields we read are typed. */
interface RawLine {
  type?: string;
  version?: number;
  id?: string;
  parentId?: string | null;
  parentSession?: string;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  message?: {
    role?: string;
    content?: RawBlock[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    model?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      reasoning?: number;
      totalTokens?: number;
      cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      };
    };
    stopReason?: string;
  };
}

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

type RawUsage = NonNullable<NonNullable<RawLine["message"]>["usage"]>;

function parseJsonl(content: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    lines.push(JSON.parse(trimmed) as RawLine);
  }
  return lines;
}

function mapUsage(raw: RawUsage): Usage {
  const usage: Usage = {};
  if (raw.input !== undefined) usage.inputTokens = raw.input;
  if (raw.output !== undefined) usage.outputTokens = raw.output;
  if (raw.cacheRead !== undefined) usage.cacheReadTokens = raw.cacheRead;
  if (raw.cacheWrite !== undefined) usage.cacheWriteTokens = raw.cacheWrite;
  if (raw.reasoning !== undefined) usage.reasoningTokens = raw.reasoning;
  if (raw.cost?.total !== undefined) {
    // Source provides no currency field; AHS requires currency.
    // Omit cost entirely rather than assuming USD (no escape hatch).
  }
  return usage;
}

/** What a kept line's FIRST emitted record is (drives lineage type judgment). */
type NodeKind = "user" | "assistant" | "delivery" | "state";

interface TreeNode {
  id: string;
  line: RawLine;
  /** File index of the line. */
  index: number;
  kind: NodeKind;
  parent: TreeNode | null;
  children: TreeNode[];
  /** Max file index over this node's subtree (drives main-chain selection). */
  subtreeMax: number;
}

/**
 * The kind of a line's first projected record, or null when the line
 * projects nothing (a thinking_level_change before any model_change, an
 * error/empty assistant message, a user message without text) and is
 * collapsed through during tree building.
 */
function nodeKind(line: RawLine): NodeKind | null {
  if (line.type === "model_change") return "state";
  if (line.type === "thinking_level_change") return "state";
  if (line.type !== "message") return null;
  const msg = line.message ?? {};
  if (msg.role === "user") {
    const hasText = (msg.content ?? []).some(
      (b) => b.type === "text" && typeof b.text === "string",
    );
    return hasText ? "user" : null;
  }
  if (msg.role === "assistant") {
    const emittable = (msg.content ?? []).some(
      (b) =>
        (b.type === "text" && typeof b.text === "string") ||
        (b.type === "thinking" && typeof b.thinking === "string") ||
        b.type === "toolCall",
    );
    return emittable ? "assistant" : null;
  }
  if (msg.role === "toolResult") return "delivery";
  return null;
}

/**
 * Build the kept-record tree over one file's lines. The `session` record is
 * not a node (it feeds the Manifest only). Dropped lines forward their
 * children to the nearest kept ancestor. Lines whose parent chain is
 * unknown/null mid-file re-anchor to the previous kept node (chain
 * restarts), preserving a single root.
 */
function buildTree(lines: RawLine[]): TreeNode[] {
  const byId = new Map<string, RawLine>();
  for (const line of lines) {
    if (line.id !== undefined && !byId.has(line.id)) byId.set(line.id, line);
  }

  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  let lastNode: TreeNode | null = null;
  lines.forEach((line, index) => {
    if (line.type === "session" || line.id === undefined) return;
    if (nodes.has(line.id)) return; // duplicate id re-log — first wins
    const kind = nodeKind(line);
    if (kind === null) return; // dropped — children forward through it
    const node: TreeNode = {
      id: line.id,
      line,
      index,
      kind,
      parent: null,
      children: [],
      subtreeMax: index,
    };
    let parent: TreeNode | null = null;
    let p = line.parentId ?? null;
    const seen = new Set<string>();
    while (p !== null && !seen.has(p)) {
      seen.add(p);
      const candidate = nodes.get(p);
      if (candidate !== undefined) {
        parent = candidate;
        break;
      }
      const parentLine = byId.get(p);
      if (parentLine === undefined) break;
      p = parentLine.parentId ?? null;
    }
    // Chain restart: no kept ancestor but a chain already exists → re-anchor.
    if (parent === null && lastNode !== null) parent = lastNode;
    node.parent = parent;
    if (parent === null) roots.push(node);
    else parent.children.push(node);
    nodes.set(node.id, node);
    lastNode = node;
  });

  // subtreeMax via iterative post-order (roots are already in file order).
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
  /** Chain nodes in emission order. */
  nodes: TreeNode[];
  /** Fork chains only: the branch-point node in the parent chain. */
  anchor?: TreeNode;
  /** Fork chains only: sessionId of the chain holding the anchor. */
  parentSessionId?: string;
}

/**
 * Linearize the kept tree into chains. Every multi-child node is a real
 * branch point (pi chains parallel tool results via parentId, so siblings
 * are genuine alternative continuations): the child whose subtree holds the
 * last leaf (max file index) continues the chain; every other becomes a
 * fork session.
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
      let main: TreeNode | undefined;
      for (const child of node.children) {
        if (main === undefined || child.subtreeMax > main.subtreeMax) main = child;
      }
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i]!;
        if (child === main) stack.push(child);
        else forks.push({ anchor: node, root: child });
      }
    }
    return out;
  };

  const visit = (root: TreeNode, sessionId: string, anchor?: TreeNode, parentId?: string): void => {
    const forks: { anchor: TreeNode; root: TreeNode }[] = [];
    const nodes = buildChain(root, forks);
    chains.push({ sessionId, nodes, ...(anchor !== undefined ? { anchor } : {}),
      ...(parentId !== undefined ? { parentSessionId: parentId } : {}) });
    for (const fork of forks) {
      visit(fork.root, `${baseSessionId}/fork/${fork.root.id}`, fork.anchor, sessionId);
    }
  };

  if (roots.length === 0) return chains;
  visit(roots[0]!, baseSessionId);
  // Re-anchoring keeps a single root in practice; tolerate extras by
  // appending them to the main chain (no lineage edge exists for them).
  for (let i = 1; i < roots.length; i += 1) {
    const extra = buildChain(roots[i]!, []);
    chains[0]!.nodes.push(...extra);
  }
  return chains;
}

/**
 * Project the lines of ONE chain into an AHS record list, in the given
 * order. `seenToolResults` is threaded across all chains of one file:
 * duplicate result deliveries are emitted once per toolCallId per file, so
 * a fork suffix never re-emits a delivery already present in an ancestor
 * session. `initialModel` seeds the current-model tracker for fork
 * suffixes (their thinking_level_change lines need the model in effect at
 * the branch point).
 */
export function projectRecords(
  lines: RawLine[],
  seenToolResults: Set<string> = new Set<string>(),
  initialModel?: { model: string; provider?: string },
): AhsRecord[] {
  const records: AhsRecord[] = [];
  let currentModel = initialModel;

  const emit = (rec: AhsRecord): void => {
    records.push(rec);
  };

  for (const line of lines) {
    const id = line.id;
    const timestamp = line.timestamp ?? "";
    if (id === undefined) continue;

    if (line.type === "model_change") {
      const model = line.modelId ?? "unknown";
      currentModel = {
        model,
        ...(line.provider !== undefined ? { provider: line.provider } : {}),
      };
      emit({
        recordId: id,
        timestamp,
        type: "model_change",
        model,
        ...(line.provider !== undefined ? { provider: line.provider } : {}),
      });
    } else if (line.type === "thinking_level_change") {
      // thinkingLevel has no AHS home (dropped); the event is kept as a
      // model_change record carrying the current (source-derived) model.
      // Before any model_change there is no current model — drop.
      if (currentModel === undefined) continue;
      emit({
        recordId: id,
        timestamp,
        type: "model_change",
        model: currentModel.model,
        ...(currentModel.provider !== undefined ? { provider: currentModel.provider } : {}),
      });
    } else if (line.type === "message") {
      const msg = line.message ?? {};
      if (msg.role === "user") {
        const textBlocks: ContentBlock[] = [];
        for (const block of msg.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            textBlocks.push({ type: "text", text: block.text });
          }
        }
        if (textBlocks.length > 0) {
          emit({ recordId: id, timestamp, type: "user_message", content: textBlocks });
        }
      } else if (msg.role === "assistant") {
        const contentBlocks: ContentBlock[] = [];
        const toolCalls: RawBlock[] = [];
        for (const block of msg.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            contentBlocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            contentBlocks.push({ type: "thinking", text: block.thinking });
          } else if (block.type === "toolCall") {
            toolCalls.push(block);
          }
        }
        const usage = msg.usage !== undefined ? mapUsage(msg.usage) : undefined;
        const model = msg.model;
        const extras = {
          ...(usage !== undefined ? { usage } : {}),
          ...(model !== undefined ? { model } : {}),
        };
        let emitted = contentBlocks.length > 0;
        if (contentBlocks.length > 0) {
          emit({
            ...extras,
            recordId: id,
              timestamp,
            type: "assistant_message",
            content: contentBlocks,
          });
        }
        let toolCallIndex = 0;
        for (const block of toolCalls) {
          // Tool-call-only message: usage/model ride on the first tool_call.
          const carryExtras = !emitted && toolCallIndex === 0 ? extras : {};
          const recordId =
            toolCallIndex === 0 && contentBlocks.length === 0
              ? id
              : `${id}/toolCall/${toolCallIndex}`;
          toolCallIndex += 1;
          emit({
            ...carryExtras,
            recordId,
              timestamp,
            type: "tool_call",
            toolCallId: block.id ?? "",
            name: block.name ?? "",
            args: block.arguments,
          });
          emitted = true;
        }
      } else if (msg.role === "toolResult") {
        const toolCallId = msg.toolCallId ?? "";
        // Duplicate result deliveries are dropped; first in file order wins.
        if (seenToolResults.has(toolCallId)) continue;
        seenToolResults.add(toolCallId);
        const texts: string[] = [];
        for (const block of msg.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        }
        emit({
          recordId: id,
          timestamp,
          type: "tool_result",
          toolCallId,
          content: texts.join("\n"),
          status: msg.isError === true ? "error" : "success",
        });
      }
    }
  }

  // Derive tool_call status from the pairing outcome: a paired tool_result
  // gives "completed"/"failed" (from the result status); a tool_call whose
  // session ended without a result is "interrupted" — no synthetic result
  // record is emitted.
  const resultStatus = new Map<string, "success" | "error">();
  for (const rec of records) {
    if (rec.type === "tool_result") {
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

/** Build the session-level Manifest from raw lines + projected records. */
function buildManifest(
  sessionId: string,
  lines: RawLine[],
  records: AhsRecord[],
  branches?: Record<string, { parentRecordId: string }>,
): Manifest {
  const sessionLine = lines.find((l) => l.type === "session");

  // Primary model: the file's first model_change (mid-session switches are
  // per-record overrides and model_change records).
  let model: string | undefined;
  let provider: string | undefined;
  for (const line of lines) {
    if (line.type === "model_change") {
      model = line.modelId;
      provider = line.provider;
      break;
    }
  }

  const totalUsage: Usage = {};
  let costAmount = 0;
  let costCurrency: string | undefined;
  let hasCost = false;
  let turnCount = 0;
  for (const rec of records) {
    if (rec.type === "user_message") turnCount += 1;
    if (rec.usage !== undefined) {
      totalUsage.inputTokens = (totalUsage.inputTokens ?? 0) + (rec.usage.inputTokens ?? 0);
      totalUsage.outputTokens = (totalUsage.outputTokens ?? 0) + (rec.usage.outputTokens ?? 0);
      totalUsage.cacheReadTokens =
        (totalUsage.cacheReadTokens ?? 0) + (rec.usage.cacheReadTokens ?? 0);
      totalUsage.cacheWriteTokens =
        (totalUsage.cacheWriteTokens ?? 0) + (rec.usage.cacheWriteTokens ?? 0);
      totalUsage.reasoningTokens =
        (totalUsage.reasoningTokens ?? 0) + (rec.usage.reasoningTokens ?? 0);
      if (rec.usage.cost !== undefined) {
        hasCost = true;
        costAmount += rec.usage.cost.amount;
        costCurrency ??= rec.usage.cost.currency;
      }
    }
  }
  // Omit zero-valued token fields the source never reported.
  for (const key of Object.keys(totalUsage) as (keyof Usage)[]) {
    if (totalUsage[key] === 0) delete totalUsage[key];
  }
  if (hasCost && costCurrency !== undefined) {
    totalUsage.cost = { amount: costAmount, currency: costCurrency };
  }

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
  const parentSession = sessionLine?.parentSession;
  return {
    sessionId,
    harness: "pi",
    // The only version the source has: the storage protocol version.
    harnessVersion:
      sessionLine?.version !== undefined ? String(sessionLine.version) : "unknown",
    ahsVersion: AHS_VERSION,
    cwd: sessionLine?.cwd ?? "",
    model: model ?? "unknown",
    ...(provider !== undefined ? { provider } : {}),
    branches: branchRegistry,
    HEAD: { branch: "main", recordId: lastRecordId },
    ...(parentSession !== undefined ? { lineage: { type: "forked_from" as const, sessionId: parentSession } } : {}),
    stats: {
      turnCount,
      ...(hasUsage ? { totalUsage } : {}),
    },
  };
}

/** One fully projected session (manifest + records) of a source file. */
interface ProjectedSession {
  manifest: Manifest;
  /** Main branch records. */
  records: AhsRecord[];
  /** Branch name → records. */
  branchRecords: Map<string, AhsRecord[]>;
}

/** All sessions projected from one file (main chain + forks). */
interface ProjectedFile {
  /** The session record's id (present even when nothing projects). */
  fileSessionId?: string;
  /** The single projected session with branches. */
  session: ProjectedSession | null;
}

export class PiAdapter implements HarnessAdapter {
  readonly harness = "pi";
  readonly capabilities = { history: "full", control: false } as const;

  private readonly basePath: string;
  /** Per-file projection memo; projection is a pure function of file content. */
  private readonly fileCache = new Map<string, Promise<ProjectedFile>>();

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(homedir(), ".pi", "agent", "sessions");
  }

  /** Discover session files, deterministically (sorted dirs, sorted files). */
  private async discover(): Promise<string[]> {
    const files: string[] = [];
    let projectDirs: string[];
    try {
      projectDirs = (await readdir(this.basePath, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    for (const projectDir of projectDirs) {
      const entries = (await readdir(path.join(this.basePath, projectDir)))
        .filter((e) => e.endsWith(".jsonl"))
        .sort();
      for (const entry of entries) {
        files.push(path.join(this.basePath, projectDir, entry));
      }
    }
    return files;
  }

  /**
   * Project one session file (main chain + fork sessions). Pure in the file
   * content; memoized.
   */
  private projectFile(filePath: string): Promise<ProjectedFile> {
    let cached = this.fileCache.get(filePath);
    if (cached === undefined) {
      cached = this.doProjectFile(filePath);
      this.fileCache.set(filePath, cached);
    }
    return cached;
  }

  private async doProjectFile(filePath: string): Promise<ProjectedFile> {
    const lines = parseJsonl(await readFile(filePath, "utf8"));
    const sessionId = lines.find((l) => l.type === "session")?.id;
    if (sessionId === undefined) return { session: null };

    const roots = buildTree(lines);
    const chains = linearize(roots, sessionId);
    // File-level duplicate result-delivery tracking, threaded through every
    // chain projection of this file in deterministic (chain list) order.
    const seenToolResults = new Set<string>();
    // The model in effect at each fork's branch point (for the fork's
    // thinking_level_change lines and its Manifest primary model).
    let fileModel: { model: string; provider?: string } | undefined;
    for (const line of lines) {
      if (line.type === "model_change") {
        fileModel = {
          model: line.modelId ?? "unknown",
          ...(line.provider !== undefined ? { provider: line.provider } : {}),
        };
        break;
      }
    }

    let mainRecords: AhsRecord[] = [];
    const branchRecords = new Map<string, AhsRecord[]>();
    const branchMeta: Record<string, { parentRecordId: string }> = {};
    let branchIndex = 0;

    for (const chain of chains) {
      const chainLines = chain.nodes.map((n) => n.line);
      const records = projectRecords(chainLines, seenToolResults, fileModel);

      if (chain.anchor === undefined || chain.parentSessionId === undefined) {
        // Main chain
        mainRecords = records;
      } else {
        // Fork → branch. Resolve the anchor to the nearest ancestor with a
        // projected record in the parent chain.
        let node: TreeNode | null = chain.anchor;
        let anchorRec: AhsRecord | undefined;
        const parentRecords = chain.parentSessionId === sessionId
          ? mainRecords
          : branchRecords.get(chain.parentSessionId) ?? [];
        while (node !== null && anchorRec === undefined) {
          anchorRec = parentRecords.find((r) => r.recordId === node!.id);
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
    }

    if (mainRecords.length === 0) return { fileSessionId: sessionId, session: null };

    const manifest = buildManifest(sessionId, lines, mainRecords, branchMeta);
    return {
      fileSessionId: sessionId,
      session: { manifest, records: mainRecords, branchRecords },
    };
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    if (filter?.harness !== undefined && filter.harness !== this.harness) return;
    for (const filePath of await this.discover()) {
      const { session } = await this.projectFile(filePath);
      if (session === null) continue;
      if (filter?.cwd !== undefined && session.manifest.cwd !== filter.cwd) continue;
      yield session.manifest;
    }
  }

  async *readRecords(sessionId: string, branchName?: string): AsyncIterable<AhsRecord> {
    for (const filePath of await this.discover()) {
      const { fileSessionId, session } = await this.projectFile(filePath);
      if (session !== null && fileSessionId === sessionId) {
        const targetBranch = branchName ?? "main";
        if (targetBranch === "main") {
          yield* session.records;
        } else {
          const brecords = session.branchRecords.get(targetBranch);
          if (brecords === undefined) throw new Error(`branch not found: ${targetBranch}`);
          yield* brecords;
        }
        return;
      }
      // A file whose session record projects zero records (process-only) is
      // not an AHS session: yield nothing, do not fall through to the scan.
      if (fileSessionId === sessionId) return;
    }
    throw new Error(`session not found: ${sessionId}`);
  }
}
