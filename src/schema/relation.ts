import { z } from "zod";

/**
 * Directed relation between sessions.
 * - spawned_by: subagent session; toolCallId anchors the Task-like tool call
 *   in the parent session (optional — some harnesses only have an agent-level parent id).
 * - forked_from: new session created by a user fork/rewind.
 * - sibling_attempt: competing branch of the same task; see Manifest.isMainChain.
 */
export const RelationSchema = z.object({
  type: z.enum(["spawned_by", "forked_from", "sibling_attempt"]),
  /** Parent/source session id. */
  sessionId: z.string(),
  /** Anchor for spawned_by: the tool call in the parent session. */
  toolCallId: z.string().optional(),
});

export type Relation = z.infer<typeof RelationSchema>;
