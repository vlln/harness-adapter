import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { Lineage } from "../../schema/relation";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Claude Code → AHS read-only projection (ADR-0005 linear-session model).
 *
 * Source layout (docs/research/schemas/claude-code-schema.md):
 *   <base>/<project-dir>/<session-uuid>.jsonl          main session stream
 *   <base>/<project-dir>/<session-uuid>/subagents/
 *     agent-<agent-id>.jsonl                           sub-agent stream
 *     agent-<agent-id>.meta.json                       { agentType, description, toolUseId }
 *
 * Linearization (spec §五 "Graph + sidechain" row):
 * - The source parentUuid graph is NOT a reliable fork structure. Real files
 *   rewrite records mid-stream, producing artifact multi-child nodes:
 *   (a) lines re-logged under the SAME uuid (content-identical, possibly
 *       metadata-only diffs) — the first occurrence anchors the chain
 *       structure, later ones are dropped (usage, a running value, is taken
 *       from the last occurrence — see computeUsageByUuid);
 *   (b) assistant lines sharing one `message.id` are streamed SEGMENTS of
 *       ONE logical message (blocks accumulate across lines; tool results
 *       interleave between segments) — segments stay in the chain in file
 *       order, they never fork;
 *   (c) tool_result-only user lines parented at the same tool_call are
 *       parallel result deliveries and/or exact duplicate deliveries — they
 *       always stay in the same chain as their tool_call (file order), and
 *       the same toolCallId is emitted only once per file (first delivery in
 *       chain-processing order wins; AC-0002-N-6 first-in-file-order rule);
 *   (d) goal_update/compaction state events are control-plane re-writes —
 *       they chain, they never become fork branches.
 * - After (a)–(d), a kept node with 2+ remaining conversational children is
 *   a REAL branch point (edit-resend / retry / interrupt). The main chain
 *   leads to the last leaf (max file index; append-only storage ⇒ file
 *   order is the recency order). Every other child subtree becomes a fork
 *   session storing only its suffix: sessionId `<main>/fork/<branch-root
 *   uuid>`, lineage atRecordId = the anchor node's first projected record in
 *   the parent session, type by that record's type (user_message ⇔
 *   sibling_attempt, else forked_from).
 * - Fork chains may contain further branch points → nested fork sessions
 *   whose lineage points at the fork session holding the anchor.
 * - Chain restarts (kept line with parentUuid null/unknown mid-file) are
 *   re-anchored to the previous kept line, preserving a single root.
 *
 * Record mapping (lossy projection, ADR-0001):
 * - uuid → recordId as-is. Records of dropped types
 *   (queue-operation / last-prompt / system / mode / permission-mode /
 *   non-goal attachments / ...) are simply dropped; the linear model needs
 *   no parent forwarding.
 * - `attachment` records with subtype `goal_status` are harness goal
 *   verdicts (control plane) → `goal_update`. Mapping: `sentinel: true`
 *   (goal registered, no verdict yet) → "pending"; verdict records map
 *   `met: boolean` → "met" / "unmet"; `reason` kept when present. The
 *   source has no goal id, so goalId is omitted.
 * - Assistant `tool_use` blocks are split out of the assistant message into
 *   their own `tool_call` records. Within one source record the emitted
 *   records follow in order (assistant_message → tool_call → …); emission
 *   order is preserved via seq.
 * - When an assistant message has only tool_use blocks, no assistant_message
 *   is emitted; the usage (must not be silently lost, AC-0002-N-4) rides on
 *   the first tool_call record.
 * - tool_result blocks live inside `user` records (array content). String
 *   content is kept verbatim; non-string content is JSON.stringify'd.
 * - tool_call status is derived after projection: "completed"/"failed" from
 *   the paired tool_result status; "interrupted" when the session ends
 *   without a paired result (no synthetic result record is emitted).
 * - Compaction: Claude marks compaction with `isCompactSummary: true` on a
 *   user record (content = the continued-context summary) → `compaction`
 *   records. Session titles come from legacy `type: "summary"` lines
 *   (`summary` field) or current `type: "ai-title"` lines (`aiTitle`
 *   field) → Manifest.title (titleOrigin "generated"). Title lines belong to
 *   no chain; only the main session carries the title.
 * - Claude Code has no explicit harness-injected-message markers, so no
 *   `harness_message` records are emitted; such messages stay user_message
 *   (source-unavailable provenance, per spec).
 *
 * Subagents (invocation two-link, AC-0002-N-2):
 * - Each `subagents/agent-*.jsonl` file is one child session; inline
 *   `isSidechain: true` records in the main file are grouped by `agentId`
 *   into child sessions as well. Child sessionId = agentId. Child files may
 *   themselves fork (same linearization; forks inherit the invocation
 *   transitively per ADR-0005 — it is not copied onto fork manifests).
 * - Back-link: invocation.atRecordId = the parent's spawning Task tool_call
 *   record, located via meta.json `toolUseId` (fallback: the first line's
 *   `sourceToolUseID`) matched against tool_call records of every session
 *   projected from the same main file. The link is only anchored when the
 *   paired tool_result exists in the SAME session (an interrupted Task call
 *   has nothing to carry the forward link; AC-0002-B-3 form is used then).
 * - Forward link: that paired tool_result gets `sessionIds: [<child agentId>]`.
 *
 * Usage: coarse totals only (input/output/cache read/cache write); the
 * ephemeral 1h/5m tiers, service_tier, inference_geo, server_tool_use are
 * dropped per ADR-0001. For segmented messages (one `message.id` streamed
 * across several assistant lines) usage is taken from the LAST segment —
 * intermediate segments carry duplicate running values, not additive data.
 *
 * Determinism (AC-0002-N-5): directory entries are sorted, chains and seq
 * follow file order, recordIds are source uuids, fork ids are derived from
 * source uuids — no wall-clock reads anywhere.
 */

