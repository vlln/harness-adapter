import type { Manifest } from "../schema/manifest";
import type { AhsRecord } from "../schema/record";

/** Filter criteria for listing sessions. Minimal for now. */
export interface SessionFilter {
  harness?: string;
  cwd?: string;
  /** Include fork sessions (lineage descendants). Default false: only root sessions. */
  includeForks?: boolean;
}

/**
 * Read-only projection from a harness's native storage to AHS.
 *
 * Adapters are pure projections: they read native history
 * (~/.claude/, ~/.codex/, ...) and expose it as AHS sessions + records.
 * They never write back to native storage and never attempt lossless
 * round-tripping — AHS is a consumption format, not a backup format.
 */
export interface HarnessAdapter {
  /** Harness identifier, e.g. "claude-code", "codex", "kimi". */
  readonly harness: string;

  readonly capabilities: {
    /** "none" when the source has no accessible session data (e.g. cloud-only). */
    history: "full" | "partial" | "none";
    /** Whether the adapter can control sessions (start/stop) — usually false. */
    control: boolean;
  };

  listSessions(filter?: SessionFilter): AsyncIterable<Manifest>;

  /**
   * Read the Manifest for a single session by ID — direct lookup,
   * no listSessions scan. Throws when sessionId does not exist (consistent
   * with readRecords error semantics).
   */
  readManifest(sessionId: string): Promise<Manifest>;

  /**
   * Read records for a session branch. Defaults to the HEAD branch when
   * branchName is omitted. Records are returned in file (JSONL line) order
   * within the branch.
   */
  readRecords(sessionId: string, branchName?: string): AsyncIterable<AhsRecord>;
}