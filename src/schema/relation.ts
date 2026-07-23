import { z } from "zod";

/**
 * The two orthogonal relation dimensions between sessions (ADR-0005).
 * Both live on the child session's Manifest as optional back-links;
 * cross-session references are addressed by recordId.
 */

/**
 * lineage (history dimension) — "where my history comes from".
 * A fork session stores only the post-fork suffix; the shared prefix is
 * stitched by walking lineage back.
 * - forked_from: anchored after an agent-side record (the fork continues
 *   with NEW user input; edit-resend included).
 * - sibling_attempt: anchored after a user_message (a re-answer to the SAME
 *   prompt; competing attempts).
 * atRecordId omitted = retry from the very start (the fork carries its own
 * prompt copy).
 */
export const LineageSchema = z.object({
  type: z.enum(["forked_from", "sibling_attempt"]),
  /** Parent/source session id. */
  sessionId: z.string(),
  /** Anchor record in the parent session the fork diverges after. */
  atRecordId: z.string().optional(),
});

export type Lineage = z.infer<typeof LineageSchema>;

/**
 * invocation (call dimension) — "who invoked/created me". The forward link
 * lives in the parent session's history as tool_result.sessionId; this is
 * the session-level back-link, reconciled against the forward link by
 * AC-0002-N-2. atRecordId omitted when the source harness only has an
 * agent-level parent link (AC-0002-B-3, e.g. Kimi).
 */
export const InvocationSchema = z.object({
  /** Parent/invoking session id. */
  sessionId: z.string(),
  /** The spawning tool_call record in the parent session. */
  atRecordId: z.string().optional(),
});

export type Invocation = z.infer<typeof InvocationSchema>;
