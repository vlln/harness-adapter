import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Claude Code → AHS read-only projection.
 *
 * Source layout (docs/research/schemas/claude-code-schema.md):
 *   <base>/<project-dir>/<session-uuid>.jsonl          main session stream
 *   <base>/<project-dir>/<session-uuid>/subagents/
 *     agent-<agent-id>.jsonl                           sub-agent stream
 *     agent-<agent-id>.meta.json                       { agentType, description, toolUseId }
 *
 * Mapping decisions (lossy projection, ADR-0001 / ADR-0005):
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
 *   order is preserved via seq (the linear model has no parentId).
 * - When an assistant message has only tool_use blocks, no assistant_message
 *   is emitted; the usage (must not be silently lost, AC-0002-N-4) rides on
 *   the first tool_call record.
 * - tool_result blocks live inside `user` records (array content). String
 *   content is kept verbatim; non-string content is JSON.stringify'd.
 *   When the same toolCallId yields several tool_results (resubmit/branch),
 *   the FIRST in file order is kept and later ones dropped.
 * - tool_call status is derived after projection: "completed"/"failed" from
 *   the paired tool_result status; "interrupted" when the session ends
 *   without a paired result (no synthetic result record is emitted).
 * - Compaction: Claude marks compaction with `isCompactSummary: true` on a
 *   user record (content = the continued-context summary) → `compaction`
 *   records. Session titles come from legacy `type: "summary"` lines
 *   (`summary` field) or current `type: "ai-title"` lines (`aiTitle`
 *   field) → Manifest.title (titleOrigin "generated").
 * - Claude Code has no explicit harness-injected-message markers, so no
 *   `harness_message` records are emitted; such messages stay user_message
 *   (source-unavailable provenance, per spec).
 * - Sidechains: each `subagents/agent-*.jsonl` file is one child session;
 *   inline `isSidechain: true` records in the main file are grouped by
 *   `agentId` into child sessions as well. Child sessionId = agentId; child
 *   Manifest.invocation = { sessionId: parent session }.
 *   TODO(Plan 02): anchor the back-link (atRecordId = the parent's spawning
 *   tool_call record, via meta.toolUseId / first record's `sourceToolUseID`)
 *   and write the forward link into the parent's paired tool_result.sessionId.
 * - Usage: coarse totals only (input/output/cache read/cache write); the
 *   ephemeral 1h/5m tiers, service_tier, inference_geo, server_tool_use are
 *   dropped per ADR-0001.
 *
 * Determinism (AC-0002-N-5): directory entries are sorted, seq follows file
 * line order, recordIds are source uuids — no wall-clock reads anywhere.
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

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

/**
 * Project the lines of ONE session (main lines, or one sub-agent's lines)
 * into an AHS record list. Lines must already be filtered to this session.
 * Linear model (ADR-0005): records are emitted in file order; seq is the
 * only structural field. TODO(Plan 02): in-file forks (edit-resend, retries)
 * must be split into separate fork sessions with lineage edges.
 */
export function projectRecords(lines: RawLine[]): AhsRecord[] {
  const records: AhsRecord[] = [];
  const seenToolResults = new Set<string>();
  let seq = 0;

  const emit = (rec: AhsRecord): void => {
    records.push(rec);
    seq += 1;
  };

  for (const line of lines) {
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
            // Resubmit/branch can produce several tool_results for the same
            // toolCallId — keep the first in file order, drop later ones.
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
  invocation?: Manifest["invocation"],
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
  // versions emit `type:"ai-title"` lines with an `aiTitle` field.
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
    ...(invocation !== undefined ? { invocation } : {}),
    stats: {
      turnCount,
      ...(hasUsage ? { totalUsage } : {}),
    },
  };
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly harness = "claude-code";
  readonly capabilities = { history: "full", control: false } as const;

  private readonly basePath: string;

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
   * Invocation back-link for a child session. The toolUseId anchor
   * (meta.toolUseId, or the first record's sourceToolUseID for inline
   * groups) is not wired to atRecordId yet — that plus the parent's
   * tool_result.sessionId forward link is Plan 02 work.
   */
  private static childInvocation(parentSessionId: string): Manifest["invocation"] {
    return { sessionId: parentSessionId };
  }

  /** Load and split one main session file; sub-agent file lines are attached to their ChildSource. */
  private async loadSession(session: SessionSource): Promise<{
    main: RawLine[];
    inline: Map<string, RawLine[]>;
    children: ChildSource[];
  }> {
    const lines = parseJsonl(await readFile(session.filePath, "utf8"));
    const { main, inline } = ClaudeCodeAdapter.splitMainLines(lines);
    const children = ClaudeCodeAdapter.mergedChildren(session, inline);
    for (const child of children) {
      if (child.filePath !== undefined) {
        child.fileLines = parseJsonl(await readFile(child.filePath, "utf8"));
      }
    }
    return { main, inline, children };
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    for (const session of await this.discover()) {
      if (filter?.harness !== undefined && filter.harness !== this.harness) return;
      const { main, inline, children } = await this.loadSession(session);
      const records = projectRecords(main);
      // Sessions with zero projectable content (only dropped process records
      // such as mode/permission-mode) are not AHS sessions — skip them.
      if (records.length > 0) {
        const manifest = buildManifest(session.sessionId, main, records);
        if (filter?.cwd !== undefined && manifest.cwd !== filter.cwd) {
          // Children of a filtered-out parent are also skipped: the parent's
          // records anchor their invocation back-link.
          continue;
        }
        yield manifest;
      }
      for (const child of children) {
        const cLines = ClaudeCodeAdapter.childLines(child, inline);
        const cRecords = projectRecords(cLines);
        if (cRecords.length === 0) continue;
        yield buildManifest(
          child.agentId,
          cLines,
          cRecords,
          ClaudeCodeAdapter.childInvocation(session.sessionId),
        );
      }
    }
  }

  async *readRecords(sessionId: string): AsyncIterable<AhsRecord> {
    for (const session of await this.discover()) {
      if (session.sessionId === sessionId) {
        const { main } = await this.loadSession(session);
        yield* projectRecords(main);
        return;
      }
    }
    // Child sessions: a second pass is needed only when the id is no main session.
    for (const session of await this.discover()) {
      const { inline, children } = await this.loadSession(session);
      for (const child of children) {
        if (child.agentId === sessionId) {
          yield* projectRecords(ClaudeCodeAdapter.childLines(child, inline));
          return;
        }
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }
}