export const AHS_VERSION = "0.1.0";

/** Loose view of a source JSONL line; only the fields we read are typed. */
interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  agentId?: string;
  sourceToolUseID?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  summary?: string;
  /** Current Claude Code versions emit the session title as ai-title lines. */
  aiTitle?: string;
  attachment?: {
    type?: string;
    met?: boolean;
    sentinel?: boolean;
    reason?: string;
    condition?: string;
    iterations?: number;
  };
  message?: {
    role?: string;
    id?: string;
    model?: string;
    content?: string | RawBlock[];
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

/** A sub-agent belonging to a main session: separate file and/or inline group. */
interface ChildSource {
  agentId: string;
  meta?: AgentMeta;
  filePath?: string;
  /** Parsed lines of filePath, loaded lazily by loadSession. */
  fileLines?: RawLine[];
}

interface SessionSource {
  sessionId: string;
  filePath: string;
  children: ChildSource[];
}

function parseJsonl(content: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    lines.push(JSON.parse(trimmed) as RawLine);
  }
  return lines;
}

function mapUsage(raw: NonNullable<NonNullable<RawLine["message"]>["usage"]>): Usage {
  const usage: Usage = {};
  if (raw.input_tokens !== undefined) usage.inputTokens = raw.input_tokens;
  if (raw.output_tokens !== undefined) usage.outputTokens = raw.output_tokens;
  if (raw.cache_creation_input_tokens !== undefined) {
    usage.cacheWriteTokens = raw.cache_creation_input_tokens;
  }
  if (raw.cache_read_input_tokens !== undefined) {
    usage.cacheReadTokens = raw.cache_read_input_tokens;
  }
  return usage;
}

type RawUsage = NonNullable<NonNullable<RawLine["message"]>["usage"]>;

/**
 * Per-stream usage lookup: assistant uuid → the usage to emit for it.
 * Assistant lines sharing one `message.id` are segments of one logical
 * message, and intermediate segments carry the same running request usage
 * (input repeats, output 0) — only the FINAL segment of a message.id reports
 * the completed message's usage, so only that segment's uuid maps here.
 * When a uuid is re-logged (duplicate regions), the LAST occurrence's usage
 * wins — it is the newest write of the same running value. Assistant lines
 * without a message.id are not in the map; they keep their own usage.
 */
