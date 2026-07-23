import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Kimi Code → AHS read-only projection.
 *
 * Source layout (see docs/research/schemas/kimi-code-schema.md):
 *   <base>/wd_<workspace-id>/session_<uuid>/
 *     state.json                       session metadata + agents map
 *     agents/<name>/wire.jsonl         per-agent event stream
 *     agents/<name>/plans/<slug>.md    plan-mode documents (optional)
 *
 * MULTI-WIRE = MULTI-SESSION: each agents/<name>/wire.jsonl is projected as
 * its own AHS session. The main agent's sessionId is the bare session uuid;
 * a sub-agent's sessionId is `<uuid>/<agent-name>`. state.json gives only an
 * AGENT-level parent link (parentAgentId — always "main" in observed data),
 * so children get a Manifest invocation back-link (parent session) with NO
 * atRecordId anchor (AC-0002-B-3).
 *
 * DEDUP POLICY: turn.prompt / turn.steer are NOT emitted — their content is
 * duplicated by an immediately following context.append_message with
 * identical text (verified 1814/1814 exact matches on real data in the
 * spike), and append_message carries the better provenance marker
 * (origin.kind). turn.prompt is still counted for Manifest.stats.turnCount.
 *
 * Provenance (spec provenance principle — the source HAS explicit markers):
 * - append_message with origin.kind "user" → user_message.
 * - Any other origin.kind (injection, system_trigger, background_task,
 *   skill_activation) → harness_message. NOTE: a sub-agent's task prompt
 *   arrives with origin.kind "system_trigger" (injected by the Agent tool),
 *   so sub-agent prompts are harness_message, not user_message.
 * - Assistant output exists ONLY as content.part loop events (never in
 *   append_message): consecutive parts are grouped into ONE
 *   assistant_message whose blocks keep stream order (think → thinking
 *   block, text → text block).
 *
 * Mapping decisions (lossy projection, ADR-0001):
 * - step.begin / step.end: FLATTENED (dropped) — turn/step structure is
 *   process detail; Kimi has no explicit turn-end event, so no
 *   turn_boundary records are synthesized (the source does not mark them).
 * - tool.call → tool_call (toolCallId, name, args; display.kind → the
 *   optional derived `kind`; description/display rendering hints dropped).
 *   tool.result → tool_result (result.output verbatim; stringified when not
 *   a string). Duplicate results for one toolCallId: first in file order
 *   wins. Status derived after projection: paired → completed/failed,
 *   dangling → interrupted (no synthetic result).
 * - usage.record: usageScope "turn" → Usage { inputTokens: inputOther,
 *   outputTokens: output, cacheReadTokens: inputCacheRead, cacheWriteTokens:
 *   inputCacheCreation } attached to the IMMEDIATELY PRECEDING emitted
 *   record (buffered for the next record if none exists yet, so usage is
 *   never silently lost). usageScope "session" (emitted at full-compaction
 *   time) is cumulative accounting, not a delta — DROPPED to avoid double
 *   counting.
 * - config.update modelAlias: first occurrence sets the Manifest model;
 *   later changes → model_change records. Manifest.provider comes from the
 *   first llm.request.provider when present, else the modelAlias prefix.
 * - Goals: top-level goal.create { goalId, objective } → goal_update
 *   "pending" (the sentinel convention; most goals are created via the /goal
 *   command, not the CreateGoal tool). goal.update WITH a status →
 *   goal_update verdict: "complete" → "met", "blocked" → "unmet", "paused"
 *   → "pending" (still open); goalId omitted (verdict events carry none —
 *   multiple verdicts correlate via seq, per spec). goal.update WITHOUT
 *   status ({turnsUsed}/{tokensUsed} progress telemetry) and goal.clear
 *   (ambiguous removal, no verdict semantics) are DROPPED.
 *   CreateGoal/UpdateGoal/GetGoal TOOL calls stay ordinary tool_call
 *   records (goal creation via tools is not a control-plane verdict).
 * - Compaction: full_compaction.begin/complete are process markers
 *   (dropped); context.apply_compaction carries the continued-context
 *   summary → ONE compaction record with `summary`.
 * - plans/<slug>.md: plan-mode documents live OUTSIDE the event stream.
 *   They are model-authored content a reviewer must still see, so each plan
 *   file is appended (sorted by filename) as ONE assistant_message with a
 *   single text block at the END of the agent's records, timestamped with
 *   the last stream record's time. Documented as a file-side projection —
 *   the stream position of plan writing is not recoverable (plan_mode.enter
 *   only carries the slug).
 * - forked events ({type:"forked", time}) mark a session fork but carry NO
 *   source session id, so a forked_from lineage cannot be populated:
 *   DROPPED (source-unavailable; flagged for ADR-0002).
 * - Dropped as process mechanics/telemetry: metadata (protocol_version —
 *   there is no CLI version in the source, so Manifest.harnessVersion is
 *   "unknown"), llm.request / llm.tools_snapshot (raw request logs, prompt
 *   hashes), tools.set_active_tools / tools.update_store, permission.*,
 *   plan_mode.*, swarm_mode.*, turn.cancel, context.undo (undone messages
 *   stay in the projection — known fidelity gap).
 * - state.json: title + isCustomTitle → title/titleOrigin (custom/generated).
 *   cwd is NOT recorded anywhere in the source (the wd_<id> path component
 *   is a hash, not a path) — Manifest.cwd is "" (source-unavailable).
 *   createdAt/updatedAt/lastPrompt/custom: dropped (no Manifest home).
 *
 * Causal synthesis: wires are temporal streams without parent links — a
 * linear chain is synthesized per wire (seq = emission index; the linear
 * model has no parentId). Record ids are
 * `<sessionId>:<seq>`; timestamps come from the Unix-ms `time` field
 * converted to ISO 8601. Directory entries are sorted and there are no
 * wall-clock reads, so output is byte-identical across runs.
 */

