import { z } from "zod";

/**
 * Reference to an out-of-line, content-addressed blob.
 * Large tool outputs (above the blob threshold, tentatively 64 KiB) are
 * externalized instead of inlined.
 */
export const BlobRefSchema = z.object({
  type: z.literal("blob_ref"),
  sha256: z.string(),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative(),
  /** Short inline excerpt for display without fetching the blob. */
  preview: z.string().optional(),
});

export type BlobRef = z.infer<typeof BlobRefSchema>;
