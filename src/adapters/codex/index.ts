import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Codex → AHS read-only projection.
 *
 * Source layout (see docs/research/schemas/codex-schema.md):
 *   <base>/YYYY/MM/DD/rollout-<iso-ts>-<session-id>.jsonl   one file per session
 * Envelope: { timestamp, type, payload }.
 *
 * DEDUP POLICY (the core mapping decision; the source writes the same datum
 * 2-3 times — as response_item, as event_msg, and sometimes as a bare
 * top-level type):
 * - `response_item` is CANONICAL for conversational content: message,
 *   function_call(_output), custom_tool_call(_output).
 * - `event_msg` is used ONLY for what response_item lacks: token_count
 *   (usage), task_started/task_complete/turn_aborted (turn lifecycle),
 *   context_compacted (compaction), thread_goal_updated (goal verdicts),
 *   sub_agent_activity (spawn anchors — see below).
 *   event_msg `user_message` / `agent_message` are DUPLICATES of
 *   response_item messages and are skipped.
 * - Bare top-level `message` / `user_message` / `agent_message` /
 *   `token_count` / `reasoning` are skipped as duplicates outright.
 *   Bare top-level `function_call` / `function_call_output` /
 *   `custom_tool_call` / `custom_tool_call_output` (older/redundant format)
 *   are emitted only when their call_id was NOT already seen from a
 *   response_item — dedup by call_id, first occurrence in file order wins.
 *
 * Other lossy decisions (per spec/0001 "丢弃" list):
 * - `session_meta.base_instructions.text` (the huge system prompt): DROPPED.
 * - `turn_context`: only `model` is kept — a `model_change` record is emitted
 *   when it differs from the previous turn's model. approval_policy /
 *   sandbox_policy / permission_profile are process mechanics: DROPPED.
 * - `reasoning` items carry undecryptable `encrypted_content` with an empty
 *   summary: DROPPED entirely (source-unavailable, per spec).
 * - `web_search_call` / `tool_search_call`(+_output): server-side tool use,
 *   dropped (same category as Claude's server_tool_use).
 * - token_count `rate_limits` is harness telemetry: DROPPED.
 *   `last_token_usage` is the most recent API request's usage;
 *   `total_token_usage` is the authoritative cumulative cost. Codex re-emits
 *   token_count events with an UNCHANGED total (e.g. at turn boundaries) —
 *   these are duplicates and are skipped (verified on real data: with this
 *   dedup, sum(last_token_usage) == final total_token_usage per session).
 * - event_msg process/telemetry subtypes (exec_command_end, patch_apply_end,
 *   update, thread_settings_applied, thread_rolled_back,
 *   entered/exited_review_mode, item_completed, error): DROPPED.
 *
 * Session relations (ADR-0005 two dimensions):
 * - Sub-agents: the child's rollout file opens with its OWN session_meta
 *   whose `source` is { subagent: { thread_spawn: { parent_thread_id } } }.
 *   This maps to Manifest.invocation = { sessionId: parent_thread_id }.
 *   The atRecordId anchor is recovered by cross-file correlation: the
 *   parent's event_msg `sub_agent_activity` carries event_id = the parent's
 *   spawn_agent function_call call_id and agent_thread_id = the child thread
 *   id, so the anchor is the recordId of that tool_call in the parent; the
 *   forward link is written as `sessionIds` on the parent's paired
 *   tool_result (from the same sub_agent_activity data, inside the parent's
 *   own projection). If the parent file or the correlation event is missing,
 *   the anchor is omitted (source-unavailable; the back-link still stands).
 * - Resumed/forked threads: the file's own session_meta is followed by
 *   ancestor lineage headers, most recent first; ancestor content is NOT
 *   replayed (verified on real data). The most recent ancestor (the second
 *   session_meta) maps to lineage, anchored at the ancestor's LAST record
 *   (the child stores only the post-fork suffix); the type is judged by the
 *   anchor record: forked_from.
 *   forked_from (AC-0002-N-7). If the ancestor file is absent/empty in this
 *   store, the lineage is kept with `atRecordId: null` (anchor
 *   source-unavailable, tri-state per the ADR-0005 amendment).
 *   A sub-agent file has lineage headers too, but invocation wins.
 *
 * Specific mappings:
 * - response_item message role: user → user_message; assistant →
 *   assistant_message; developer/system → harness_message (harness-injected
 *   instructions — first-class provenance per spec). input_text/output_text
 *   → text blocks; input_image is skipped (no offline-decodable blob data).
 * - function_call: `arguments` is a JSON-encoded STRING — parsed into
 *   tool_call.args (kept as the raw string when parsing fails). toolCallId =
 *   call_id. custom_tool_call: `input` is kept verbatim (not JSON).
 * - function_call_output.output is kept verbatim as tool_result content.
 *   status: payload.status when present ("completed" → success, anything
 *   else → error); otherwise "success".
 * - Compaction: top-level `compacted` (the boundary marker; its
 *   replacement_history is the full rewritten context — DROPPED as
 *   redundant bulk) and event_msg `context_compacted` (empty notification)
 *   always arrive as an adjacent pair. ONE `compaction` record is emitted on
 *   the first of the pair; the second is suppressed.
 * - thread_goal_updated → goal_update. The source goal object is
 *   { threadId, objective, status: "active" | "paused" | "complete" }.
 *   Mapping: "active"/"paused" (goal open) → "pending"; "complete" → "met".
 *   No "unmet"-like verdict was observed in real data. The objective text is
 *   kept in `reason`; goalId is omitted (the goal is identified only by its
 *   threadId, which duplicates the session id).
 * - token_count → Usage { inputTokens, cacheReadTokens: cached_input_tokens,
 *   outputTokens, reasoningTokens: reasoning_output_tokens } from
 *   `last_token_usage`, attached to the IMMEDIATELY PRECEDING emitted record
 *   (usage belongs to the model request whose output we just projected; if
 *   several token_counts land on one record the fields are summed). If
 *   nothing has been emitted yet, the usage is held and attached to the
 *   next emitted record so it is never silently lost (AC-0002-N-4).
 * - task_started/task_complete → turn_boundary start/end with turnId.
 *   turn_aborted is mapped to turn_boundary end — the turn ended, by
 *   interruption.
 * - tool_call status (derived after projection, per spec): a paired
 *   tool_result gives "completed"/"failed"; no result at session end gives
 *   "interrupted" (no synthetic result). Duplicate results for one call_id:
 *   the first in file order is kept.
 *
 * Causal synthesis: the source is a temporal stream with no parent links —
 * a linear chain is synthesized (emission order; the linear model has
 * no parentId). Record ids are synthesized as
 * `<sessionId>:<index>` (source records have no stable uuids); directory
 * entries are sorted and there are no wall-clock reads, so output is
 * byte-identical across runs.
 *
 * listSessions folding (interface/0001): `includeForks` defaults to false —
 * only each lineage group's HEAD session is listed. Codex has no winner
 * marker, so HEAD = the most recently updated session in the group (its last
 * record's timestamp; ties broken by the smaller sessionId, deterministically).
 * Groups are formed by lineage edges only (invocation is the other dimension
 * and does not fold).
 *
 * Timestamps: every source line carries an ISO 8601 timestamp per the source
 * schema. Defensively, a line missing it inherits the previous line's
 * timestamp, then the session_meta timestamp, then the filename's creation
 * time — source-derived values only, never fabricated.
 */

export const AHS_VERSION = "0.1.0";

/** Loose view of a source JSONL line; only the fields we read are typed. */
export interface RawLine {
  timestamp?: string;
  type?: string;
  payload?: RawPayload;
}

export interface RawPayload {
  type?: string;
  // session_meta
  id?: string;
  session_id?: string;
  timestamp?: string;
  cwd?: string;
  cli_version?: string;
  model_provider?: string;
  /** "cli" | "vscode" | ... as a string, or a subagent spawn declaration. */
  source?:
    | string
    | {
        subagent?: {
          thread_spawn?: {
            parent_thread_id?: string;
            depth?: number;
            agent_path?: string;
          };
        };
      };
  git?: { commit_hash?: string; branch?: string; repository_url?: string };
  // turn_context
  turn_id?: string;
  model?: string;
  workspace_roots?: string[];
  // response_item message
  role?: string;
  content?: RawContent[];
  // function_call / custom_tool_call
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  status?: string;
  output?: unknown;
  // token_count
  info?: {
    total_token_usage?: RawTokenUsage;
    last_token_usage?: RawTokenUsage;
  };
  // sub_agent_activity
  event_id?: string;
  agent_thread_id?: string;
  kind?: string;
  // thread_goal_updated
  goal?: { threadId?: string; objective?: string; status?: string };
}

interface RawTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface RawContent {
  type?: string;
  text?: string;
}

/** Omit that distributes over the AhsRecord discriminated union. */
type RecordPayload<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EmittableRecord = RecordPayload<AhsRecord, "recordId" | "timestamp">;

interface SessionSource {
  /** sessionId from session_meta, falling back to the filename id. */
  sessionId: string;
  filePath: string;
  lines: RawLine[];
  /** Filename-derived creation time, last-resort timestamp fallback. */
  fallbackTimestamp?: string;
  /** thread_spawn parent thread, when this rollout is a sub-agent. */
  parentThreadId?: string;
  /** Most recent ancestor lineage header (direct fork parent), if any. */
  ancestorId?: string;
  /** sub_agent_activity correlations observed in THIS file (it is the parent). */
  spawnEvents: SpawnEvent[];
}

/** A sub_agent_activity correlation: spawn call_id → spawned child thread. */
interface SpawnEvent {
  callId: string;
  childThreadId: string;
}

function parseJsonl(content: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      lines.push(JSON.parse(trimmed) as RawLine);
    } catch {
      // Tolerate a truncated tail line (crash mid-write): skip it.
    }
  }
  return lines;
}