export const AHS_VERSION = "0.1.0";

/** Loose view of a wire.jsonl line; only the fields we read are typed. */
interface RawLine {
  type?: string;
  time?: number;
  created_at?: number;
  origin?: { kind?: string };
  message?: {
    role?: string;
    content?: RawContent[];
    origin?: { kind?: string };
  };
  event?: RawLoopEvent;
  modelAlias?: string;
  provider?: string;
  usageScope?: string;
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
  // goal events
  goalId?: string;
  objective?: string;
  status?: string;
  reason?: string;
  // context.apply_compaction
  summary?: string;
}

interface RawContent {
  type?: string;
  text?: string;
}

interface RawLoopEvent {
  type?: string;
  part?: { type?: string; think?: string; text?: string };
  toolCallId?: string;
  name?: string;
  args?: unknown;
  display?: { kind?: string };
  result?: { output?: unknown; is_error?: boolean };
  is_error?: boolean;
}

interface StateJson {
  title?: string;
  isCustomTitle?: boolean;
  agents?: Record<
    string,
    { homedir?: string; type?: string; parentAgentId?: string | null }
  >;
}

interface AgentSource {
  name: string;
  sessionId: string;
  wirePath: string;
  plansDir: string;
  invocation?: Manifest["invocation"];
}

interface SessionSource {
  sessionId: string; // main session id = the session uuid
  state: StateJson;
  agents: AgentSource[];
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

function isoFromMs(ms: number | undefined): string {
  if (ms === undefined) return "1970-01-01T00:00:00.000Z";
  return new Date(ms).toISOString();
}

function mapUsage(raw: NonNullable<RawLine["usage"]>): Usage {
  const usage: Usage = {};
  if (raw.inputOther !== undefined) usage.inputTokens = raw.inputOther;
  if (raw.output !== undefined) usage.outputTokens = raw.output;
  if (raw.inputCacheRead !== undefined) usage.cacheReadTokens = raw.inputCacheRead;
  if (raw.inputCacheCreation !== undefined) usage.cacheWriteTokens = raw.inputCacheCreation;
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

/** Omit that distributes over the AhsRecord discriminated union. */
type RecordPayload<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EmittableRecord = RecordPayload<AhsRecord, "recordId" | "seq" | "timestamp">;

/**
 * Project ONE agent's wire.jsonl (+ its plans/ directory) into an AHS
 * record list (a synthesized linear chain). `sessionId` scopes recordIds.
 */
export function projectRecords(
  sessionId: string,
  lines: RawLine[],
  planTexts: string[] = [],
): AhsRecord[] {
  const records: AhsRecord[] = [];
  const seenResultIds = new Set<string>();
  let lastModel: string | undefined;
  let pendingUsage: Usage | undefined;
  let pendingParts: ContentBlock[] = [];

  const emit = (timestamp: string, partial: EmittableRecord): void => {
    const seq = records.length;
    const rec = {
      recordId: `${sessionId}:${seq}`,
      seq,
      timestamp,
      ...(pendingUsage !== undefined ? { usage: pendingUsage } : {}),
      ...partial,
    } as AhsRecord;
    pendingUsage = undefined;
    records.push(rec);
  };

  /** Flush accumulated content.part blocks as ONE assistant_message. */
  const flushParts = (timestamp: string): void => {
    if (pendingParts.length === 0) return;
    const blocks = pendingParts;
    pendingParts = [];
    emit(timestamp, { type: "assistant_message", content: blocks });
  };

  /** Attach usage.record to the immediately preceding emitted record. */
  const attachUsage = (timestamp: string, usage: Usage): void => {
    flushParts(timestamp); // usage closes the step — land it on the message
    const last = records[records.length - 1];
    if (last === undefined) {
      pendingUsage = usage;
      return;
    }
    if (last.usage === undefined) {
      last.usage = usage;
    } else {
      sumUsageInto(last.usage, usage);
    }
  };

  for (const line of lines) {
    const timestamp = isoFromMs(line.time ?? line.created_at);

    if (line.type === "context.append_message") {
      flushParts(timestamp);
      const msg = line.message ?? {};
      const blocks: ContentBlock[] = [];
      for (const c of msg.content ?? []) {
        if (c.type === "text" && typeof c.text === "string") {
          blocks.push({ type: "text", text: c.text });
        }
      }
      if (blocks.length === 0) continue;
      if (msg.role === "assistant") {
        emit(timestamp, { type: "assistant_message", content: blocks });
      } else if (msg.origin?.kind === "user") {
        emit(timestamp, { type: "user_message", content: blocks });
      } else {
        // injection / system_trigger / background_task / skill_activation —
        // source-marked harness provenance.
        emit(timestamp, { type: "harness_message", content: blocks });
      }
    } else if (line.type === "context.append_loop_event") {
      const e = line.event ?? {};
      if (e.type === "content.part") {
        if (e.part?.type === "think" && typeof e.part.think === "string") {
          pendingParts.push({ type: "thinking", text: e.part.think });
        } else if (e.part?.type === "text" && typeof e.part.text === "string") {
          pendingParts.push({ type: "text", text: e.part.text });
        }
      } else if (e.type === "tool.call") {
        flushParts(timestamp);
        emit(timestamp, {
          type: "tool_call",
          toolCallId: e.toolCallId ?? "",
          name: e.name ?? "",
          args: e.args,
          ...(e.display?.kind !== undefined ? { kind: e.display.kind } : {}),
        });
      } else if (e.type === "tool.result") {
        flushParts(timestamp);
        const callId = e.toolCallId ?? "";
        // Duplicate results for one call_id: first in file order wins.
        if (seenResultIds.has(callId)) continue;
        seenResultIds.add(callId);
        const output = e.result?.output;
        const isError = e.is_error === true || e.result?.is_error === true;
        emit(timestamp, {
          type: "tool_result",
          toolCallId: callId,
          content:
            typeof output === "string"
              ? output
              : output === undefined || output === null
                ? ""
                : JSON.stringify(output),
          status: isError ? "error" : "success",
        });
      }
      // step.begin / step.end are flattened (dropped) per ADR-0001.
    } else if (line.type === "usage.record") {
      // usageScope "session" is cumulative accounting — dropped.
      if (line.usageScope === "turn" && line.usage !== undefined) {
        attachUsage(timestamp, mapUsage(line.usage));
      }
    } else if (line.type === "config.update") {
      if (typeof line.modelAlias === "string" && line.modelAlias !== "") {
        if (lastModel === undefined) {
          lastModel = line.modelAlias; // first one establishes the manifest model
        } else if (line.modelAlias !== lastModel) {
          flushParts(timestamp);
          lastModel = line.modelAlias;
          emit(timestamp, { type: "model_change", model: line.modelAlias });
        }
      }
    } else if (line.type === "goal.create") {
      flushParts(timestamp);
      emit(timestamp, {
        type: "goal_update",
        status: "pending",
        ...(line.goalId !== undefined ? { goalId: line.goalId } : {}),
        ...(line.objective !== undefined ? { reason: line.objective } : {}),
      });
    } else if (line.type === "goal.update") {
      // Verdict events carry a status; {turnsUsed}/{tokensUsed} progress
      // telemetry does not and is dropped.
      if (line.status !== undefined) {
        flushParts(timestamp);
        const status =
          line.status === "complete"
            ? ("met" as const)
            : line.status === "blocked"
              ? ("unmet" as const)
              : ("pending" as const); // paused: still open
        emit(timestamp, {
          type: "goal_update",
          status,
          ...(line.reason !== undefined ? { reason: line.reason } : {}),
        });
      }
    } else if (line.type === "context.apply_compaction") {
      flushParts(timestamp);
      emit(timestamp, {
        type: "compaction",
        ...(line.summary !== undefined ? { summary: line.summary } : {}),
      });
    }
    // turn.prompt / turn.steer: duplicates of append_message (see dedup
    // policy) — skipped. goal.clear, forked, full_compaction.begin/complete,
    // llm.request, llm.tools_snapshot, metadata, tools.*, permission.*,
    // plan_mode.*, swarm_mode.*, turn.cancel, context.undo: dropped.
  }

  flushParts(isoFromMs(undefined));

  // plans/*.md: model-authored plan documents stored outside the stream —
  // appended as assistant_message records (file-side projection; stream
  // position not recoverable). Timestamp = last stream record's time.
  const planTimestamp = records[records.length - 1]?.timestamp ?? isoFromMs(undefined);
  for (const text of planTexts) {
    emit(planTimestamp, {
      type: "assistant_message",
      content: [{ type: "text", text }],
    });
  }

  // Derive tool_call status from the pairing outcome (XOR per spec).
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

/** Build the session-level Manifest for ONE agent wire. */
function buildManifest(
  agent: AgentSource,
  state: StateJson,
  lines: RawLine[],
  records: AhsRecord[],
): Manifest {
  let model: string | undefined;
  let provider: string | undefined;
  let turnCount = 0;
  for (const line of lines) {
    if (line.type === "config.update" && model === undefined) {
      if (typeof line.modelAlias === "string" && line.modelAlias !== "") {
        model = line.modelAlias;
      }
    }
    if (line.type === "llm.request" && provider === undefined) {
      if (typeof line.provider === "string" && line.provider !== "") {
        provider = line.provider;
      }
    }
    if (line.type === "turn.prompt") turnCount += 1;
  }
  if (provider === undefined && model !== undefined && model.includes("/")) {
    provider = model.split("/")[0];
  }

  const totalUsage: Usage = {};
  for (const rec of records) {
    if (rec.usage !== undefined) sumUsageInto(totalUsage, rec.usage);
  }
  const hasUsage = Object.keys(totalUsage).length > 0;

  return {
    sessionId: agent.sessionId,
    harness: "kimi-code",
    harnessVersion: "unknown", // no CLI version in the source
    ahsVersion: AHS_VERSION,
    cwd: "", // source-unavailable: wd_<id> is a hash, not a path
    model: model ?? "unknown",
    ...(provider !== undefined ? { provider } : {}),
    ...(state.title !== undefined
      ? { title: state.title, titleOrigin: state.isCustomTitle === true ? ("custom" as const) : ("generated" as const) }
      : {}),
    ...(agent.invocation !== undefined ? { invocation: agent.invocation } : {}),
    stats: {
      turnCount,
      ...(hasUsage ? { totalUsage } : {}),
    },
  };
}

export class KimiCodeAdapter implements HarnessAdapter {
  readonly harness = "kimi-code";
  readonly capabilities = { history: "full", control: false } as const;

  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(homedir(), ".kimi-code", "sessions");
  }

  /** Discover session directories (workspace/session) with their agent wires. */
  private async discover(): Promise<SessionSource[]> {
    let wdDirs: string[];
    try {
      wdDirs = (await readdir(this.basePath, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }

    const sessions: SessionSource[] = [];
    for (const wd of wdDirs) {
      const wdPath = path.join(this.basePath, wd);
      const entries = (await readdir(wdPath, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name.startsWith("session_"))
        .map((e) => e.name)
        .sort();
      for (const entry of entries) {
        const dir = path.join(wdPath, entry);
        let state: StateJson;
        try {
          state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")) as StateJson;
        } catch {
          continue; // no readable state.json — not a projectable session
        }
        const sessionId = entry.slice("session_".length);

        // Agent roster: state.json agents map, falling back to the directory.
        let names = Object.keys(state.agents ?? {}).sort();
        if (names.length === 0) {
          try {
            names = (await readdir(path.join(dir, "agents"), { withFileTypes: true }))
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
              .sort();
          } catch {
            names = [];
          }
        }

        const agents: AgentSource[] = [];
        for (const name of names) {
          const agentDir = path.join(dir, "agents", name);
          const wirePath = path.join(agentDir, "wire.jsonl");
          const isMain = name === "main" || state.agents?.[name]?.type === "main";
          const agentSessionId = isMain ? sessionId : `${sessionId}/${name}`;
          let invocation: AgentSource["invocation"];
          if (!isMain) {
            // Agent-level parent link only (AC-0002-B-3: no atRecordId anchor).
            // TODO(Plan 02): forward link via the parent's tool_result.sessionId.
            const parentName = state.agents?.[name]?.parentAgentId;
            const parentSessionId =
              parentName === undefined || parentName === null || parentName === "main"
                ? sessionId
                : `${sessionId}/${parentName}`;
            invocation = { sessionId: parentSessionId };
          }
          agents.push({
            name,
            sessionId: agentSessionId,
            wirePath,
            plansDir: path.join(agentDir, "plans"),
            ...(invocation !== undefined ? { invocation } : {}),
          });
        }
        // Main first, then sub-agents sorted by name.
        agents.sort((a, b) =>
          a.name === b.name
            ? 0
            : a.name === "main"
              ? -1
              : b.name === "main"
                ? 1
                : a.name.localeCompare(b.name),
        );
        sessions.push({ sessionId, state, agents });
      }
    }
    return sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  private async loadWire(agent: AgentSource): Promise<RawLine[]> {
    try {
      return parseJsonl(await readFile(agent.wirePath, "utf8"));
    } catch {
      return [];
    }
  }

  private async loadPlans(agent: AgentSource): Promise<string[]> {
    let files: string[];
    try {
      files = (await readdir(agent.plansDir))
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      return [];
    }
    const texts: string[] = [];
    for (const f of files) {
      texts.push(await readFile(path.join(agent.plansDir, f), "utf8"));
    }
    return texts;
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    if (filter?.harness !== undefined && filter.harness !== this.harness) return;
    for (const session of await this.discover()) {
      for (const agent of session.agents) {
        const lines = await this.loadWire(agent);
        const records = projectRecords(agent.sessionId, lines, await this.loadPlans(agent));
        // Wires with zero projectable content are not AHS sessions — skip.
        if (records.length === 0) continue;
        const manifest = buildManifest(agent, session.state, lines, records);
        if (filter?.cwd !== undefined && manifest.cwd !== filter.cwd) continue;
        yield manifest;
      }
    }
  }

  async *readRecords(sessionId: string): AsyncIterable<AhsRecord> {
    for (const session of await this.discover()) {
      for (const agent of session.agents) {
        if (agent.sessionId === sessionId) {
          yield* projectRecords(
            agent.sessionId,
            await this.loadWire(agent),
            await this.loadPlans(agent),
          );
          return;
        }
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }
}
