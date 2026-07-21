import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Manifest } from "../../schema/manifest";
import type { AhsRecord, ContentBlock } from "../../schema/record";
import type { Usage } from "../../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../../store/adapter";

/**
 * Claude Code → AHS read-only projection (spike for ADR-0001 / ADR-0002).
 *
 * Source layout (see docs/research/schemas/claude-code-schema.md):
 *   <base>/<project-dir>/<session-uuid>.jsonl          main session stream
 *   <base>/<project-dir>/<session-uuid>/subagents/
 *     agent-<agent-id>.jsonl                           sub-agent stream
 *     agent-<agent-id>.meta.json                       { agentType, description, toolUseId }
 *
 * Mapping decisions (lossy projection, ADR-0001):
 * - uuid → recordId as-is; parentUuid → parentId. Records of dropped types
 *   (queue-operation / attachment / last-prompt / system / mode /
 *   permission-mode / file-history-snapshot / summary-title) forward their
 *   resolved parent to their children, so the kept tree stays connected.
 * - Assistant `tool_use` blocks are split out of the assistant message into
 *   their own `tool_call` records. Chain rule: within one source record the
 *   emitted records form a chain (assistant_message → tool_call → tool_call …
 *   or user_message → tool_result …); the NEXT source record parents to the
 *   LAST record emitted by its parent source record. This keeps a proper
 *   single-parent tree while preserving emission order via seq.
 * - When an assistant message has only tool_use blocks (no text/thinking), no
 *   assistant_message is emitted; the usage (which must not be silently lost,
 *   AC-0002-N-4) is attached to the first tool_call record instead.
 * - tool_result blocks live inside `user` records (array content). String
 *   content is kept verbatim; non-string content is JSON.stringify'd.
 * - Compaction: Claude marks compaction with `isCompactSummary: true` on a
 *   user record (content = the continued-context summary). These become
 *   `compaction` records. The unrelated `type: "summary"` line is the
 *   AI-generated session TITLE — it is mapped to Manifest.title instead.
 * - Sidechains (ADR-0002): each `subagents/agent-*.jsonl` file is one child
 *   session; inline `isSidechain: true` records in the main file are grouped
 *   by `agentId` into child sessions as well. Child sessionId = agentId.
 *   Child Manifest.relation = spawned_by(parent session, meta.toolUseId,
 *   falling back to the first record's `sourceToolUseID` for inline groups).
 * - Usage: coarse totals only (input/output/cache read/cache write); the
 *   ephemeral 1h/5m tiers, service_tier, inference_geo, server_tool_use are
 *   dropped per ADR-0001.
 *
 * Determinism: directory entries are sorted, seq follows file line order,
 * recordIds are source uuids — no wall-clock reads anywhere.
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
  inlineLines?: RawLine[];
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
 * into an AHS record tree. Lines must already be filtered to this session.
 */
