/**
 * Hand-built in-memory AHS sessions for core-layer tests (no adapter
 * fixtures involved). Every builder emits schema-valid shapes by default;
 * tests pass overrides to construct negative cases.
 *
 * Multi-branch session model (ADR-0006): each session has a branch registry
 * (branches) and HEAD pointer. Records are per-branch; `records` is the
 * default/HEAD branch set.
 */

import type { Manifest } from "../src/schema/manifest";
import type { AhsRecord } from "../src/schema/record";
import type { HarnessAdapter } from "../src/store/adapter";
import type { SessionData } from "../src/validate/index";

export const BASE_TIME = "2026-07-20T10:00:00.000Z";

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  const { branches: br, HEAD: hd, ...rest } = overrides;
  return {
    sessionId: "sess-1",
    harness: "fake",
    harnessVersion: "0",
    ahsVersion: "0.1.0",
    cwd: "/tmp",
    model: "fake-model",
    branches: br ?? {
      main: { parentBranch: null, parentRecordId: null },
    },
    HEAD: hd ?? { branch: "main", recordId: null },
    ...rest,
  };
}

interface RecordExtras {
  recordId?: string;
  timestamp?: string;
  usage?: AhsRecord["usage"];
}

function base(extras: RecordExtras = {}) {
  return {
    recordId: extras.recordId ?? "r0",
    timestamp: extras.timestamp ?? BASE_TIME,
    ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
  };
}

export function userMessage(text: string, extras: RecordExtras = {}): AhsRecord {
  return { ...base(extras), type: "user_message", content: [{ type: "text", text }] };
}

export function assistantMessage(text: string, extras: RecordExtras = {}): AhsRecord {
  return {
    ...base(extras),
    type: "assistant_message",
    content: [{ type: "text", text }],
  };
}

export function toolCall(
  toolCallId: string,
  extras: RecordExtras & { name?: string; status?: "completed" | "failed" | "interrupted" } = {},
): AhsRecord {
  return {
    ...base(extras),
    type: "tool_call",
    toolCallId,
    name: extras.name ?? "Bash",
    args: {},
    ...(extras.status !== undefined ? { status: extras.status } : {}),
  };
}

export function toolResult(
  toolCallId: string,
  content: string,
  extras: RecordExtras & { sessionIds?: string[] } = {},
): AhsRecord {
  return {
    ...base(extras),
    type: "tool_result",
    toolCallId,
    content,
    ...(extras.sessionIds !== undefined ? { sessionIds: extras.sessionIds } : {}),
  };
}

/** A valid minimal session: root user message only, single "main" branch. */
export function makeSession(
  sessionId: string,
  records?: AhsRecord[],
  manifest?: Partial<Manifest>,
  branchRecords?: Record<string, AhsRecord[]>,
): SessionData {
  const result: SessionData = {
    manifest: makeManifest({ sessionId, ...manifest }),
    records: records ?? [userMessage("hi")],
  };
  if (branchRecords !== undefined) result.branchRecords = branchRecords;
  return result;
}

/** Stub HarnessAdapter returning canned sessions — also exercises the writer's adapter-facing API. */
export function fakeAdapter(sessions: SessionData[]): HarnessAdapter {
  return {
    harness: "fake",
    capabilities: { history: "full", control: false },
    async *listSessions() {
      for (const s of sessions) yield s.manifest;
    },
    async *readRecords(sessionId: string, branchName?: string) {
      const session = sessions.find((s) => s.manifest.sessionId === sessionId);
      if (session === undefined) throw new Error(`unknown session: ${sessionId}`);
      if (branchName !== undefined && session.branchRecords?.[branchName]) {
        yield* session.branchRecords[branchName]!;
      } else {
        yield* session.records;
      }
    },
  };
}
