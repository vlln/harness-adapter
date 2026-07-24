import type { Manifest } from "../schema/manifest";
import type { AhsRecord, ContentBlock } from "../schema/record";
import type { BlobRef } from "../schema/blob";
import type { Usage } from "../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../store/adapter";

/**
 * Public types of the Session Facade (interface-0003). The authoritative
 * implementation is src/session/facade.ts.
 *
 * ADR-0006: Task is now intra-session (session = directory with multiple
 * branches). The facade projects the HEAD branch and stitches the HEAD
 * chain for the user view.
 */

/**
 * One item of the conversation projection (interface-0003 messages()
 * mapping table). Order follows file (JSONL line) order. `timestamp` is carried on every item
 * (including tool items — see the interface; additive, items are unusable
 * on a timeline without it).
 */
export type ConversationItem =
  | { kind: "user"; content: ContentBlock[]; timestamp: string }
  | { kind: "assistant"; content: ContentBlock[]; timestamp: string }
  | { kind: "harness"; content: ContentBlock[]; timestamp: string }
  | {
      kind: "tool";
      call: { name: string; args: unknown };
      /** Absent when the call has no paired result (interrupted). */
      result?: { content: string | BlobRef; status?: "success" | "error" };
      status?: "completed" | "failed" | "interrupted";
      /** Forward invocation link(s), copied from the paired tool_result. */
      sessionIds?: string[];
      timestamp: string;
    };

/** State records exposed as-is (file order) via events(). */
export type StateEvent = Extract<
  AhsRecord,
  { type: "turn_boundary" | "model_change" | "compaction" | "goal_update" }
>;

/** Storage view of one session (interface-0003). */
export interface AhsSession {
  readonly manifest: Manifest;
  /** Conversation projection of the HEAD branch (tool pairing done inside). */
  messages(): ConversationItem[];
  /** State-event timeline of the HEAD branch (turn_boundary/model_change/compaction/goal_update). */
  events(): StateEvent[];
  /** This session's usage, summed over HEAD branch records. */
  readonly usage: Usage;
  /** Direct invocation children discoverable in the same store. */
  children(): Promise<AhsSession[]>;
}

/** User view: a session's HEAD chain (ADR-0006: intra-session). */
export interface AhsTask {
  /** The session this task belongs to. */
  readonly sessionId: string;
  /** HEAD branch session view. */
  readonly head: AhsSession;
  /** Branch names in this session, sorted. */
  readonly branches: string[];
  /**
   * HEAD-chain stitching: walk from HEAD branch back through parentBranch
   * to root branch, cutting at each segment's parentRecordId. One linear
   * conversation, no duplicated prefix.
   */
  messages(): ConversationItem[];
}

export interface HarnessFacade {
  readonly adapter: HarnessAdapter;
  /** Pass-through to the underlying adapter. */
  listSessions(filter?: SessionFilter): AsyncIterable<Manifest>;
  /** Storage view. Throws SessionNotFoundError for unknown ids. */
  loadSession(sessionId: string): Promise<AhsSession>;
  /** User view (HEAD chain stitching). Throws SessionNotFoundError for unknown ids. */
  loadTask(sessionId: string): Promise<AhsTask>;
}