export function projectRecords(lines: RawLine[]): AhsRecord[] {
  const records: AhsRecord[] = [];
  // source uuid -> recordId this source record resolved to. For dropped
  // records this forwards the resolved parent so the kept tree stays linked.
  const resolved = new Map<string, string | null>();
  let seq = 0;
  let lastEmitted: string | null = null;

  const emit = (rec: AhsRecord): string => {
    records.push(rec);
    seq += 1;
    lastEmitted = rec.recordId;
    return rec.recordId;
  };

  for (const line of lines) {
    const uuid = line.uuid;
    const timestamp = line.timestamp ?? "";
    // Parent resolution: a parentUuid already seen maps to its last emitted
    // record (or forwarded ancestor). An unknown parentUuid is either an
    // external anchor (sidechain root pointing into the parent session) at
    // the start — becomes this session's root — or a gap mid-stream, where
    // we fall back to the previous record to keep a single root.
    let parent: string | null;
    if (line.parentUuid == null) {
      parent = null;
    } else if (resolved.has(line.parentUuid)) {
      parent = resolved.get(line.parentUuid) ?? null;
    } else {
      parent = lastEmitted;
    }
    // Real Claude files contain mid-stream chain restarts: dropped-type
    // records (system/attachment/...) with parentUuid null whose kept
    // children would each become an extra root, violating the single-rooted
    // tree. Once a root exists, re-anchor such records to the current tip.
    if (parent === null && lastEmitted !== null) {
      parent = lastEmitted;
    }

    let emitted = false;
    const base = { parentId: parent, timestamp };
    const nextParent = (): string | null => (emitted ? lastEmitted : parent);
    const nextSeq = (): number => seq;

    if (line.type === "user" && uuid !== undefined) {
      if (line.isCompactSummary === true) {
        // Compaction marker: the user record's string content IS the
        // continued-context summary (a key state event, not conversation).
        const summary =
          typeof line.message?.content === "string" ? line.message.content : undefined;
        emit({
          ...base,
          recordId: uuid,
          parentId: nextParent(),
          seq: nextSeq(),
          type: "compaction",
          ...(summary !== undefined ? { summary } : {}),
        });
        emitted = true;
      } else {
        const content = line.message?.content;
        if (typeof content === "string") {
          // Verbatim, including slash-command XML markup (do not parse).
          emit({
            ...base,
            recordId: uuid,
            parentId: nextParent(),
            seq: nextSeq(),
            type: "user_message",
            content: [{ type: "text", text: content }],
          });
          emitted = true;
        } else if (Array.isArray(content)) {
          const textBlocks: ContentBlock[] = [];
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              textBlocks.push({ type: "text", text: block.text });
            }
          }
          if (textBlocks.length > 0) {
            emit({
              ...base,
              recordId: uuid,
              parentId: nextParent(),
              seq: nextSeq(),
              type: "user_message",
              content: textBlocks,
            });
            emitted = true;
          }
          let toolResultIndex = 0;
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            // tool_result blocks share the source uuid; suffix keeps
            // recordIds unique and deterministic when there are several.
            const recordId =
              toolResultIndex === 0 ? uuid : `${uuid}/tool_result/${toolResultIndex}`;
            toolResultIndex += 1;
            emit({
              ...base,
              recordId,
              parentId: nextParent(),
              seq: nextSeq(),
              type: "tool_result",
              toolCallId: block.tool_use_id ?? "",
              content: stringifyToolResultContent(block.content),
              status: block.is_error === true ? "error" : "success",
            });
            emitted = true;
          }
        }
      }
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
      if (contentBlocks.length > 0) {
        emit({
          ...base,
          ...extras,
          recordId: uuid,
          parentId: nextParent(),
          seq: nextSeq(),
          type: "assistant_message",
          content: contentBlocks,
        });
        emitted = true;
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
          ...base,
          ...carryExtras,
          recordId,
          parentId: nextParent(),
          seq: nextSeq(),
          type: "tool_call",
          toolCallId: block.id ?? "",
          name: block.name ?? "",
          args: block.input,
        });
        emitted = true;
      }
    }
    // All other types (queue-operation, attachment, last-prompt, summary,
    // system, mode, permission-mode, file-history-snapshot, ...) are dropped
    // per ADR-0001 (process/telemetry). Their children re-anchor through
    // the forwarding map below.

    if (uuid !== undefined) {
      resolved.set(uuid, emitted ? lastEmitted : parent);
    }
  }

  return records;
}

/** Build the session-level Manifest from raw lines + projected records. */
function buildManifest(
  sessionId: string,
  lines: RawLine[],
  records: AhsRecord[],
  relation?: Manifest["relation"],
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
      totalUsage.outputTokens =
        (totalUsage.outputTokens ?? 0) + (rec.usage.outputTokens ?? 0);
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
  const title = firstWith("summary");
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
    ...(relation !== undefined ? { relation } : {}),
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
          children: [...children.values()].sort((a, b) =>
            a.agentId.localeCompare(b.agentId),
          ),
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
  private async childLines(
    child: ChildSource,
    inline: Map<string, RawLine[]>,
  ): Promise<RawLine[]> {
    if (child.filePath !== undefined) {
      return parseJsonl(await readFile(child.filePath, "utf8"));
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

  private static childRelation(parentSessionId: string, child: ChildSource, lines: RawLine[]): Manifest["relation"] {
    const toolCallId =
      child.meta?.toolUseId ??
      lines.find((l) => typeof l.sourceToolUseID === "string")?.sourceToolUseID;
    return {
      type: "spawned_by",
      sessionId: parentSessionId,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    };
  }

  async *listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    for (const session of await this.discover()) {
      if (filter?.harness !== undefined && filter.harness !== this.harness) return;
      const lines = parseJsonl(await readFile(session.filePath, "utf8"));
      const { main, inline } = ClaudeCodeAdapter.splitMainLines(lines);
      const records = projectRecords(main);
      // Sessions with zero projectable content (only dropped process records
      // such as mode/permission-mode) are not AHS sessions — skip them.
      if (records.length > 0) {
        const manifest = buildManifest(session.sessionId, main, records);
        if (filter?.cwd !== undefined && manifest.cwd !== filter.cwd) continue;
        yield manifest;
      }
      for (const child of ClaudeCodeAdapter.mergedChildren(session, inline)) {
        const cLines = await this.childLines(child, inline);
        const cRecords = projectRecords(cLines);
        if (cRecords.length === 0) continue;
        yield buildManifest(
          child.agentId,
          cLines,
          cRecords,
          ClaudeCodeAdapter.childRelation(session.sessionId, child, cLines),
        );
      }
    }
  }

  async *readRecords(sessionId: string): AsyncIterable<AhsRecord> {
    for (const session of await this.discover()) {
      const lines = parseJsonl(await readFile(session.filePath, "utf8"));
      const { main, inline } = ClaudeCodeAdapter.splitMainLines(lines);
      if (session.sessionId === sessionId) {
        yield* projectRecords(main);
        return;
      }
      for (const child of ClaudeCodeAdapter.mergedChildren(session, inline)) {
        if (child.agentId === sessionId) {
          yield* projectRecords(await this.childLines(child, inline));
          return;
        }
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }
}
