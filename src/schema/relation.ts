import { z } from "zod";

/**
 * The two orthogonal relation dimensions between sessions (ADR-0005).
 * Both live on the child session's Manifest as optional back-links;
 * cross-session references are addressed by recordId.
 */

/**
 * lineage (history dimension) — "where my history comes from".
 * - forked_from: full copy, independent root. The lineage is metadata only
 *   ("I was copied from X"). The fork carries its own complete history;
 *   root === true.
 * - rewound_from: shared prefix, depends on source. The lineage is a
 *   structural dependency — the session's history is incomplete without
 *   walking lineage back to the ancestor. root === false.
 *   sibling_attempt (re-answer to the same prompt) is no longer a separate
 *   type — it is a rewound_from anchored at a user_message.
 * atRecordId is tri-state (ADR-0005 amendment): a value = anchored;
 * null = the anchor should exist but is source-unavailable (e.g. the
 * ancestor file is missing); absent = retry from the very start (the fork
 * carries its own prompt copy). The anchor type (user_message /
 * assistant_message / harness_message) is expressed by the record itself,
 * not by the lineage type.
 */
export const LineageSchema = z.object({
  type: z.enum(["forked_from", "rewound_from"]),
  /** Parent/source session id. */
  sessionId: z.string(),
  /** Anchor record in the parent session the fork diverges after. */
  atRecordId: z.string().nullable().optional(),
});

export type Lineage = z.infer<typeof LineageSchema>;

/**
 * invocation (call dimension) — "who invoked/created me". The forward link
 * lives in the parent session's history as tool_result.sessionIds; this is
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
