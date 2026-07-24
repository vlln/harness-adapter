import { z } from "zod";

/**
 * Cross-session relations (ADR-0006).
 *
 * - lineage: metadata-only fork source ("I was copied from X"). Rewind is no
 *   longer a cross-session operation — it is expressed as intra-session
 *   branches (see Manifest.branches).
 * - invocation: call-dimension back-link ("who invoked/created me").
 */

/**
 * Forked-from lineage: metadata only. The fork carries its own complete
 * history; the source session is informational, not a structural dependency.
 * Omitted when the source harness records no fork source.
 */
export const LineageSchema = z.object({
  type: z.literal("forked_from"),
  sessionId: z.string(),
  atRecordId: z.string().nullable().optional(),
});

export type Lineage = z.infer<typeof LineageSchema>;

/**
 * Invocation (call dimension) — "who invoked/created me". The forward link
 * lives in the parent session's history as tool_result.sessionIds; this is
 * the session-level back-link, reconciled against the forward link by
 * AC-0002-N-2. atRecordId omitted when the source harness only has an
 * agent-level parent link (AC-0002-B-3, e.g. Kimi).
 */
export const InvocationSchema = z.object({
  sessionId: z.string(),
  atRecordId: z.string().optional(),
});

export type Invocation = z.infer<typeof InvocationSchema>;