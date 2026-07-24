import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Grok (xAI CLI) → AHS read-only projection.
 *
 * Source layout (see docs/research/schemas/grok-schema.md):
 *   <base>/%2F<url-encoded-cwd>/<ulid>/
 *     chat_history.jsonl   canonical messages (one JSON object per line)
 *     summary.json         session metadata (cwd, title, model, timestamps)
 *     events.jsonl         turn/loop lifecycle (turn_started carries ts +
 *                          conversation_message_count)
 *     signals.json         aggregate session metrics (may be absent)
 *   <base>/../version.json CLI version
 *
 * CANONICAL REPRESENTATION = chat_history.jsonl. updates.jsonl (streaming
 * chunk log) and the loop/phase/tool lifecycle events of events.jsonl are
 * dropped per ADR-0001 (process detail); events.jsonl is consulted ONLY for
 * turn boundaries + timestamps (see below).
 *
 * Record mapping:
 * - system (the base system prompt): DROPPED — harness boilerplate, same
 *   category as Codex base_instructions. system_prompt.txt duplicates it.
 * - user: OpenAI content blocks [{type:"text",text}] → text blocks.
 *   PROVENANCE (spec principle — the source HAS an explicit marker):
 *   `synthetic_reason` present and non-null ("system_reminder",
 *   "project_instructions") → harness_message; absent → user_message.
 * - reasoning: encrypted_content is undecryptable (like Codex) → dropped;
 *   the plaintext summary[] ({type:"summary_text",text}) becomes thinking
 *   blocks attached to the NEXT assistant_message (stream order is
 *   reasoning → assistant). A reasoning with an empty summary is dropped
 *   entirely (source-unavailable). Buffered thinking flushes as a
 *   standalone assistant_message if the stream ends first.
 * - assistant: plain-text content + tool_calls[] → ONE assistant_message
 *   (skipped when content is empty AND no thinking is pending — tool-call-
 *   only turns) followed by one tool_call record per entry. `arguments` is
 *   a JSON-encoded STRING — parsed into args (raw string kept when parsing
 *   fails). No `kind`: the x.ai/tool classification metadata lives only in
 *   updates.jsonl, which is dropped (source-unavailable).
 * - tool_result: observed shape {tool_call_id, content} (the research doc's
 *   older {result, status} shape is also tolerated). content verbatim;
 *   non-string content is stringified. status: "completed" → success,
 *   anything else → error; absent → success (the source carries no error
 *   marker — a failed call is indistinguishable, documented fidelity gap).
 *   Duplicate results for one tool_call_id: first in file order wins.
 * - model_id per assistant message: the first establishes the baseline;
 *   a differing later model_id emits a model_change record.
 *   reasoning_effort / model_fingerprint: dropped (process detail).
 * - tool_call status derived after projection (XOR per spec): paired →
 *   completed/failed; dangling at stream end → interrupted (no synthetic
 *   result).
 *
 * TIMESTAMPS: chat_history lines carry NONE. events.jsonl turn_started
 * carries {ts, conversation_message_count} where the count is an EXACT
 * prefix length into chat_history (verified on real data: turn k covers
 * chat lines [count[k], count[k+1])), so each projected record inherits
 * its turn's start ts; pre-turn-0 lines (system prompt + initial
 * injections) fall back to summary.json created_at. turn_started/turn_ended also emit
 * turn_boundary records (turnId = String(turn_number); end ts from
 * turn_ended when present). Without a usable events.jsonl, every record
 * falls back to summary.json created_at, then the epoch — source-derived
 * values only, never wall-clock.
 *
 * Manifest: cwd from summary.info.cwd (fallback: URL-decoded project dir
 * name); model from summary.current_model_id (fallback: first assistant
 * model_id); title from generated_title (always harness-generated →
 * titleOrigin "generated"); harnessVersion from <base>/../version.json
 * ("unknown" when absent). stats: turnCount from events turn_started
 * count (fallback signals.turnCount), durationMs from
 * signals.sessionDurationSeconds. USAGE: chat_history has no record-level
 * usage blocks and signals.json aggregates are context-window / latency
 * metrics (contextTokensUsed is NOT a sum of request input/output tokens)
 * — no honest home in AHS Usage, so no totalUsage is fabricated
 * (AC-0002-B-2; documented gap).
 *
 * RELATIONS: none. Sub-agents are not observed as separate storage, and
 * rewind_points.jsonl checkpoints carry no fork linkage (a rewind rewrites
 * this session's own history in place) — no lineage/invocation is ever
 * emitted, so includeForks is a no-op and every session is its own group
 * HEAD.
 *
 * Causal synthesis: chat_history is a temporal stream without parent
 * links — a linear chain is synthesized (seq = emission index; the linear
 * model has no parentId). Record ids are `<sessionId>:<seq>`; directory
 * entries are sorted and there are no wall-clock reads, so output is
 * byte-identical across runs.
 */

export const AHS_VERSION = "0.1.0";

const EPOCH = "1970-01-01T00:00:00.000Z";

/** Loose view of a chat_history.jsonl line; only the fields we read are typed. */
interface RawChatLine {
  type?: string;
  // user: OpenAI content blocks; assistant: plain text; system: plain text
  content?: string | RawContent[];
  synthetic_reason?: string | null;
  // reasoning
  summary?: RawContent[];
  // assistant
  tool_calls?: { id?: string; name?: string; arguments?: string }[];
  model_id?: string;
  // tool_result
  tool_call_id?: string;
  result?: unknown;
  status?: string;
}

interface RawContent {
  type?: string;
  text?: string;
}

interface SummaryJson {
  info?: { id?: string; cwd?: string };
  generated_title?: string;
  current_model_id?: string;
  created_at?: string;
}

interface SignalsJson {
  turnCount?: number;
  sessionDurationSeconds?: number;
}

interface TurnSpan {
  /** Chat-line index at which this turn starts (prefix count). */
  startIndex: number;
  turnId: string;
  startTs: string;
  endTs?: string;
}

interface SessionSource {
  sessionId: string;
  dir: string;
  projectDirName: string;
  chat: RawChatLine[];
  summary: SummaryJson;
  signals?: SignalsJson;
  turns: TurnSpan[];
  harnessVersion: string;
}

function parseJsonl<T>(content: string): T[] {
  const lines: T[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      lines.push(JSON.parse(trimmed) as T);
    } catch {
      // Tolerate a truncated tail line (crash mid-write): skip it.
    }
  }
  return lines;
}