/** rollout-<iso-ts>-<id>.jsonl → { id, timestamp } (best effort; session_meta wins). */
function parseFilename(fileName: string): { id: string; timestamp?: string } {
  const stem = fileName.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)$/.exec(stem);
  if (match === null) return { id: stem };
  const [, date, hh, mm, ss, id] = match;
  return { id: id!, timestamp: `${date}T${hh}:${mm}:${ss}.000Z` };
}

function mapTokenUsage(raw: RawTokenUsage): Usage {
  const usage: Usage = {};
  if (raw.input_tokens !== undefined) usage.inputTokens = raw.input_tokens;
  if (raw.cached_input_tokens !== undefined) usage.cacheReadTokens = raw.cached_input_tokens;
  if (raw.output_tokens !== undefined) usage.outputTokens = raw.output_tokens;
  if (raw.reasoning_output_tokens !== undefined) {
    usage.reasoningTokens = raw.reasoning_output_tokens;
  }
  return usage;
}

function sumUsageInto(target: Usage, add: Usage): void {
  target.inputTokens = (target.inputTokens ?? 0) + (add.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (add.outputTokens ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0);
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (add.reasoningTokens ?? 0);
  for (const key of Object.keys(target) as (keyof Usage)[]) {
    if (target[key] === 0) delete target[key];
  }
}

/**
 * Extract sub_agent_activity correlations (spawn call_id → child thread id)
 * from a rollout file's lines. First occurrence of a (callId, childThreadId)
 * pair in file order wins, matching the dedup policy.
 */
function collectSpawnEvents(lines: RawLine[]): SpawnEvent[] {
  const events: SpawnEvent[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.type !== "event_msg") continue;
    const p = line.payload ?? {};
    if (p.type !== "sub_agent_activity") continue;
    const callId = p.event_id;
    const childThreadId = p.agent_thread_id;
    if (typeof callId !== "string" || typeof childThreadId !== "string") continue;
    const key = `${callId} ${childThreadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ callId, childThreadId });
  }
  return events;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}

/**
 * Project the lines of ONE session file into an AHS record list (a
 * synthesized linear chain). `sessionId` scopes the deterministic recordIds;
 * `fallbackTimestamp` is the last-resort timestamp for lines lacking one.
 */
export function projectRecords(
  sessionId: string,
  lines: RawLine[],
  fallbackTimestamp?: string,
): AhsRecord[] {
  const records: AhsRecord[] = [];
  const seenCallIds = new Set<string>();
  const seenResultIds = new Set<string>();
  /** spawn_agent call_id → spawned child thread (forward invocation link). */
  const spawnLinks = new Map<string, string>();
  let lastModel: string | undefined;
  let lastTimestamp = fallbackTimestamp ?? "";
  let compactionPending = false;
  let pendingUsage: Usage | undefined;
  let prevTokenTotalKey: string | null = null;

  const emit = (timestamp: string, partial: EmittableRecord): void => {
    const rec = {
      recordId: `${sessionId}:${records.length}`,
      timestamp,
      ...(pendingUsage !== undefined ? { usage: pendingUsage } : {}),
      ...partial,
    } as AhsRecord;
    pendingUsage = undefined;
    records.push(rec);
  };

  /** Attach token_count usage to the immediately preceding emitted record. */
  const attachUsage = (usage: Usage): void => {
    const last = records[records.length - 1];
    if (last === undefined) {
      // Nothing emitted yet — hold it for the next record so it is not lost.
      pendingUsage = usage;
      return;
    }
    if (last.usage === undefined) {
      last.usage = usage;
    } else {
      // Several per-request deltas can land on one record: sum them.
      sumUsageInto(last.usage, usage);
    }
  };

  const emitToolCall = (timestamp: string, p: RawPayload, custom: boolean): void => {
    const callId = p.call_id ?? "";
    if (seenCallIds.has(callId)) return; // redundant top-level duplicate
    seenCallIds.add(callId);
    let args: unknown = p.input;
    if (!custom) {
      // function_call arguments are a JSON-encoded string — parse them.
      try {
        args = JSON.parse(p.arguments ?? "null");
      } catch {
        args = p.arguments;
      }
    }
    emit(timestamp, {
      type: "tool_call",
      toolCallId: callId,
      name: p.name ?? "",
      args,
    });
  };

  const emitToolResult = (timestamp: string, p: RawPayload): void => {
    const callId = p.call_id ?? "";
    // Duplicate results for one call_id (resubmit/branch): first in file
    // order wins.
    if (seenResultIds.has(callId)) return;
    seenResultIds.add(callId);
    emit(timestamp, {
      type: "tool_result",
      toolCallId: callId,
      content: stringifyOutput(p.output),
      status: p.status === undefined ? "success" : p.status === "completed" ? "success" : "error",
    });
  };

  const emitMessage = (timestamp: string, p: RawPayload): void => {
    const blocks: ContentBlock[] = [];
    for (const c of p.content ?? []) {
      // input_text (user/developer) and output_text (assistant) → text.
      // input_image is skipped: no offline-decodable blob data in source.
      if ((c.type === "input_text" || c.type === "output_text") && typeof c.text === "string") {
        blocks.push({ type: "text", text: c.text });
      }
    }
    if (blocks.length === 0) return;
    const type =
      p.role === "assistant"
        ? ("assistant_message" as const)
        : p.role === "user"
          ? ("user_message" as const)
          : ("harness_message" as const); // developer/system: harness-injected
    emit(timestamp, { type, content: blocks });
  };

  for (const line of lines) {
    // Timestamp fallback chain: line → previous line → session/file start.
    if (line.timestamp !== undefined) lastTimestamp = line.timestamp;
    const timestamp = lastTimestamp;
    const p = line.payload ?? {};

    if (line.type === "response_item") {
      if (p.type === "message") emitMessage(timestamp, p);
      else if (p.type === "function_call") emitToolCall(timestamp, p, false);
      else if (p.type === "function_call_output") emitToolResult(timestamp, p);
      else if (p.type === "custom_tool_call") emitToolCall(timestamp, p, true);
      else if (p.type === "custom_tool_call_output") emitToolResult(timestamp, p);
      // reasoning (encrypted, undecryptable) and web_search_call /
      // tool_search_call(+_output) (server-side tools) are dropped per spec.
    } else if (line.type === "event_msg") {
      if (p.type === "task_started") {
        emit(timestamp, {
          type: "turn_boundary",
          phase: "start",
          ...(p.turn_id !== undefined ? { turnId: p.turn_id } : {}),
        });
      } else if (p.type === "task_complete" || p.type === "turn_aborted") {
        // turn_aborted: the turn ended by interruption — still a boundary.
        emit(timestamp, {
          type: "turn_boundary",
          phase: "end",
          ...(p.turn_id !== undefined ? { turnId: p.turn_id } : {}),
        });
      } else if (p.type === "token_count") {
        // Skip re-emitted duplicates: an event whose total_token_usage is
        // unchanged from the previous token_count describes no new request.
        const totalKey = JSON.stringify(p.info?.total_token_usage ?? null);
        if (totalKey === prevTokenTotalKey) continue;
        prevTokenTotalKey = totalKey;
        const last = p.info?.last_token_usage;
        if (last !== undefined) attachUsage(mapTokenUsage(last));
      } else if (p.type === "context_compacted") {
        // Empty notification paired with the top-level `compacted` marker —
        // emit one compaction record per pair, first arrival wins.
        if (!compactionPending) emit(timestamp, { type: "compaction" });
        compactionPending = false;
      } else if (p.type === "thread_goal_updated") {
        // Goal verdict mapping: active/paused (open) → pending; complete →
        // met. No unmet-like verdict observed in the source. The objective
        // text is kept as `reason`; goalId omitted (goal is keyed by
        // threadId, which duplicates the session id).
        const status = p.goal?.status === "complete" ? ("met" as const) : ("pending" as const);
        emit(timestamp, {
          type: "goal_update",
          status,
          ...(p.goal?.objective !== undefined ? { reason: p.goal.objective } : {}),
        });
      }
      // event_msg user_message / agent_message are duplicates of
      // response_item messages — skipped. sub_agent_activity feeds the
      // invocation forward link (tool_result.sessionIds), not records of its
      // own. All other subtypes (exec_command_end, patch_apply_end, ...) are
      // process/telemetry — dropped per spec.
      if (p.type === "sub_agent_activity") {
        // The first event for a call_id establishes the spawn correlation
        // (kind "started" arrives first in practice).
        if (typeof p.event_id === "string" && typeof p.agent_thread_id === "string") {
          if (!spawnLinks.has(p.event_id)) spawnLinks.set(p.event_id, p.agent_thread_id);
        }
      }
    } else if (line.type === "turn_context") {
      // Only the model is kept; approval/sandbox/permission are dropped.
      if (typeof p.model === "string" && p.model !== "") {
        if (lastModel === undefined) {
          lastModel = p.model; // first turn establishes the manifest model
        } else if (p.model !== lastModel) {
          lastModel = p.model;
          emit(timestamp, { type: "model_change", model: p.model });
        }
      }
    } else if (line.type === "compacted") {
      // Compaction boundary marker; replacement_history (the full rewritten
      // context) is redundant bulk — dropped.
      emit(timestamp, { type: "compaction" });
      compactionPending = true;
    } else if (line.type === "function_call" || line.type === "custom_tool_call") {
      emitToolCall(timestamp, p, line.type === "custom_tool_call");
    } else if (
      line.type === "function_call_output" ||
      line.type === "custom_tool_call_output"
    ) {
      emitToolResult(timestamp, p);
    }
    // session_meta → Manifest (buildManifest). Bare top-level message /
    // user_message / agent_message / token_count / reasoning and everything
    // else are duplicates or process noise — skipped.
  }

  // Derive tool_call status from the pairing outcome (XOR per spec): paired
  // tool_result → "completed"/"failed"; no result at session end →
  // "interrupted" (no synthetic result record is emitted).
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

  // Forward invocation link (ADR-0005): the tool_result paired with a
  // spawn_agent call carries the spawned child session's id.
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (rec.type !== "tool_result") continue;
    const child = spawnLinks.get(rec.toolCallId);
    if (child !== undefined) {
      records[i] = { ...rec, sessionIds: [child] };
    }
  }

  return records;
}

/**
 * Cross-session context for manifest building: every session in the store,
 * by sessionId — needed to resolve the cross-session anchors (invocation
 * atRecordId into the parent's tool_call via its sub_agent_activity
 * correlation; lineage atRecordId at the fork parent's last record).
 */
interface ProjectionContext {
  sourcesById: Map<string, SessionSource>;
  recordsById: Map<string, AhsRecord[]>;
}

/** Build the session-level Manifest from raw lines + projected records. */
function buildManifest(
  source: SessionSource,
  records: AhsRecord[],
  ctx: ProjectionContext,
  branches?: Record<string, { parentRecordId: string | null }>,
): Manifest {
  const { sessionId, lines } = source;
  const metas: RawPayload[] = [];
  let model: string | undefined;
  let workspaceRoots: string[] | undefined;
  let turnCount = 0;
  for (const line of lines) {
    const p = line.payload ?? {};
    if (line.type === "session_meta") metas.push(p);
    if (line.type === "turn_context") {
      if (model === undefined && typeof p.model === "string" && p.model !== "") {
        model = p.model;
      }
      if (workspaceRoots === undefined && Array.isArray(p.workspace_roots)) {
        workspaceRoots = p.workspace_roots;
      }
    }
    if (line.type === "event_msg" && p.type === "task_started") turnCount += 1;
  }
  // The FIRST session_meta is this rollout's own thread; later ones are
  // ancestor lineage headers (resumed/forked threads), most recent first.
  const meta = metas[0];

  const totalUsage: Usage = {};
  for (const rec of records) {
    if (rec.usage !== undefined) sumUsageInto(totalUsage, rec.usage);
  }

  const git = meta?.git ?? {};
  const hasGit =
    git.branch !== undefined || git.commit_hash !== undefined || git.repository_url !== undefined;

  // Relations (ADR-0006):
  // - thread_spawn → invocation back-link.
  let invocation: Manifest["invocation"];
  if (source.parentThreadId !== undefined) {
    invocation = { sessionId: source.parentThreadId };
    const parent = ctx.sourcesById.get(source.parentThreadId);
    const spawn = parent?.spawnEvents.find((e) => e.childThreadId === sessionId);
    const parentRecords = ctx.recordsById.get(source.parentThreadId);
    const anchor =
      spawn === undefined
        ? undefined
        : parentRecords?.find((r) => r.type === "tool_call" && r.toolCallId === spawn.callId);
    if (anchor !== undefined) invocation.atRecordId = anchor.recordId;
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

  return {
    sessionId,
    harness: "codex",
    harnessVersion: meta?.cli_version ?? "unknown",
    ahsVersion: AHS_VERSION,
    cwd: meta?.cwd ?? "",
    ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
    ...(hasGit
      ? {
          git: {
            ...(git.branch !== undefined ? { branch: git.branch } : {}),
            ...(git.commit_hash !== undefined ? { commit: git.commit_hash } : {}),
            ...(git.repository_url !== undefined ? { repoUrl: git.repository_url } : {}),
          },
        }
      : {}),
    model: model ?? "unknown",
    ...(meta?.model_provider !== undefined ? { provider: meta.model_provider } : {}),
    branches: branchRegistry,
    HEAD: { branch: "main", recordId: lastRecordId },
    ...(invocation !== undefined ? { invocation } : {}),
    stats: {
      turnCount,
      ...(hasUsage ? { totalUsage } : {}),
    },
  };
}

/**
 * Group sessions by their lineage edges (union-find) and return each group's
 * HEAD sessionId. Codex has no winner marker, so HEAD = the most recently
 * updated session in the group (its last record's timestamp; ties broken by
 * the smaller sessionId, deterministically). Sessions whose lineage points
 * outside the store form their own group (they are the visible head).
 */
export class CodexAdapter implements HarnessAdapter {
  readonly harness = "codex";
  readonly capabilities = { history: "full", control: false } as const;

  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(homedir(), ".codex", "sessions");
  }

  /** Recursively collect rollout-*.jsonl paths, sorted for determinism. */
  private async walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.walk(full)));
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
    return files;
  }

  private async load(filePath: string): Promise<SessionSource> {
    const lines = parseJsonl(await readFile(filePath, "utf8"));
    // The FIRST session_meta is this rollout's own thread; later ones are
    // ancestor lineage headers — first wins.
    const metas = lines.filter((l) => l.type === "session_meta").map((l) => l.payload ?? {});
    const meta = metas[0];
    const metaSource = meta?.source;
    const parentThreadId =
      typeof metaSource === "object"
        ? metaSource.subagent?.thread_spawn?.parent_thread_id
        : undefined;
    const ancestorId = metas[1]?.id ?? metas[1]?.session_id;
    const parsed = parseFilename(path.basename(filePath));
    const source: SessionSource = {
      sessionId: meta?.id ?? meta?.session_id ?? parsed.id,
      filePath,
      lines,
      spawnEvents: collectSpawnEvents(lines),
      ...(parsed.timestamp !== undefined ? { fallbackTimestamp: parsed.timestamp } : {}),
      ...(parentThreadId !== undefined ? { parentThreadId } : {}),
      ...(ancestorId !== undefined ? { ancestorId } : {}),
    };
    return source;
  }

  private async loadAll(): Promise<SessionSource[]> {
    const sessions: SessionSource[] = [];
    for (const filePath of await this.walk(this.basePath)) {
      sessions.push(await this.load(filePath));
    }
    return sessions;
  }

  /**
   * Project all sessions into manifests. Shared by listSessions and
   * readManifest because codex manifests need cross-session context
   * (invocation anchors, lineage/branch folding).
   */
  private async projectAllManifests(): Promise<Manifest[]> {
    const sessions = await this.loadAll();
    const recordsById = new Map<string, AhsRecord[]>();
    const sourcesById = new Map<string, SessionSource>();
    for (const session of sessions) {
      const records = projectRecords(
        session.sessionId,
        session.lines,
        session.fallbackTimestamp,
      );
      if (records.length === 0) continue;
      recordsById.set(session.sessionId, records);
      sourcesById.set(session.sessionId, session);
    }
    const ctx: ProjectionContext = { sourcesById, recordsById };

    const descendants = new Map<string, SessionSource[]>();
    for (const session of sessions) {
      if (!recordsById.has(session.sessionId)) continue;
      if (session.parentThreadId !== undefined) continue;
      if (session.ancestorId !== undefined && recordsById.has(session.ancestorId)) {
        const list = descendants.get(session.ancestorId);
        if (list !== undefined) list.push(session);
        else descendants.set(session.ancestorId, [session]);
      }
    }
    const isBranch = new Set<string>();
    for (const list of descendants.values()) {
      for (const s of list) isBranch.add(s.sessionId);
    }

    const manifests: Manifest[] = [];
    for (const session of sessions) {
      const records = recordsById.get(session.sessionId);
      if (records === undefined) continue;

      if (session.parentThreadId !== undefined) {
        manifests.push(buildManifest(session, records, ctx));
        continue;
      }
      if (isBranch.has(session.sessionId)) continue;

      const branchEntries: Record<string, { parentRecordId: string | null }> = {};
      const descList = descendants.get(session.sessionId) ?? [];
      let branchIndex = 0;
      for (const desc of descList) {
        const descRecords = recordsById.get(desc.sessionId);
        if (descRecords === undefined) continue;
        branchIndex += 1;
        const branchName = `b${String(branchIndex).padStart(3, "0")}`;
        const parentRecords = recordsById.get(session.sessionId);
        const lastRecordId = parentRecords !== undefined && parentRecords.length > 0
          ? parentRecords[parentRecords.length - 1]!.recordId
          : null;
        branchEntries[branchName] = { parentRecordId: lastRecordId };
      }
      manifests.push(buildManifest(session, records, ctx, branchEntries));
    }
    return manifests;
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    if (filter?.harness !== undefined && filter.harness !== this.harness) return;
    for (const manifest of await this.projectAllManifests()) {
      if (filter?.cwd !== undefined && manifest.cwd !== filter.cwd) continue;
      yield manifest;
    }
  }

  async readManifest(sessionId: string): Promise<Manifest> {
    const manifests = await this.projectAllManifests();
    const manifest = manifests.find((m) => m.sessionId === sessionId);
    if (manifest === undefined) throw new Error(`session not found: ${sessionId}`);
    return manifest;
  }

  async *readRecords(sessionId: string, branchName?: string): AsyncIterable<AhsRecord> {
    const sessions = await this.loadAll();
    const recordsById = new Map<string, AhsRecord[]>();
    const sourcesById = new Map<string, SessionSource>();
    for (const session of sessions) {
      const records = projectRecords(
        session.sessionId,
        session.lines,
        session.fallbackTimestamp,
      );
      if (records.length === 0) continue;
      recordsById.set(session.sessionId, records);
      sourcesById.set(session.sessionId, session);
    }

    // Build ancestor → descendants map for branch lookup.
    // Subagent sessions are separate, not branches.
    const descendants = new Map<string, SessionSource[]>();
    for (const session of sessions) {
      if (!recordsById.has(session.sessionId)) continue;
      if (session.parentThreadId !== undefined) continue;
      if (session.ancestorId !== undefined && recordsById.has(session.ancestorId)) {
        const list = descendants.get(session.ancestorId);
        if (list !== undefined) list.push(session);
        else descendants.set(session.ancestorId, [session]);
      }
    }

    // Check if the requested sessionId is a root session.
    const source = sourcesById.get(sessionId);
    if (source !== undefined) {
      const targetBranch = branchName ?? "main";
      if (targetBranch === "main") {
        yield* recordsById.get(sessionId)!;
        return;
      }
      // Branch lookup: find the descendant file with this branch name.
      const descList = descendants.get(sessionId) ?? [];
      let branchIndex = 0;
      for (const desc of descList) {
        branchIndex += 1;
        const bName = `b${String(branchIndex).padStart(3, "0")}`;
        if (bName === targetBranch) {
          yield* recordsById.get(desc.sessionId)!;
          return;
        }
      }
      throw new Error(`branch not found: ${targetBranch}`);
    }

    throw new Error(`session not found: ${sessionId}`);
  }
}
