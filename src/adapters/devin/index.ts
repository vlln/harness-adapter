import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Devin (CLI) → AHS read-only projection.
 *
 * Source layout (docs/research/schemas/devin-schema.md):
 *   ~/.local/share/devin/cli/sessions.db    SQLite, opened READ-ONLY
 *   tables used: sessions, message_nodes (the rest is dropped — see below)
 *
 * FOREST → MULTI-SESSION: message_nodes is a forest — several roots
 * (parent_node_id NULL) per Devin session, each a competing exploration
 * branch. Each root's tree becomes one AHS session:
 * - The winning chain: sessions.main_chain_id points at a node INSIDE the
 *   winning tree (real data: the chain TIP, not the root — the research
 *   doc's "root node_id" is an erratum). The main root is found by walking
 *   parent_node_id up from main_chain_id; fallback when main_chain_id is
 *   NULL/unresolvable: the root with the lowest node_id. Its AHS session id
 *   is the bare Devin slug, with Manifest.isMainChain = true.
 * - Every other root → AHS session `<slug>#root-<nodeId>` with
 *   relation { type: "sibling_attempt", sessionId: <slug> } (no toolCallId
 *   — sibling_attempt has no anchor semantics). Nodes whose parent is
 *   missing (deleted-parent gap) are treated as additional roots.
 *
 * DEDUP: Devin stores branch retries as sibling nodes carrying the SAME
 * chat_message.message_id (real data: 2,250 nodes vs 1,192 distinct
 * message_ids). Within one tree the FIRST occurrence of a message_id
 * (pre-order DFS, children ordered by created_at then node_id) is emitted;
 * later duplicates are skipped and their children re-anchor to the first
 * occurrence's last emitted record (forwarding map).
 *
 * Content mapping:
 * - role user → user_message; user with metadata.is_user_input === false →
 *   harness_message (harness impersonating the user).
 * - role system → harness_message (Devin intro, context blocks, subagent
 *   profiles — conversation nodes, kept verbatim).
 * - role assistant → assistant_message: thinking.thinking → thinking block,
 *   non-empty content → text block. tool_calls[] → one tool_call record per
 *   entry (recordId `<message_id>/tool_call/<index>`). When the message has
 *   only tool_calls, usage rides on the first tool_call (AC-0002-N-4).
 * - role tool → tool_result { toolCallId: tool_call_id, content verbatim }.
 *   Duplicate results for one toolCallId: first in DFS order wins. Status
 *   derived after projection: paired → completed, dangling → interrupted
 *   (no synthetic result, AC-0002-B-1).
 * - Usage: assistant metadata.metrics { input_tokens, output_tokens,
 *   cache_read_tokens, cache_creation_tokens, total_time_ms } → record-level
 *   Usage (ttft_ms / tpot_ms / tokens_per_sec are streaming timing —
 *   dropped, ADR-0001). Empty assistant nodes (no content, no tool_calls)
 *   are skipped entirely; when such a node carries metrics (15 nodes in the
 *   observed corpus) their usage is lost with them — bounded, documented in
 *   the container Report. Session-level
 *   metadata.total_credit_cost → Manifest.stats.totalUsage.cost
 *   { amount, currency: "credit" } on the MAIN CHAIN ONLY: the credit cost
 *   is a Devin-session-level aggregate that cannot be attributed to
 *   individual trees, so replicating it into sibling manifests would
 *   multiply-count it in cross-session aggregation (AC-0004). Sibling
 *   sessions carry no cost. total_acu_cost has no schema home and is
 *   DROPPED (0.0 everywhere in the observed corpus — finding reported
 *   in the container Report, not worked around).
 *
 * Drops (process/rendering/telemetry, ADR-0001): rendered_commits,
 * prompt_history, tool_call_state, app_state, cogs_json, agent_mode,
 * backend_type, node metadata telemetry (request_id, chisel/*, compact/*
 * branch-retry lineage, is_system_prefix). Node metadata "summarized_from"
 * (true compaction signal) never fired in the observed corpus; when it
 * appears it should become a compaction record — flagged as follow-up.
 * Devin records no CLI version in the DB → harnessVersion "unknown".
 * title is user-provided per research → titleOrigin "custom".
 *
 * Determinism: sessions ordered by id; roots by node_id; children by
 * (created_at, node_id); recordIds are source message_ids (unique after
 * dedup); timestamps from Unix-seconds created_at → ISO 8601. No
 * wall-clock reads — output is byte-identical across runs.
 *
 * NOTE on WAL: to sweep a LIVE Devin CLI database, copy sessions.db to a
 * temp path first (avoids lock/WAL interaction with the running CLI).
 */

export const AHS_VERSION = "0.1.0";

interface SessionRow {
  id: string;
  working_directory: string;
  model: string;
  created_at: number;
  last_activity_at: number;
  title: string | null;
  main_chain_id: number | null;
  metadata: string | null;
}

interface NodeRow {
  node_id: number;
  parent_node_id: number | null;
  chat_message: string;
  created_at: number;
}

interface ChatMessage {
  message_id?: string;
  role?: string;
  content?: string;
  thinking?: { thinking?: string };
  tool_calls?: {
    id?: string;
    name?: string;
    arguments?: unknown;
    index?: number;
    kind?: string;
  }[];
  tool_call_id?: string;
  metadata?: {
    is_user_input?: boolean | null;
    metrics?: {
      input_tokens?: number | null;
      output_tokens?: number | null;
      cache_read_tokens?: number | null;
      cache_creation_tokens?: number | null;
      total_time_ms?: number | null;
    } | null;
  };
}

function isoFromSeconds(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function mapMetrics(m: NonNullable<NonNullable<ChatMessage["metadata"]>["metrics"]>): Usage {
  const usage: Usage = {};
  if (m.input_tokens != null) usage.inputTokens = m.input_tokens;
  if (m.output_tokens != null) usage.outputTokens = m.output_tokens;
  if (m.cache_read_tokens != null) usage.cacheReadTokens = m.cache_read_tokens;
  if (m.cache_creation_tokens != null) usage.cacheWriteTokens = m.cache_creation_tokens;
  if (m.total_time_ms != null) usage.durationMs = m.total_time_ms;
  return usage;
}

function sumUsageInto(target: Usage, add: Usage): void {
  target.inputTokens = (target.inputTokens ?? 0) + (add.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (add.outputTokens ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0);
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (add.reasoningTokens ?? 0);
  target.durationMs = (target.durationMs ?? 0) + (add.durationMs ?? 0);
  for (const key of Object.keys(target) as (keyof Usage)[]) {
    if (key !== "cost" && key !== "durationMs" && target[key] === 0) delete target[key];
  }
  if (target.durationMs === 0) delete target.durationMs;
}

interface TreeProjection {
  rootNodeId: number;
  records: AhsRecord[];
}

/** Fields shared by every emitted record; built by emitNode. */
type RecordSpecific =
  | { type: "user_message"; content: ContentBlock[] }
  | { type: "harness_message"; content: ContentBlock[] }
  | { type: "assistant_message"; content: ContentBlock[]; usage?: Usage }
  | {
      type: "tool_call";
      toolCallId: string;
      name: string;
      args: unknown;
      kind?: string;
      usage?: Usage;
    }
  | { type: "tool_result"; toolCallId: string; content: string; status: "success" };

/**
 * Project ONE root's subtree into AHS records. Nodes are linked by
 * parent_node_id; emission is pre-order DFS with children ordered by
 * (created_at, node_id); seq = emission index.
 */
export function projectTree(nodes: NodeRow[], rootNodeId: number): AhsRecord[] {
  const byId = new Map<number, NodeRow>();
  const children = new Map<number, NodeRow[]>();
  for (const n of nodes) {
    byId.set(n.node_id, n);
    if (n.parent_node_id !== null) {
      const list = children.get(n.parent_node_id);
      if (list !== undefined) list.push(n);
      else children.set(n.parent_node_id, [n]);
    }
  }
  const byOrder = (a: NodeRow, b: NodeRow): number =>
    a.created_at - b.created_at || a.node_id - b.node_id;
  for (const list of children.values()) list.sort(byOrder);

  const records: AhsRecord[] = [];
  // message_id -> last recordId emitted for its FIRST occurrence (dedup).
  const firstOccurrence = new Map<string, string>();
  // node_id -> recordId children should parent to.
  const resolved = new Map<number, string | null>();
  const seenResults = new Set<string>();

  const emitNode = (node: NodeRow, parentRecordId: string | null): void => {
    let msg: ChatMessage;
    try {
      msg = JSON.parse(node.chat_message) as ChatMessage;
    } catch {
      resolved.set(node.node_id, parentRecordId); // children re-anchor
      return;
    }
    const messageId = msg.message_id ?? `node-${node.node_id}`;
    const timestamp = isoFromSeconds(node.created_at);

    const first = firstOccurrence.get(messageId);
    if (first !== undefined) {
      // Branch-retry duplicate of an already-emitted message: skip, forward.
      resolved.set(node.node_id, first);
      return;
    }

    let lastEmitted: string | null = null;
    const emit = (specific: RecordSpecific, recordId: string): void => {
      const base = {
        recordId,
        parentId: lastEmitted ?? parentRecordId,
        timestamp,
        seq: records.length,
      };
      records.push({ ...base, ...specific } as AhsRecord);
      lastEmitted = recordId;
    };

    if (msg.role === "user" || msg.role === "system") {
      const type =
        msg.role === "system" || msg.metadata?.is_user_input === false
          ? "harness_message"
          : "user_message";
      emit({ type, content: [{ type: "text", text: msg.content ?? "" }] }, messageId);
    } else if (msg.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (typeof msg.thinking?.thinking === "string" && msg.thinking.thinking !== "") {
        blocks.push({ type: "thinking", text: msg.thinking.thinking });
      }
      if (typeof msg.content === "string" && msg.content !== "") {
        blocks.push({ type: "text", text: msg.content });
      }
      const usage = msg.metadata?.metrics != null ? mapMetrics(msg.metadata.metrics) : undefined;
      const hasUsage = usage !== undefined && Object.keys(usage).length > 0;
      if (blocks.length > 0) {
        emit(
          {
            type: "assistant_message",
            content: blocks,
            ...(hasUsage && usage !== undefined ? { usage } : {}),
          },
          messageId,
        );
      }
      let index = 0;
      for (const tc of msg.tool_calls ?? []) {
        // Tool-only message: usage rides on the first tool_call so it is
        // not silently lost.
        const carryUsage = lastEmitted === null && index === 0 && hasUsage;
        emit(
          {
            type: "tool_call",
            toolCallId: tc.id ?? "",
            name: tc.name ?? "",
            args: tc.arguments,
            ...(tc.kind !== undefined ? { kind: tc.kind } : {}),
            ...(carryUsage && usage !== undefined ? { usage } : {}),
          },
          `${messageId}/tool_call/${tc.index ?? index}`,
        );
        index += 1;
      }
      if (lastEmitted === null) {
        // Empty assistant node (no blocks, no tool calls) — skip emission.
        resolved.set(node.node_id, parentRecordId);
        return;
      }
    } else if (msg.role === "tool") {
      const callId = msg.tool_call_id ?? "";
      if (seenResults.has(callId)) {
        // Duplicate result for one toolCallId: first in DFS order wins.
        resolved.set(node.node_id, parentRecordId);
        return;
      }
      seenResults.add(callId);
      emit(
        { type: "tool_result", toolCallId: callId, content: msg.content ?? "", status: "success" },
        messageId,
      );
    } else {
      // Unknown role: skip emission, children re-anchor.
      resolved.set(node.node_id, parentRecordId);
      return;
    }

    firstOccurrence.set(messageId, lastEmitted ?? parentRecordId ?? messageId);
    resolved.set(node.node_id, lastEmitted);
  };

  const walk = (node: NodeRow, parentRecordId: string | null): void => {
    emitNode(node, parentRecordId);
    const next = resolved.has(node.node_id) ? (resolved.get(node.node_id) ?? null) : parentRecordId;
    for (const child of children.get(node.node_id) ?? []) {
      walk(child, next);
    }
  };
  const root = byId.get(rootNodeId);
  if (root === undefined) return records;
  walk(root, null);

  // Derive tool_call status from the pairing outcome (XOR per spec).
  const paired = new Set<string>();
  for (const rec of records) {
    if (rec.type === "tool_result") paired.add(rec.toolCallId);
  }
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (rec === undefined || rec.type !== "tool_call") continue;
    records[i] = { ...rec, status: paired.has(rec.toolCallId) ? "completed" : "interrupted" };
  }

  return records;
}

/** All root node_ids of a session's forest (NULL or missing parents). */
function findRoots(nodes: NodeRow[]): number[] {
  const ids = new Set(nodes.map((n) => n.node_id));
  return nodes
    .filter((n) => n.parent_node_id === null || !ids.has(n.parent_node_id))
    .map((n) => n.node_id)
    .sort((a, b) => a - b);
}

/** Walk up from main_chain_id to its tree's root; fallback: lowest root. */
function findMainRoot(nodes: NodeRow[], roots: number[], mainChainId: number | null): number {
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  if (mainChainId !== null && byId.has(mainChainId)) {
    let cur = byId.get(mainChainId);
    const seen = new Set<number>();
    while (
      cur !== undefined &&
      cur.parent_node_id !== null &&
      byId.has(cur.parent_node_id) &&
      !seen.has(cur.node_id)
    ) {
      seen.add(cur.node_id);
      cur = byId.get(cur.parent_node_id);
    }
    if (cur !== undefined && roots.includes(cur.node_id)) return cur.node_id;
  }
  return roots[0] ?? 0;
}

function buildManifest(
  row: SessionRow,
  sessionId: string,
  records: AhsRecord[],
  extra: { isMainChain?: boolean; relation?: Manifest["relation"]; includeCost?: boolean },
): Manifest {
  const totalUsage: Usage = {};
  let turnCount = 0;
  for (const rec of records) {
    if (rec.type === "user_message") turnCount += 1;
    if (rec.usage !== undefined) sumUsageInto(totalUsage, rec.usage);
  }
  // Session-level credit cost (billing unit) rides in stats.totalUsage.cost
  // of the main chain only (see module doc: no per-tree attribution).
  if (extra.includeCost === true) {
    let creditCost: number | undefined;
    try {
      const meta = JSON.parse(row.metadata ?? "{}") as { total_credit_cost?: number };
      creditCost = meta.total_credit_cost;
    } catch {
      creditCost = undefined;
    }
    if (creditCost !== undefined) {
      totalUsage.cost = { amount: creditCost, currency: "credit" };
    }
  }
  const hasUsage = Object.keys(totalUsage).length > 0;

  return {
    sessionId,
    harness: "devin",
    harnessVersion: "unknown", // no CLI version in the DB
    ahsVersion: AHS_VERSION,
    cwd: row.working_directory,
    model: row.model,
    ...(row.title !== null ? { title: row.title, titleOrigin: "custom" as const } : {}),
    ...(extra.relation !== undefined ? { relation: extra.relation } : {}),
    ...(extra.isMainChain === true ? { isMainChain: true } : {}),
    stats: {
      turnCount,
      ...(hasUsage ? { totalUsage } : {}),
      durationMs: Math.max(0, (row.last_activity_at - row.created_at) * 1000),
    },
  };
}

export class DevinAdapter implements HarnessAdapter {
  readonly harness = "devin";
  readonly capabilities = { history: "full", control: false } as const;

  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(homedir(), ".local", "share", "devin", "cli", "sessions.db");
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.dbPath, { readOnly: true });
  }

  private loadSessions(db: DatabaseSync): SessionRow[] {
    return db
      .prepare(
        `SELECT id, working_directory, model, created_at, last_activity_at,
                title, main_chain_id, metadata
         FROM sessions WHERE hidden = 0 ORDER BY id`,
      )
      .all() as unknown as SessionRow[];
  }

  private loadNodes(db: DatabaseSync, sessionId: string): NodeRow[] {
    return db
      .prepare(
        `SELECT node_id, parent_node_id, chat_message, created_at
         FROM message_nodes WHERE session_id = ? ORDER BY node_id`,
      )
      .all(sessionId) as unknown as NodeRow[];
  }

  /** Project one Devin session row into its per-root tree projections. */
  private projectSession(
    db: DatabaseSync,
    row: SessionRow,
  ): { main: TreeProjection; siblings: TreeProjection[] } | null {
    const nodes = this.loadNodes(db, row.id);
    const roots = findRoots(nodes);
    if (roots.length === 0) return null;
    const mainRoot = findMainRoot(nodes, roots, row.main_chain_id);
    const main: TreeProjection = { rootNodeId: mainRoot, records: projectTree(nodes, mainRoot) };
    const siblings = roots
      .filter((r) => r !== mainRoot)
      .map((r) => ({ rootNodeId: r, records: projectTree(nodes, r) }));
    return { main, siblings };
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    if (filter?.harness !== undefined && filter.harness !== this.harness) return;
    const db = this.open();
    try {
      for (const row of this.loadSessions(db)) {
        const projected = this.projectSession(db, row);
        if (projected === null || projected.main.records.length === 0) continue;
        const main = buildManifest(row, row.id, projected.main.records, {
          isMainChain: true,
          includeCost: true,
        });
        if (filter?.cwd !== undefined && main.cwd !== filter.cwd) continue;
        yield main;
        for (const sibling of projected.siblings) {
          if (sibling.records.length === 0) continue;
          yield buildManifest(row, `${row.id}#root-${sibling.rootNodeId}`, sibling.records, {
            relation: { type: "sibling_attempt", sessionId: row.id },
          });
        }
      }
    } finally {
      db.close();
    }
  }

  async *readRecords(sessionId: string): AsyncIterable<AhsRecord> {
    // Parse the `<slug>#root-<nodeId>` sibling form.
    const match = /^(.*)#root-(\d+)$/.exec(sessionId);
    const slug = match?.[1] ?? sessionId;
    const db = this.open();
    try {
      const rows = this.loadSessions(db).filter((r) => r.id === slug);
      const row = rows[0];
      if (row === undefined) throw new Error(`session not found: ${sessionId}`);
      const projected = this.projectSession(db, row);
      if (projected === null) throw new Error(`session not found: ${sessionId}`);
      if (match === null) {
        yield* projected.main.records;
        return;
      }
      const rootNodeId = Number(match[2]);
      const sibling = projected.siblings.find((s) => s.rootNodeId === rootNodeId);
      if (sibling === undefined && projected.main.rootNodeId !== rootNodeId) {
        throw new Error(`session not found: ${sessionId}`);
      }
      yield* (sibling ?? projected.main).records;
    } finally {
      db.close();
    }
  }
}