/** Omit that distributes over the AhsRecord discriminated union. */
type RecordPayload<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EmittableRecord = RecordPayload<AhsRecord, "recordId" | "seq" | "timestamp">;

/**
 * Project ONE session's chat_history into an AHS record list (a
 * synthesized linear chain). `turns` (parsed from events.jsonl, possibly
 * empty) supplies per-record timestamps and turn_boundary placement;
 * `fallbackTimestamp` is used when no turn covers a line.
 */
export function projectRecords(
  sessionId: string,
  chat: RawChatLine[],
  turns: TurnSpan[],
  fallbackTimestamp: string,
): AhsRecord[] {
  const records: AhsRecord[] = [];
  const seenResultIds = new Set<string>();
  let lastModel: string | undefined;
  let pendingThinking: ContentBlock[] = [];

  const emit = (timestamp: string, partial: EmittableRecord): void => {
    const seq = records.length;
    records.push({
      recordId: `${sessionId}:${seq}`,
      seq,
      timestamp,
      ...partial,
    } as AhsRecord);
  };

  /** Turn covering chat-line index i (turns are sorted by startIndex). */
  const turnOf = (i: number): TurnSpan | undefined => {
    let current: TurnSpan | undefined;
    for (const t of turns) {
      if (t.startIndex > i) break;
      current = t;
    }
    return current;
  };
  const tsOf = (i: number): string => turnOf(i)?.startTs ?? fallbackTimestamp;

  /** Flush buffered reasoning summaries as a standalone assistant_message. */
  const flushThinking = (timestamp: string): void => {
    if (pendingThinking.length === 0) return;
    const blocks = pendingThinking;
    pendingThinking = [];
    emit(timestamp, { type: "assistant_message", content: blocks });
  };

  let turnCursor = 0; // index into turns for boundary placement
  for (let i = 0; i < chat.length; i += 1) {
    // Emit turn boundaries due BEFORE this line's records.
    while (turnCursor < turns.length && turns[turnCursor]!.startIndex <= i) {
      flushThinking(tsOf(i));
      const t = turns[turnCursor]!;
      emit(t.startTs, { type: "turn_boundary", phase: "start", turnId: t.turnId });
      turnCursor += 1;
    }
    const line = chat[i]!;
    const timestamp = tsOf(i);

    if (line.type === "system") {
      // Base system prompt: dropped (see header).
    } else if (line.type === "user") {
      flushThinking(timestamp);
      const blocks: ContentBlock[] = [];
      if (Array.isArray(line.content)) {
        for (const c of line.content) {
          if (c.type === "text" && typeof c.text === "string") {
            blocks.push({ type: "text", text: c.text });
          }
        }
      } else if (typeof line.content === "string" && line.content !== "") {
        blocks.push({ type: "text", text: line.content });
      }
      if (blocks.length === 0) continue;
      // Provenance: the source's explicit synthetic_reason marker decides.
      const synthetic = line.synthetic_reason !== undefined && line.synthetic_reason !== null;
      emit(timestamp, { type: synthetic ? "harness_message" : "user_message", content: blocks });
    } else if (line.type === "reasoning") {
      // Encrypted reasoning: keep only the plaintext summary as thinking.
      for (const s of line.summary ?? []) {
        if (s.type === "summary_text" && typeof s.text === "string" && s.text !== "") {
          pendingThinking.push({ type: "thinking", text: s.text });
        }
      }
    } else if (line.type === "assistant") {
      const blocks: ContentBlock[] = [...pendingThinking];
      pendingThinking = [];
      if (typeof line.content === "string" && line.content !== "") {
        blocks.push({ type: "text", text: line.content });
      }
      if (blocks.length > 0) {
        emit(timestamp, { type: "assistant_message", content: blocks });
      }
      for (const call of line.tool_calls ?? []) {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments ?? "null");
        } catch {
          args = call.arguments;
        }
        emit(timestamp, {
          type: "tool_call",
          toolCallId: call.id ?? "",
          name: call.name ?? "",
          args,
        });
      }
      if (typeof line.model_id === "string" && line.model_id !== "") {
        if (lastModel === undefined) {
          lastModel = line.model_id;
        } else if (line.model_id !== lastModel) {
          lastModel = line.model_id;
          emit(timestamp, { type: "model_change", model: line.model_id });
        }
      }
    } else if (line.type === "tool_result") {
      flushThinking(timestamp);
      const callId = line.tool_call_id ?? "";
      if (seenResultIds.has(callId)) continue; // first in file order wins
      seenResultIds.add(callId);
      const out = line.content ?? line.result;
      emit(timestamp, {
        type: "tool_result",
        toolCallId: callId,
        content:
          typeof out === "string" ? out : out === undefined || out === null ? "" : JSON.stringify(out),
        status:
          line.status === undefined
            ? "success" // no error marker in the source
            : line.status === "completed"
              ? "success"
              : "error",
      });
    }
    // Anything else: dropped per ADR-0001.

    // Turn end boundary: last chat line of the turn's span.
    const spanEnd =
      turnCursor > 0 && turnCursor <= turns.length
        ? turnCursor === turns.length
          ? chat.length
          : turns[turnCursor]!.startIndex
        : 0;
    if (turnCursor > 0 && i + 1 === spanEnd) {
      const t = turns[turnCursor - 1]!;
      flushThinking(t.endTs ?? timestamp);
      emit(t.endTs ?? timestamp, { type: "turn_boundary", phase: "end", turnId: t.turnId });
    }
  }
  flushThinking(fallbackTimestamp);

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