function computeUsageByUuid(stream: RawLine[]): Map<string, RawUsage> {
  const lastLineByUuid = new Map<string, RawLine>();
  const finalSegmentByMid = new Map<string, string>();
  for (const line of stream) {
    if (line.uuid !== undefined) lastLineByUuid.set(line.uuid, line);
    if (line.type === "assistant" && line.uuid !== undefined) {
      const mid = line.message?.id;
      if (mid !== undefined && mid !== "") finalSegmentByMid.set(mid, line.uuid);
    }
  }
  const map = new Map<string, RawUsage>();
  for (const uuid of finalSegmentByMid.values()) {
    const usage = lastLineByUuid.get(uuid)?.message?.usage;
    if (usage !== undefined) map.set(uuid, usage);
  }
  return map;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

/**
 * Project the lines of ONE chain (main line, fork suffix, or one sub-agent's
 * lines) into an AHS record list, in the given order. `seenToolResults` is
 * threaded across all chains of one file: duplicate result deliveries (stream
 * rewrite artifacts) are emitted once per toolCallId per file, so a fork
 * suffix never re-emits a delivery already present in an ancestor session.
 *
 * Usage of segmented messages: taken from `usageByUuid` (see
 * computeUsageByUuid) — only the final segment of a message.id carries the
 * logical message's usage. "Final" is judged per STREAM, not per chain:
 * duplicated file regions (the same messages re-logged under new uuids after
 * e.g. a cwd change) may land on different chains, and chain-local judgment
 * would double-count their usage.
 */
export function projectRecords(
  lines: RawLine[],
  seenToolResults: Set<string> = new Set<string>(),
  usageByUuid?: Map<string, RawUsage>,
): AhsRecord[] {
  const records: AhsRecord[] = [];
  let seq = 0;

  // Defaults to the chain-local computation when called standalone.
  const usageLookup = usageByUuid ?? computeUsageByUuid(lines);

  const emit = (rec: AhsRecord): void => {
    records.push(rec);
    seq += 1;
  };

  lines.forEach((line) => {
    const uuid = line.uuid;
    const timestamp = line.timestamp ?? "";

    if (line.type === "user" && uuid !== undefined) {
      if (line.isCompactSummary === true) {
        // Compaction marker: the user record's string content IS the
        // continued-context summary (a key state event, not conversation).
        const summary =
          typeof line.message?.content === "string" ? line.message.content : undefined;
        emit({
          recordId: uuid,
          seq,
          timestamp,
          type: "compaction",
          ...(summary !== undefined ? { summary } : {}),
        });
      } else {
        const content = line.message?.content;
        if (typeof content === "string") {
          // Verbatim, including slash-command XML markup (do not parse).
          emit({
            recordId: uuid,
            seq,
            timestamp,
            type: "user_message",
            content: [{ type: "text", text: content }],
          });
        } else if (Array.isArray(content)) {
          const textBlocks: ContentBlock[] = [];
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              textBlocks.push({ type: "text", text: block.text });
            }
          }
          if (textBlocks.length > 0) {
            emit({
              recordId: uuid,
              seq,
              timestamp,
              type: "user_message",
              content: textBlocks,
            });
          }
          let toolResultIndex = 0;
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const toolCallId = block.tool_use_id ?? "";
            // Duplicate result deliveries (stream rewrites) are dropped;
            // the first delivery in chain-processing order wins.
            if (seenToolResults.has(toolCallId)) continue;
            seenToolResults.add(toolCallId);
            // tool_result blocks share the source uuid; suffix keeps
            // recordIds unique and deterministic when there are several.
            const recordId =
              toolResultIndex === 0 ? uuid : `${uuid}/tool_result/${toolResultIndex}`;
            toolResultIndex += 1;
            emit({
              recordId,
              seq,
              timestamp,
              type: "tool_result",
              toolCallId,
              content: stringifyToolResultContent(block.content),
              status: block.is_error === true ? "error" : "success",
            });
          }
        }
      }
    } else if (
      line.type === "attachment" &&
      line.attachment?.type === "goal_status" &&
      uuid !== undefined
    ) {
      // Harness goal verdict (control plane) → goal_update.
      const reason = line.attachment.reason;
      const status =
        line.attachment.sentinel === true
          ? ("pending" as const)
          : line.attachment.met === true
            ? ("met" as const)
            : ("unmet" as const);
      emit({
        recordId: uuid,
        seq,
        timestamp,
        type: "goal_update",
        status,
        ...(reason !== undefined ? { reason } : {}),
      });
    } else if (line.type === "assistant" && uuid !== undefined) {
      const msg = line.message ?? {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const contentBlocks: ContentBlock[] = [];
      const toolUses: RawBlock[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          contentBlocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          contentBlocks.push({ type: "thinking", text: block.thinking });
        } else if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }
      // Usage comes from the stream-level lookup (final segment of the
      // message.id only); lines without a message.id keep their own usage.
      // Model is identical across segments — kept on every segment.
      const mid = msg.id;
      const rawUsage =
        mid === undefined || mid === "" ? msg.usage : usageLookup.get(uuid);
      const usage = rawUsage !== undefined ? mapUsage(rawUsage) : undefined;
      const model = msg.model;
      const extras = {
        ...(usage !== undefined ? { usage } : {}),
        ...(model !== undefined ? { model } : {}),
      };
      let emitted = contentBlocks.length > 0;
      if (contentBlocks.length > 0) {
        emit({
          ...extras,
          recordId: uuid,
          seq,
          timestamp,
          type: "assistant_message",
          content: contentBlocks,
        });
      }
      let toolCallIndex = 0;
      for (const block of toolUses) {
        // When no assistant_message was emitted (tool_use-only message),
        // usage/model ride on the first tool_call so usage is not lost.
        const carryExtras = !emitted && toolCallIndex === 0 ? extras : {};
        const recordId =
          toolCallIndex === 0 && contentBlocks.length === 0
            ? uuid
            : `${uuid}/tool_use/${toolCallIndex}`;
        toolCallIndex += 1;
        emit({
          ...carryExtras,
          recordId,
          seq,
          timestamp,
          type: "tool_call",
          toolCallId: block.id ?? "",
          name: block.name ?? "",
          args: block.input,
        });
        emitted = true;
      }
    }
    // All other types (queue-operation, last-prompt, summary, system, mode,
    // permission-mode, non-goal attachments, ...) are dropped per ADR-0001
    // (process/telemetry).
  });

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

