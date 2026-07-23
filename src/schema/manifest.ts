import { z } from "zod";
import { InvocationSchema, LineageSchema } from "./relation";
import { UsageSchema } from "./usage";

/**
 * Session-level manifest: one per session.
 * stats aggregates this session only (exclusive of child sessions);
 * cross-session aggregation is left to consumers walking the relation graph.
 */
export const ManifestSchema = z.object({
  /** Kept as-is (ULID / UUID / slug); not forced to UUID. */
  sessionId: z.string(),
  harness: z.string(),
  harnessVersion: z.string(),
  /** AHS spec version. */
  ahsVersion: z.string(),
  /** Agent profile declaration; omitted for harnesses without a profile mechanism. */
  profile: z.string().optional(),
  cwd: z.string(),
  workspaceRoots: z.array(z.string()).optional(),
  git: z
    .object({
      branch: z.string().optional(),
      commit: z.string().optional(),
      repoUrl: z.string().optional(),
    })
    .optional(),
  /** Primary model; mid-session switches are per-record overrides. */
  model: z.string(),
  provider: z.string().optional(),
  title: z.string().optional(),
  titleOrigin: z.enum(["generated", "custom"]).optional(),
  /** History-dimension back-link (fork source); see ADR-0005. */
  lineage: LineageSchema.optional(),
  /** Call-dimension back-link (invoking session); see ADR-0005. */
  invocation: InvocationSchema.optional(),
  /** Binding back to the native session for resumption via ACP. */
  acpBinding: z
    .object({
      agentId: z.string(),
      sessionId: z.string(),
    })
    .optional(),
  stats: z
    .object({
      totalUsage: UsageSchema.optional(),
      turnCount: z.number().int().nonnegative().optional(),
      durationMs: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
