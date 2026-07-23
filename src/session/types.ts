import type { Manifest } from "../schema/manifest";
import type { AhsRecord, ContentBlock } from "../schema/record";
import type { BlobRef } from "../schema/blob";
import type { Usage } from "../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../store/adapter";

/**
 * Public types of the Session Facade (interface-0003). The authoritative
 * implementation is src/session/facade.ts.
 */

/**
 * One item of the conversation projection (interface-0003 messages()
 * mapping table). Order follows seq. `timestamp` is carried on every item
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

/** State records exposed as-is (seq order) via events(). */
export type StateEvent = Extract<
  AhsRecord,
  { type: "turn_boundary" | "model_change" | "compaction" | "goal_update" }
>;

/** Storage view of one session (interface-0003). */
export interface AhsSession {
  readonly manifest: Manifest;
  /** Conversation projection (tool pairing done inside the projection). */
  messages(): ConversationItem[];
  /** State-event timeline (turn_boundary/model_change/compaction/goal_update). */
  events(): StateEvent[];
  /** This session's usage, summed over its own records. */
  readonly usage: Usage;
  /** Direct invocation children discoverable in the same store. */
  children(): Promise<AhsSession[]>;
}

/** User view: a lineage group + its HEAD pointer (interface-0003). */
export interface AhsTask {
  readonly groupId: string;
  /** HEAD session (recency heuristic, same as the relations store). */
  readonly head: AhsSession;
  /** All sessions of the group (forks/attempts), sorted by sessionId. */
  readonly members: AhsSession[];
  /**
   * HEAD-chain stitching: shared prefixes walked back along lineage
   * (cut at atRecordId; null = full parent slice; absent = parent
   * contributes nothing) + the HEAD suffix. One linear conversation,
   * no duplicated prefix.
   */
  messages(): ConversationItem[];
}

export interface HarnessFacade {
  readonly adapter: HarnessAdapter;
  /** Pass-through to the underlying adapter. */
  listSessions(filter?: SessionFilter): AsyncIterable<Manifest>;
  /** Storage view. Throws SessionNotFoundError for unknown ids. */
  loadSession(sessionId: string): Promise<AhsSession>;
  /** User view (lineage group + HEAD). Throws SessionNotFoundError for unknown ids. */
  loadTask(sessionId: string): Promise<AhsTask>;
}