/* ------------------------------------------------------------------ *
 * Linearization: source parentUuid graph → linear chains + fork specs *
 * ------------------------------------------------------------------ */

/** What a kept line's FIRST emitted record is (drives lineage type judgment). */
type NodeKind = "user" | "delivery" | "compaction" | "goal" | "assistant";

interface TreeNode {
  uuid: string;
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
 * projects nothing (dropped process types, empty content) and is collapsed
 * through during tree building.
 */
function nodeKind(line: RawLine): NodeKind | null {
  if (line.type === "user") {
    if (line.isCompactSummary === true) return "compaction";
    const content = line.message?.content;
    if (typeof content === "string") return "user";
    if (Array.isArray(content)) {
      const hasText = content.some((b) => b.type === "text" && typeof b.text === "string");
      const hasResult = content.some((b) => b.type === "tool_result");
      if (hasText) return "user";
      if (hasResult) return "delivery";
    }
    return null;
  }
  if (line.type === "attachment") {
    return line.attachment?.type === "goal_status" ? "goal" : null;
  }
  if (line.type === "assistant") {
    const content = line.message?.content;
    if (!Array.isArray(content)) return null;
    const emittable = content.some(
      (b) =>
        (b.type === "text" && typeof b.text === "string") ||
        (b.type === "thinking" && typeof b.thinking === "string") ||
        b.type === "tool_use",
    );
    return emittable ? "assistant" : null;
  }
  return null;
}

/**
 * Build the kept-record tree over one line stream. Duplicate lines sharing a
 * uuid (a known rewrite artifact: identical or metadata-only-different
 * re-logs) keep their FIRST occurrence; later ones are dropped — recordIds
 * must stay unique. Dropped lines forward their children to the nearest kept
 * ancestor. Lines whose parent chain is unknown/null mid-stream re-anchor to
 * the previous kept node (chain restarts), preserving a single root.
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
    if (line.uuid === undefined) return;
    if (nodes.has(line.uuid)) return; // duplicate uuid re-log — first wins
    const kind = nodeKind(line);
    if (kind === null) return; // dropped — children forward through it
    const node: TreeNode = {
      uuid: line.uuid,
      line,
      index,
      kind,
      parent: null,
      children: [],
      subtreeMax: index,
    };
    // Resolve the nearest kept ancestor through dropped lines.
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
    // Chain restart: no kept ancestor but a chain already exists → re-anchor.
    if (parent === null && lastNode !== null) parent = lastNode;
    node.parent = parent;
    if (parent === null) roots.push(node);
    else parent.children.push(node);
    nodes.set(node.uuid, node);
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
 * Linearize the kept tree into chains. Most multi-child nodes in real files
 * are NOT user forks but storage artifacts, and their children stay in the
 * chain (file order):
 * - tool_result-only user lines are parallel/duplicate result deliveries of
 *   the same tool_call(s);
 * - assistant lines sharing a `message.id` are streamed SEGMENTS of one
 *   logical message (blocks accumulate across lines, tool results interleave
 *   between segments) — segments chain, they never fork;
 * - state events (goal_update, compaction) are control-plane re-writes, not
 *   conversational branches.
 * The remaining children are real alternative continuations (edit-resend /
 * retry / interrupt): the one whose subtree holds the last leaf (max file
 * index; append-only storage ⇒ file order is recency) continues the chain;
 * every other becomes a fork session.
 */
function linearize(roots: TreeNode[], baseSessionId: string): ChainSpec[] {
  const chains: ChainSpec[] = [];

  const buildChain = (root: TreeNode, forks: { anchor: TreeNode; root: TreeNode }[]): TreeNode[] => {
    const out: TreeNode[] = [];
    // Iterative pre-order (real files have chains longer than the call
    // stack): children that stay in the chain are pushed in reverse file
    // order so they pop in file order, each subtree fully before the next.
    const stack: TreeNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      out.push(node);
      if (node.children.length === 0) continue;
      // Segment detection: assistant children sharing one message.id (with
      // each other, or with the parent) are one logical message.
      const midCounts = new Map<string, number>();
      const nodeMid = node.line.message?.id;
      for (const child of node.children) {
        const mid = child.line.message?.id;
        if (child.kind === "assistant" && mid !== undefined && mid !== "") {
          midCounts.set(mid, (midCounts.get(mid) ?? 0) + 1);
        }
      }
      const staysInChain = (child: TreeNode): boolean => {
        if (child.kind !== "assistant" && child.kind !== "user") return true;
        const mid = child.line.message?.id;
        return (
          child.kind === "assistant" &&
          mid !== undefined &&
          mid !== "" &&
          ((midCounts.get(mid) ?? 0) > 1 || mid === nodeMid)
        );
      };
      const alternatives: TreeNode[] = [];
      const chained: TreeNode[] = [];
      for (const child of node.children) {
        if (staysInChain(child)) chained.push(child);
        else alternatives.push(child);
      }
      let main: TreeNode | undefined;
      for (const child of alternatives) {
        if (main === undefined || child.subtreeMax > main.subtreeMax) main = child;
      }
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i]!;
        if (child === main || chained.includes(child)) stack.push(child);
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
      visit(fork.root, `${baseSessionId}/fork/${fork.root.uuid}`, fork.anchor, sessionId);
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

/* ------------------------------------------------------------------ */

/** Build the session-level Manifest from raw lines + projected records. */
function buildManifest(
  sessionId: string,
  lines: RawLine[],
  records: AhsRecord[],
  relations?: { invocation?: Manifest["invocation"]; lineage?: Manifest["lineage"] },
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
    if (line.type === "assistant" && typeof line.message?.model === "string") {
      model = line.message.model;
      break;
    }
  }

  const totalUsage: Usage = {};
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
    }
  }
  // Omit zero-fields the source never reported.
  for (const key of Object.keys(totalUsage) as (keyof Usage)[]) {
    if (totalUsage[key] === 0) delete totalUsage[key];
  }

  const branch = firstWith("gitBranch");
  // Legacy `type:"summary"` lines carry the title in `summary`; current
  // versions emit `type:"ai-title"` lines with an `aiTitle` field. Title
  // lines belong to no chain, so only chains whose lines include them
  // (in practice: the main chain of a main file) get a title.
  const title = firstWith("summary") ?? firstWith("aiTitle");
  const hasUsage = Object.keys(totalUsage).length > 0;
  return {
    sessionId,
    harness: "claude-code",
    harnessVersion: firstWith("version") ?? "unknown",
    ahsVersion: AHS_VERSION,
    cwd: firstWith("cwd") ?? "",
    ...(branch !== undefined ? { git: { branch } } : {}),
    model: model ?? "unknown",
    ...(title !== undefined ? { title, titleOrigin: "generated" as const } : {}),
    ...(relations?.lineage !== undefined ? { lineage: relations.lineage } : {}),
    ...(relations?.invocation !== undefined ? { invocation: relations.invocation } : {}),
    stats: {
      turnCount,
      ...(hasUsage ? { totalUsage } : {}),
    },
  };
}