/** Build the session-level Manifest from summary/signals/events + records. */
function buildManifest(
  source: SessionSource,
  records: AhsRecord[],
  firstModel: string | undefined,
): Manifest {
  const { summary, signals } = source;
  const cwd =
    summary.info?.cwd ??
    (() => {
      try {
        return decodeURIComponent(source.projectDirName);
      } catch {
        return source.projectDirName;
      }
    })();

  let turnCount = source.turns.length;
  if (turnCount === 0 && typeof signals?.turnCount === "number") {
    turnCount = signals.turnCount;
  }
  const durationMs =
    typeof signals?.sessionDurationSeconds === "number"
      ? signals.sessionDurationSeconds * 1000
      : undefined;

  return {
    sessionId: source.sessionId,
    harness: "grok",
    harnessVersion: source.harnessVersion,
    ahsVersion: AHS_VERSION,
    cwd,
    model: summary.current_model_id ?? firstModel ?? "unknown",
    provider: "xai",
    ...(summary.generated_title !== undefined
      ? { title: summary.generated_title, titleOrigin: "generated" as const }
      : {}),
    stats: {
      turnCount,
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
  };
}

export class GrokAdapter implements HarnessAdapter {
  readonly harness = "grok";
  readonly capabilities = { history: "full", control: false } as const;

  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(homedir(), ".grok", "sessions");
  }

  private async loadHarnessVersion(): Promise<string> {
    try {
      const v = JSON.parse(
        await readFile(path.join(path.dirname(this.basePath), "version.json"), "utf8"),
      ) as { version?: string };
      return v.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Discover session dirs (<base>/%2F<cwd>/<ulid>/) with a readable chat_history. */
  private async discover(): Promise<SessionSource[]> {
    const harnessVersion = await this.loadHarnessVersion();
    let projectDirs: string[];
    try {
      projectDirs = (await readdir(this.basePath, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }

    const sessions: SessionSource[] = [];
    for (const project of projectDirs) {
      const projectPath = path.join(this.basePath, project);
      let sessionDirs: string[];
      try {
        sessionDirs = (await readdir(projectPath, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch {
        continue;
      }
      for (const sessionId of sessionDirs) {
        const dir = path.join(projectPath, sessionId);
        let chat: RawChatLine[];
        try {
          chat = parseJsonl<RawChatLine>(await readFile(path.join(dir, "chat_history.jsonl"), "utf8"));
        } catch {
          continue; // no readable canonical file — not a projectable session
        }
        const summary = await readJson<SummaryJson>(path.join(dir, "summary.json"), {});
        const signals = await readJson<SignalsJson | undefined>(
          path.join(dir, "signals.json"),
          undefined,
        );
        const turns = await loadTurns(path.join(dir, "events.jsonl"), chat.length);
        sessions.push({
          sessionId,
          dir,
          projectDirName: project,
          chat,
          summary,
          ...(signals !== undefined ? { signals } : {}),
          turns,
          harnessVersion,
        });
      }
    }
    return sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    if (filter?.harness !== undefined && filter.harness !== this.harness) return;
    // includeForks: this adapter NEVER emits lineage (no fork linkage in the
    // source), so every session is its own lineage group's HEAD and the
    // default view equals includeForks.
    for (const session of await this.discover()) {
      const fallback = session.summary.created_at ?? EPOCH;
      const records = projectRecords(session.sessionId, session.chat, session.turns, fallback);
      // Sessions with zero projectable content are not AHS sessions — skip.
      if (records.length === 0) continue;
      const manifest = buildManifest(session, records, firstAssistantModel(session.chat));
      if (filter?.cwd !== undefined && manifest.cwd !== filter.cwd) continue;
      yield manifest;
    }
  }

  async *readRecords(sessionId: string): AsyncIterable<AhsRecord> {
    for (const session of await this.discover()) {
      if (session.sessionId === sessionId) {
        const fallback = session.summary.created_at ?? EPOCH;
        yield* projectRecords(session.sessionId, session.chat, session.turns, fallback);
        return;
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function firstAssistantModel(chat: RawChatLine[]): string | undefined {
  for (const line of chat) {
    if (line.type === "assistant" && typeof line.model_id === "string" && line.model_id !== "") {
      return line.model_id;
    }
  }
  return undefined;
}

/**
 * Parse events.jsonl into turn spans. Only turn_started (ts +
 * conversation_message_count prefix) and turn_ended (ts) are read; the
 * loop/phase/tool lifecycle events are process detail (dropped). A span
 * whose start index does not advance monotonically is dropped defensively.
 */
async function loadTurns(eventsPath: string, chatLength: number): Promise<TurnSpan[]> {
  let lines: { type?: string; ts?: string; turn_number?: number; conversation_message_count?: number }[];
  try {
    lines = parseJsonl(await readFile(eventsPath, "utf8"));
  } catch {
    return [];
  }
  const turns: TurnSpan[] = [];
  let lastStart = -1;
  let open: TurnSpan | undefined;
  for (const line of lines) {
    if (line.type === "turn_started") {
      const startIndex = line.conversation_message_count;
      if (
        typeof startIndex !== "number" ||
        startIndex <= lastStart ||
        startIndex > chatLength ||
        typeof line.ts !== "string"
      ) {
        continue;
      }
      lastStart = startIndex;
      open = {
        startIndex,
        turnId: String(line.turn_number ?? turns.length),
        startTs: line.ts,
      };
      turns.push(open);
    } else if (line.type === "turn_ended" && open !== undefined && typeof line.ts === "string") {
      open.endTs = line.ts;
      open = undefined;
    }
  }
  return turns;
}
