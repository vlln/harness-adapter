import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, AhsRecordType, ContentBlock } from "../../schema/record";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Devin (CLI) → AHS read-only projection (ADR-0005 linear-session model).
 *
 * Source layout (docs/research/schemas/devin-schema.md):
 *   ~/.local/share/devin/cli/sessions.db    SQLite, opened READ-ONLY
 *   tables used: sessions, message_nodes (the rest is dropped — see below)
 *
 * FOREST → LINEAR SESSIONS + FORK SYNTHESIS. message_nodes is a forest of
 * trees linked by parent_node_id. The projection is strictly linear:
 * - Each root's tree becomes one LINEAR session: the chain from the root to
 *   the tree's LAST LEAF (max created_at, tie-break max node_id). The main
 *   line is deliberately winner-INDEPENDENT (main_chain_id plays no role) so
 *   that a winner flip never changes the session set (AC-0002-B-4). On the
 *   observed corpus last-leaf and main_chain tip coincide for all trees.
 * - INTRA-TREE BRANCHES: a node with 2+ children keeps the child on the
 *   last-leaf path; every other child starts a fork session
 *   `<slug>#fork-<nodeId>` (nodeId = branch-start node). Real-data shape
 *   (verified on the observed corpus, 513/513 branch points): Devin stores
 *   a branch as TWO TWIN child nodes carrying the SAME assistant
 *   message_id, one of which is always a dead end. A twin-only fork branch
 *   is fully shared with the main line → produces no session at all, so the
 *   old dedup/forwarding-map machinery is gone: "dedup" is now just the
 *   shared-prefix rule below. Real intra-tree forks (both twins continue)
 *   never occurred in the observed corpus but are handled generally.
 * - SHARED-PREFIX / ANCHOR: a fork stores only its suffix. Leading nodes
 *   whose message_id already exists in the ancestor sessions' records are
 *   skipped; the LAST skipped message anchors the lineage
 *   (atRecordId = its record in the owning session). With no leading
 *   duplicate the fork diverges right after the branch point, which becomes
 *   the anchor. Type judgment (AC-0002-N-7): anchor record is a
 *   user_message ⇔ sibling_attempt, anything else ⇔ forked_from.
 * - CROSS-ROOT FORKS: roots after the first (lowest node_id = base root,
 *   AHS session id = the bare slug) become `<slug>#root-<nodeId>` sessions,
 *   anchored against all previously projected sessions of the group. Real
 *   data: the shared prefix is the system prompt (harness_message →
 *   forked_from). A root sharing nothing gets an anchor-less lineage
 *   { type: "sibling_attempt", sessionId: <slug> } — retry from start.
 * - ORPHAN TOOL RESULTS: a fork suffix can contain tool_result nodes for a
 *   tool_call that lives in the shared prefix (real pattern: the twin
 *   assistant message carries calls whose results follow in both subtrees).
 *   Such results are DROPPED in the fork — the call's completion belongs to
 *   the anchored turn, which the parent session already contains; keeping
 *   them would violate tool pairing (AC-0002-N-6). Bounded, judgment call
 *   reported in the container Report.
 * - GROUP HEAD: sessions.main_chain_id points at the winning chain's TIP
 *   (a node, not a root — the research doc's "root node_id" is an erratum).
 *   It is used ONLY to pick the group HEAD for `listSessions` default
 *   (includeForks: false): HEAD = the session that emitted the tip node,
 *   fallback = the session with the latest last-record timestamp (tie:
 *   lowest sessionId). Session ids and records never depend on
 *   main_chain_id, so winner flips move only the derived HEAD (B-4).
 *   Nodes whose parent is missing (deleted-parent gap) are treated as
 *   additional roots.
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
 *   Duplicate results for one toolCallId within one session: first wins.
 *   Status derived after projection: paired → completed, dangling →
 *   interrupted (no synthetic result, AC-0002-B-1).
 * - Usage: assistant metadata.metrics { input_tokens, output_tokens,
 *   cache_read_tokens, cache_creation_tokens, total_time_ms } → record-level
 *   Usage (ttft_ms / tpot_ms / tokens_per_sec are streaming timing —
 *   dropped, ADR-0001). Empty assistant nodes (no content, no tool_calls)
 *   are skipped entirely; when such a node carries metrics (15 nodes in the
 *   observed corpus) their usage is lost with them — bounded, documented in
 *   the container Report. Session-level
 *   metadata.total_credit_cost → Manifest.stats.totalUsage.cost
 *   { amount, currency: "credit" } on the BASE session only: the credit
 *   cost is a Devin-session-level (group-level) aggregate that cannot be
 *   attributed to individual chains. The base session (lowest root) is the
 *   stable home — putting it on the HEAD would move it on winner flips and
 *   break AC-0002-B-4; replicating it into fork manifests would
 *   multiply-count it in cross-session aggregation (AC-0004).
 *   total_acu_cost has no schema home and is DROPPED (0.0 everywhere in the
 *   observed corpus — finding reported in the container Report, not worked
 *   around).
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
 * Determinism: groups ordered by slug; roots by node_id; children by
 * (created_at, node_id); the main child is picked by subtree last-leaf
 * (created_at, node_id); sessions within a group ordered by sessionId;
 * recordIds are source message_ids; timestamps from Unix-seconds created_at
 * → ISO 8601. No wall-clock reads — output is byte-identical across runs.
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

/** Reference to a record in an already-projected session of the group. */
interface EmittedRef {
  sessionId: string;
  recordId: string;
  type: AhsRecordType;
}

/** Fields shared by every emitted record; built by emitMessage. */
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

/** One projected linear session of a group. */
interface SessionProjection {
  sessionId: string;
  records: AhsRecord[];
  lineage?: Manifest["lineage"];
}

interface GroupProjection {
  sessions: SessionProjection[];
  /** Session the group HEAD points at (main_chain tip's owner, else fallback). */
  headSessionId: string;
}

/** All root node_ids of a session's forest (NULL or missing parents). */
function findRoots(nodes: NodeRow[]): number[] {
  const ids = new Set(nodes.map((n) => n.node_id));
  return nodes
    .filter((n) => n.parent_node_id === null || !ids.has(n.parent_node_id))
    .map((n) => n.node_id)
    .sort((a, b) => a - b);
}

function parseChat(node: NodeRow): ChatMessage | undefined {
  try {
    return JSON.parse(node.chat_message) as ChatMessage;
  } catch {
    return undefined;
  }
}

function messageIdOf(node: NodeRow, msg: ChatMessage | undefined): string {
  return msg?.message_id ?? `node-${node.node_id}`;
}

/**
 * Emit one node's records into `records`. Returns the records appended
 * (empty for skipped nodes: unknown role, malformed JSON handled by the
 * caller, empty assistant, in-session duplicate message, duplicate tool
 * result, ancestor-orphaned tool result).
 */
function emitMessage(
  node: NodeRow,
  msg: ChatMessage,
  records: AhsRecord[],
  state: { seenResults: Set<string>; ancestorCallIds: Set<string> },
): AhsRecord[] {
  const messageId = messageIdOf(node, msg);
  const timestamp = isoFromSeconds(node.created_at);
  const appended: AhsRecord[] = [];
  const emit = (specific: RecordSpecific, recordId: string): void => {
    const rec = { recordId, timestamp, seq: records.length, ...specific } as AhsRecord;
    records.push(rec);
    appended.push(rec);
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
      const carryUsage = appended.length === 0 && index === 0 && hasUsage;
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
  } else if (msg.role === "tool") {
    const callId = msg.tool_call_id ?? "";
    const ownCall = records.some((r) => r.type === "tool_call" && r.toolCallId === callId);
    if (!ownCall && state.ancestorCallIds.has(callId)) {
      // Result of a call that lives in the shared prefix: the anchored
      // turn's completion belongs to the parent session — drop (see doc).
      return appended;
    }
    if (state.seenResults.has(callId)) {
      // Duplicate result for one toolCallId: first in chain order wins.
      return appended;
    }
    state.seenResults.add(callId);
    emit(
      { type: "tool_result", toolCallId: callId, content: msg.content ?? "", status: "success" },
      messageId,
    );
  }
  return appended;
}

/**
 * Project one Devin session row (a forest) into linear AHS sessions.
 * Returns null when the forest has no roots or the base chain is empty.
 */
function projectGroup(row: SessionRow, nodes: NodeRow[]): GroupProjection | null {
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

  // subtreeBest: max (created_at, node_id) node of each subtree — the main
  // line always walks toward it (last-leaf heuristic, winner-independent).
  const bestCache = new Map<number, NodeRow>();
  const subtreeBest = (id: number, visiting: Set<number>): NodeRow | undefined => {
    const cached = bestCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return undefined;
    visiting.add(id);
    let best = byId.get(id);
    for (const child of children.get(id) ?? []) {
      const cb = subtreeBest(child.node_id, visiting);
      if (cb !== undefined && (best === undefined || byOrder(best, cb) < 0)) best = cb;
    }
    visiting.delete(id);
    if (best !== undefined) bestCache.set(id, best);
    return best;
  };

  const roots = findRoots(nodes);
  if (roots.length === 0) return null;

  const sessions: SessionProjection[] = [];
  // message_id → anchor ref, across all sessions projected so far.
  const groupIndex = new Map<string, EmittedRef>();
  // toolCallIds seen in all sessions projected so far (orphan-result rule).
  const groupCallIds = new Set<string>();
  // node → session that emitted it (for HEAD tip resolution).
  const nodeSession = new Map<number, string>();

  /**
   * Project one linear chain starting at `startNodeId` into a session.
   * Off-main children spawn fork sessions recursively. `spawnAnchor` is the
   * fork's divergence point when the branch itself shares no leading
   * messages; `fallbackParentId` receives anchor-less lineage edges.
   */
  const processChain = (
    startNodeId: number,
    sessionId: string,
    inheritedIndex: Map<string, EmittedRef>,
    ancestorCallIds: Set<string>,
    ctx: { isBase: boolean; spawnAnchor?: EmittedRef; fallbackParentId: string },
  ): void => {
    const index = new Map(inheritedIndex);
    const callIds = new Set(ancestorCallIds);
    const records: AhsRecord[] = [];
    const seenResults = new Set<string>();
    const forks: { nodeId: number; anchor: EmittedRef | undefined }[] = [];
    let leadingAnchor: EmittedRef | undefined;
    let currentAnchor: EmittedRef | undefined = ctx.spawnAnchor;
    let emittedAny = false;

    let cur = byId.get(startNodeId);
    const visited = new Set<number>();
    while (cur !== undefined && !visited.has(cur.node_id)) {
      visited.add(cur.node_id);
      const node = cur;
      const msg = parseChat(node);
      const messageId = messageIdOf(node, msg);
      if (!emittedAny && index.has(messageId)) {
        // Leading shared-prefix copy: skip; candidate lineage anchor.
        leadingAnchor = index.get(messageId);
        currentAnchor = leadingAnchor;
        nodeSession.set(node.node_id, leadingAnchor!.sessionId);
      } else if (msg !== undefined) {
        const appended = emitMessage(node, msg, records, {
          seenResults,
          ancestorCallIds: callIds,
        });
        if (appended.length > 0) {
          emittedAny = true;
          const last = appended[appended.length - 1]!;
          currentAnchor = { sessionId, recordId: last.recordId, type: last.type };
          index.set(messageId, currentAnchor);
          nodeSession.set(node.node_id, sessionId);
          for (const rec of appended) {
            if (rec.type === "tool_call") callIds.add(rec.toolCallId);
          }
        }
      }

      const kids = children.get(node.node_id) ?? [];
      if (kids.length > 0) {
        let main = kids[0]!;
        let mainBest = subtreeBest(main.node_id, new Set());
        for (const kid of kids.slice(1)) {
          const kb = subtreeBest(kid.node_id, new Set());
          if (mainBest === undefined || (kb !== undefined && byOrder(mainBest, kb) < 0)) {
            main = kid;
            mainBest = kb;
          }
        }
        for (const kid of kids) {
          if (kid.node_id !== main.node_id) forks.push({ nodeId: kid.node_id, anchor: currentAnchor });
        }
        cur = byId.get(main.node_id);
      } else {
        cur = undefined;
      }
    }

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

    if (records.length === 0) return; // fully-shared branch: no session

    const lineage = ctx.isBase
      ? undefined
      : ((): Manifest["lineage"] => {
          const anchor = leadingAnchor ?? ctx.spawnAnchor;
          if (anchor === undefined) {
            // Retry from the very start: the fork carries its own prompt.
            return { type: "sibling_attempt", sessionId: ctx.fallbackParentId };
          }
          return {
            type: anchor.type === "user_message" ? "sibling_attempt" : "forked_from",
            sessionId: anchor.sessionId,
            atRecordId: anchor.recordId,
          };
        })();
    sessions.push({ sessionId, records, ...(lineage !== undefined ? { lineage } : {}) });

    for (const [mid, ref] of index) {
      if (ref.sessionId === sessionId) groupIndex.set(mid, ref);
    }
    for (const callId of callIds) groupCallIds.add(callId);

    for (const fork of forks) {
      processChain(fork.nodeId, `${row.id}#fork-${fork.nodeId}`, index, callIds, {
        isBase: false,
        ...(fork.anchor !== undefined ? { spawnAnchor: fork.anchor } : {}),
        fallbackParentId: sessionId,
      });
    }
  };

  const baseRoot = roots[0]!;
  processChain(baseRoot, row.id, new Map(), new Set(), {
    isBase: true,
    fallbackParentId: row.id,
  });
  if (sessions.length === 0) return null;
  for (const root of roots.slice(1)) {
    processChain(root, `${row.id}#root-${root}`, groupIndex, groupCallIds, {
      isBase: false,
      fallbackParentId: row.id,
    });
  }

  sessions.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));

  // Group HEAD: the session that emitted the main_chain tip; fallback = the
  // session with the latest last-record timestamp (tie: lowest sessionId).
  let head: SessionProjection | undefined;
  if (row.main_chain_id !== null) {
    const owner = nodeSession.get(row.main_chain_id);
    head = sessions.find((s) => s.sessionId === owner);
  }
  if (head === undefined) {
    let bestTs = "";
    for (const s of sessions) {
      const ts = s.records[s.records.length - 1]?.timestamp ?? "";
      if (head === undefined || ts > bestTs) {
        head = s;
        bestTs = ts;
      }
    }
  }

  return { sessions, headSessionId: head!.sessionId };
}

