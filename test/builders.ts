/**
 * Hand-built in-memory AHS sessions for core-layer tests (no adapter
 * fixtures involved). Every builder emits schema-valid shapes by default;
 * tests pass overrides to construct negative cases.
 *
 * Linear-session model (ADR-0005): records carry no parentId; seq is the
 * only structural field.
 */

import type { Manifest } from "../src/schema/manifest";
import type { AhsRecord } from "../src/schema/record";
import type { HarnessAdapter } from "../src/store/adapter";
import type { SessionData } from "../src/validate/index";

export const BASE_TIME = "2026-07-20T10:00:00.000Z";

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    sessionId: "sess-1",
    harness: "fake",
    harnessVersion: "0",
    ahsVersion: "0.1.0",
    cwd: "/tmp",
    model: "fake-model",
    ...overrides,
  };
}

interface RecordExtras {
  recordId?: string;
  timestamp?: string;
  usage?: AhsRecord["usage"];
}

function base(seq: number, extras: RecordExtras = {}) {
  return {
    recordId: extras.recordId ?? `r${seq}`,
    seq,
    timestamp: extras.timestamp ?? BASE_TIME,
    ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
  };
}

export function userMessage(
  seq: number,
  text: string,
  extras: RecordExtras = {},
): AhsRecord {
  return { ...base(seq, extras), type: "user_message", content: [{ type: "text", text }] };
}

export function assistantMessage(
  seq: number,
  text: string,
  extras: RecordExtras = {},
): AhsRecord {
  return {
    ...base(seq, extras),
    type: "assistant_message",
    content: [{ type: "text", text }],
  };
}

export function toolCall(
  seq: number,
  toolCallId: string,
  extras: RecordExtras & { name?: string; status?: "completed" | "failed" | "interrupted" } = {},
): AhsRecord {
  return {
    ...base(seq, extras),
    type: "tool_call",
    toolCallId,
    name: extras.name ?? "Bash",
    args: {},
    ...(extras.status !== undefined ? { status: extras.status } : {}),
  };
}

export function toolResult(
  seq: number,
  toolCallId: string,
  content: string,
  extras: RecordExtras & { sessionIds?: string[] } = {},
): AhsRecord {
  return {
    ...base(seq, extras),
    type: "tool_result",
    toolCallId,
    content,
    ...(extras.sessionIds !== undefined ? { sessionIds: extras.sessionIds } : {}),
  };
}

/** A valid minimal session: root user message only. */
export function makeSession(sessionId: string, records?: AhsRecord[], manifest?: Partial<Manifest>): SessionData {
  return {
    manifest: makeManifest({ sessionId, ...manifest }),
    records: records ?? [userMessage(0, "hi")],
  };
}

/** Stub HarnessAdapter returning canned sessions — also exercises the writer's adapter-facing API. */
export function fakeAdapter(sessions: SessionData[]): HarnessAdapter {
  return {
    harness: "fake",
    capabilities: { history: "full", control: false },
    async *listSessions() {
      for (const s of sessions) yield s.manifest;
    },
    async *readRecords(sessionId: string) {
      const session = sessions.find((s) => s.manifest.sessionId === sessionId);
      if (session === undefined) throw new Error(`unknown session: ${sessionId}`);
      yield* session.records;
    },
  };
}
