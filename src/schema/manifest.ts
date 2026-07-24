import { z } from "zod";
import { InvocationSchema, LineageSchema } from "./relation";
import { UsageSchema } from "./usage";

/** Branch descriptor within a session (ADR-0006). */
export const BranchSchema = z.object({
  /** Parent branch name; null = root branch (no parent). */
  parentBranch: z.string().nullable(),
  /** Fork point in the parent branch's records; null = from the start of the branch. */
  parentRecordId: z.string().nullable(),
});

export type Branch = z.infer<typeof BranchSchema>;

/** HEAD pointer: the current active node in the session tree. */
export const HeadSchema = z.object({
  branch: z.string(),
  /** recordId of the current leaf; null = branch has no records yet. */
  recordId: z.string().nullable(),
});

export type Head = z.infer<typeof HeadSchema>;

/**
 * Session-level manifest: one per session directory (ADR-0006).
 *
 * A session contains one or more branches (rewind/retry = intra-session
 * branch; fork = new session directory). stats aggregates all branches.
 */
export const ManifestSchema = z.object({
  sessionId: z.string(),
  harness: z.string(),
  harnessVersion: z.string(),
  ahsVersion: z.string(),
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
  model: z.string(),
  provider: z.string().optional(),
  title: z.string().optional(),
  titleOrigin: z.enum(["generated", "custom"]).optional(),
  /** Reasoning depth (session-level config; mid-session switches are per-record). */
  thinking: z.string().optional(),
  /** Branch registry. "main" is always present. */
  branches: z.record(z.string(), BranchSchema),
  /** Current active node. */
  HEAD: HeadSchema,
  /** Fork source metadata (optional; omitted when the harness records no source). */
  lineage: LineageSchema.optional(),
  /** Call-dimension back-link (subagent). */
  invocation: InvocationSchema.optional(),
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