function buildManifest(
  row: SessionRow,
  projection: SessionProjection,
  extra: { includeCost?: boolean },
): Manifest {
  const totalUsage: Usage = {};
  let turnCount = 0;
  for (const rec of projection.records) {
    if (rec.type === "user_message") turnCount += 1;
    if (rec.usage !== undefined) sumUsageInto(totalUsage, rec.usage);
  }
  // Group-level credit cost (billing unit) rides in stats.totalUsage.cost
  // of the BASE session only (see module doc: no per-chain attribution,
  // winner-independent for AC-0002-B-4).
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
    sessionId: projection.sessionId,
    harness: "devin",
    harnessVersion: "unknown", // no CLI version in the DB
    ahsVersion: AHS_VERSION,
    cwd: row.working_directory,
    model: row.model,
    ...(row.title !== null ? { title: row.title, titleOrigin: "custom" as const } : {}),
    ...(projection.lineage !== undefined ? { lineage: projection.lineage } : {}),
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

  private projectRow(db: DatabaseSync, row: SessionRow): GroupProjection | null {
    return projectGroup(row, this.loadNodes(db, row.id));
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    if (filter?.harness !== undefined && filter.harness !== this.harness) return;
    const db = this.open();
    try {
      for (const row of this.loadSessions(db)) {
        const group = this.projectRow(db, row);
        if (group === null) continue;
        if (filter?.cwd !== undefined && row.working_directory !== filter.cwd) continue;
        for (const projection of group.sessions) {
          if (filter?.includeForks !== true && projection.sessionId !== group.headSessionId) {
            continue;
          }
          yield buildManifest(row, projection, {
            includeCost: projection.sessionId === row.id,
          });
        }
      }
    } finally {
      db.close();
    }
  }

  async *readRecords(sessionId: string): AsyncIterable<AhsRecord> {
    // Parse the `<slug>#root-<nodeId>` / `<slug>#fork-<nodeId>` forms.
    const match = /^(.*)#(?:root|fork)-(\d+)$/.exec(sessionId);
    const slug = match?.[1] ?? sessionId;
    const db = this.open();
    try {
      const rows = this.loadSessions(db).filter((r) => r.id === slug);
      const row = rows[0];
      if (row === undefined) throw new Error(`session not found: ${sessionId}`);
      const group = this.projectRow(db, row);
      if (group === null) throw new Error(`session not found: ${sessionId}`);
      const projection = group.sessions.find((s) => s.sessionId === sessionId);
      if (projection === undefined) throw new Error(`session not found: ${sessionId}`);
      yield* projection.records;
    } finally {
      db.close();
    }
  }
}