/** One fully projected session (manifest + records) of a source file. */
interface ProjectedSession {
  manifest: Manifest;
  records: AhsRecord[];
}

/** All sessions projected from one main file (main chain, forks, children). */
interface ProjectedFile {
  /** sessionId → projected session, in deterministic listing order. */
  sessions: Map<string, ProjectedSession>;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly harness = "claude-code";
  readonly capabilities = { history: "full", control: false } as const;

  private readonly basePath: string;
  /** Per-file projection memo; projection is a pure function of file content. */
  private readonly fileCache = new Map<string, Promise<ProjectedFile>>();

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(homedir(), ".claude", "projects");
  }

  /** Discover main sessions and their sub-agent sources, deterministically. */
  private async discover(): Promise<SessionSource[]> {
    const sessions: SessionSource[] = [];
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
      const projectPath = path.join(this.basePath, projectDir);
      const entries = (await readdir(projectPath, { withFileTypes: true }))
        .map((e) => e.name)
        .sort();
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const sessionId = entry.slice(0, -".jsonl".length);
        const children = new Map<string, ChildSource>();

        const subagentsDir = path.join(projectPath, sessionId, "subagents");
        let subEntries: string[] = [];
        try {
          subEntries = (await readdir(subagentsDir)).sort();
        } catch {
          subEntries = [];
        }
        for (const sub of subEntries) {
          // child sessionId = bare agentId, same form as the inline `agentId` field
          const match = /^agent-(.+)\.(jsonl|meta\.json)$/.exec(sub);
          if (match === null) continue;
          const agentId = match[1]!;
          const kind = match[2]!;
          let child = children.get(agentId);
          if (child === undefined) {
            child = { agentId };
            children.set(agentId, child);
          }
          const full = path.join(subagentsDir, sub);
          if (kind === "jsonl") {
            child.filePath = full;
          } else {
            child.meta = JSON.parse(await readFile(full, "utf8")) as AgentMeta;
          }
        }

        sessions.push({
          sessionId,
          filePath: path.join(projectPath, entry),
          children: [...children.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
        });
      }
    }
    return sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  /**
   * Split main-file lines into the main chain (isSidechain falsy) and inline
   * sidechain groups keyed by agentId.
   */
  private static splitMainLines(lines: RawLine[]): {
    main: RawLine[];
    inline: Map<string, RawLine[]>;
  } {
    const main: RawLine[] = [];
    const inline = new Map<string, RawLine[]>();
    for (const line of lines) {
      if (line.isSidechain === true && typeof line.agentId === "string") {
        const group = inline.get(line.agentId);
        if (group !== undefined) group.push(line);
        else inline.set(line.agentId, [line]);
      } else {
        main.push(line);
      }
    }
    return { main, inline };
  }

  /** Child lines: prefer the subagent file; fall back to the inline group. */
  private static childLines(child: ChildSource, inline: Map<string, RawLine[]>): RawLine[] {
    if (child.filePath !== undefined) {
      return child.fileLines ?? [];
    }
    return inline.get(child.agentId) ?? [];
  }

  /** Merge file-based children with inline-only sidechain groups. */
  private static mergedChildren(
    session: SessionSource,
    inline: Map<string, RawLine[]>,
  ): ChildSource[] {
    const byId = new Map<string, ChildSource>();
    for (const child of session.children) byId.set(child.agentId, child);
    for (const agentId of inline.keys()) {
      if (!byId.has(agentId)) byId.set(agentId, { agentId });
    }
    return [...byId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  /**
   * Project one main session file (main chain + fork sessions + sub-agent
   * sessions with invocation two-links). Pure in the file contents; memoized.
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
    const lines = parseJsonl(await readFile(session.filePath, "utf8"));
    const { main, inline } = ClaudeCodeAdapter.splitMainLines(lines);
    const children = ClaudeCodeAdapter.mergedChildren(session, inline);
    for (const child of children) {
      if (child.filePath !== undefined) {
        child.fileLines = parseJsonl(await readFile(child.filePath, "utf8"));
      }
    }

    const sessions = new Map<string, ProjectedSession>();
    // File-level duplicate result-delivery tracking, threaded through every
    // chain projection of this file in deterministic (chain list) order.
    const seenToolResults = new Set<string>();

    /** Project one line stream into chains and register the sessions. */
    const projectChains = (
      stream: RawLine[],
      baseSessionId: string,
      /** Extra lines scanned only for Manifest fields (e.g. title lines). */
      manifestExtraLines: RawLine[] = [],
    ): void => {
      const roots = buildTree(stream);
      const chains = linearize(roots, baseSessionId);
      // Usage is stream-scoped (final segment of a message.id anywhere in
      // the stream; duplicated file regions may place segments of one
      // message on different chains).
      const usageByUuid = computeUsageByUuid(stream);
      let isBaseChain = true;
      for (const chain of chains) {
        const chainLines = chain.nodes.map((n) => n.line);
        const records = projectRecords(chainLines, seenToolResults, usageByUuid);
        let lineage: Lineage | undefined;
        if (chain.anchor !== undefined && chain.parentSessionId !== undefined) {
          // Resolve the anchor to the nearest ancestor with a projected
          // record in the parent session (a branch point whose own records
          // were all deduped forwards to its kept ancestors).
          let node: TreeNode | null = chain.anchor;
          let anchorRec: AhsRecord | undefined;
          const parentRecords = sessions.get(chain.parentSessionId)?.records ?? [];
          while (node !== null && anchorRec === undefined) {
            anchorRec = parentRecords.find((r) => r.recordId === node!.uuid);
            node = node.parent;
          }
          lineage = {
            type: anchorRec?.type === "user_message" ? "sibling_attempt" : "forked_from",
            sessionId: chain.parentSessionId,
            ...(anchorRec !== undefined ? { atRecordId: anchorRec.recordId } : {}),
          };
        }
        // Title/summary lines belong to no chain; they feed only the base
        // (main) session's Manifest via manifestExtraLines.
        const manifestLines = isBaseChain ? [...chainLines, ...manifestExtraLines] : chainLines;
        isBaseChain = false;
        const manifest = buildManifest(chain.sessionId, manifestLines, records, {
          ...(lineage !== undefined ? { lineage } : {}),
        });
        sessions.set(chain.sessionId, { manifest, records });
      }
    };

    // Main file chains (main session + its forks). Title lines
    // (legacy `summary`, current `ai-title`) live outside every chain.
    projectChains(
      main,
      session.sessionId,
      main.filter((l) => l.type === "summary" || l.type === "ai-title"),
    );
    // Sub-agent sessions: same linearization; invocation is resolved below
    // once every session of the file exists (anchors may live in any of them,
    // including forks and sibling sub-agent sessions for nested spawns).
    const childInfos: { agentId: string; child: ChildSource; lines: RawLine[] }[] = [];
    for (const child of children) {
      const cLines = ClaudeCodeAdapter.childLines(child, inline);
      if (cLines.length === 0) continue;
      childInfos.push({ agentId: child.agentId, child, lines: cLines });
      projectChains(cLines, child.agentId);
    }

    // Invocation two-links (AC-0002-N-2). Anchor = the Task tool_call whose
    // toolCallId matches meta.toolUseId (fallback: the child stream's first
    // sourceToolUseID). Anchored only when the paired tool_result exists in
    // the same session — an interrupted call has nothing to carry the
    // forward link, so the child falls back to the AC-0002-B-3 form.
    const anchorByToolCallId = new Map<
      string,
      { sessionId: string; callRecordId: string }
    >();
    for (const [sid, projected] of sessions) {
      const resultIds = new Set(
        projected.records.filter((r) => r.type === "tool_result").map((r) => r.toolCallId),
      );
      for (const rec of projected.records) {
        if (rec.type !== "tool_call" || !resultIds.has(rec.toolCallId)) continue;
        if (!anchorByToolCallId.has(rec.toolCallId)) {
          anchorByToolCallId.set(rec.toolCallId, { sessionId: sid, callRecordId: rec.recordId });
        }
      }
    }
    for (const { agentId, child, lines: cLines } of childInfos) {
      const projected = sessions.get(agentId);
      if (projected === undefined || projected.records.length === 0) continue;
      const toolUseId =
        child.meta?.toolUseId ??
        cLines.find((l) => typeof l.sourceToolUseID === "string")?.sourceToolUseID;
      const anchor = toolUseId !== undefined ? anchorByToolCallId.get(toolUseId) : undefined;
      const invocation: Manifest["invocation"] =
        anchor !== undefined
          ? { sessionId: anchor.sessionId, atRecordId: anchor.callRecordId }
          : // Anchor source-unavailable (toolUseId absent or the call's
            // result never landed): agent-level parent link only (B-3).
            { sessionId: session.sessionId };
      projected.manifest = { ...projected.manifest, invocation };
      if (anchor !== undefined && toolUseId !== undefined) {
        // Forward link: the paired tool_result carries the child sessionId.
        const parent = sessions.get(anchor.sessionId)!;
        parent.records = parent.records.map((rec) =>
          rec.type === "tool_result" && rec.toolCallId === toolUseId && rec.sessionIds === undefined
            ? { ...rec, sessionIds: [agentId] }
            : rec,
        );
      }
    }

    // Drop sessions with zero projectable records (process-record-only
    // chains are not AHS sessions).
    for (const [sid, projected] of sessions) {
      if (projected.records.length === 0) sessions.delete(sid);
    }
    return { sessions };
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    if (filter?.harness !== undefined && filter.harness !== this.harness) return;
    const includeForks = filter?.includeForks === true;
    for (const session of await this.discover()) {
      const { sessions } = await this.projectFile(session);
      for (const projected of sessions.values()) {
        const { manifest } = projected;
        // Default view: group HEADs only — lineage descendants (forks) are
        // folded away unless includeForks is set (interface-0001). The main
        // chain is the HEAD: it leads to the last leaf of the append-only
        // file, i.e. the most recently updated chain of the group.
        if (!includeForks && manifest.lineage !== undefined) continue;
        if (filter?.cwd !== undefined && manifest.cwd !== filter.cwd) continue;
        yield manifest;
      }
    }
  }

  async *readRecords(sessionId: string): AsyncIterable<AhsRecord> {
    const discovered = await this.discover();
    // Fast path: a main session file named by the id.
    for (const session of discovered) {
      if (session.sessionId === sessionId) {
        const { sessions } = await this.projectFile(session);
        // A file with zero projectable records (process records only) is not
        // an AHS session: yield nothing, do not fall through to the scan.
        yield* sessions.get(sessionId)?.records ?? [];
        return;
      }
    }
    // Fork sessions and sub-agent sessions: scan projected files.
    for (const session of discovered) {
      const { sessions } = await this.projectFile(session);
      const projected = sessions.get(sessionId);
      if (projected !== undefined) {
        yield* projected.records;
        return;
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }
}
