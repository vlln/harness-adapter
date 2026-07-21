import { z } from "zod";

/**
 * Coarse-grained usage totals, per the AHS draft.
 * Optional at record level; aggregated in Manifest.stats.
 */
export const UsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  /** Only a few harnesses report cost. */
  cost: z
    .object({
      amount: z.number(),
      currency: z.string(),
    })
    .optional(),
  durationMs: z.number().nonnegative().optional(),
});

export type Usage = z.infer<typeof UsageSchema>;
