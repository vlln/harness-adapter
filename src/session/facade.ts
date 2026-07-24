import type { Manifest } from "../schema/manifest";
import type { AhsRecord } from "../schema/record";
import type { Usage } from "../schema/usage";
import type { HarnessAdapter, SessionFilter } from "../store/adapter";
import { ClaudeCodeAdapter } from "../adapters/claude-code/index";
import { CodexAdapter } from "../adapters/codex/index";
import { KimiCodeAdapter } from "../adapters/kimi-code/index";
import { DevinAdapter } from "../adapters/devin/index";
import type {
  AhsSession,
  AhsTask,
  ConversationItem,
  HarnessFacade,
  StateEvent,
} from "./types";

/**
 * Session Facade (interface-0003): langchain-style consumer API over the
 * streaming HarnessAdapter substrate. The facade materializes sessions in
 * memory and projects them; the underlying interface is unchanged (bulk
 * processing of large sessions should still go through readRecords).
 *
 * ADR-0006: Session = directory with multiple branches. The facade:
 * - loadSession: materializes all branches, projects HEAD branch.
 * - loadTask: stitches the HEAD chain (HEAD branch → parentBranch → root).
 * - childrenOf: unchanged (invocation back-links from manifests).
 *
 * Everything here depends ONLY on the substrate's contract data (Manifest
 * + records + invocation dimension) — never on native storage.
 */

/** Thrown by loadSession/loadTask for an id the store does not list. */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

const STATE_TYPES = new Set(["turn_boundary", "model_change", "compaction", "goal_update"]);

/**
 * record → ConversationItem projection (interface-0003 mapping table).
 * Tool pairing is done HERE: each tool_call pairs with its tool_result
 * (first in file order, per AC-0002-N-6); an interrupted call has no paired
 * result, so its tool item carries none (XOR). Unpaired tool_results are
 * dropped defensively (N-6 forbids them). State records go to events().
 */
export function projectMessages(records: AhsRecord[]): ConversationItem[] {
  const resultByCallId = new Map<string, Extract<AhsRecord, { type: "tool_result" }>>();
  for (const rec of records) {
    if (rec.type === "tool_result" && !resultByCallId.has(rec.toolCallId)) {
      resultByCallId.set(rec.toolCallId, rec);
    }
  }
  const items: ConversationItem[] = [];
  for (const rec of records) {
    switch (rec.type) {
      case "user_message":
        items.push({ kind: "user", content: rec.content, timestamp: rec.timestamp });
        break;
      case "assistant_message":
        items.push({ kind: "assistant", content: rec.content, timestamp: rec.timestamp });
        break;
      case "harness_message":
        items.push({ kind: "harness", content: rec.content, timestamp: rec.timestamp });
        break;
      case "tool_call": {
        const result = resultByCallId.get(rec.toolCallId);
        items.push({
          kind: "tool",
          call: { name: rec.name, args: rec.args },
          ...(result !== undefined
            ? {
                result: {
                  content: result.content,
                  ...(result.status !== undefined ? { status: result.status } : {}),
                },
              }
            : {}),
          ...(rec.status !== undefined ? { status: rec.status } : {}),
          ...(result?.sessionIds !== undefined ? { sessionIds: result.sessionIds } : {}),
          timestamp: rec.timestamp,
        });
        break;
      }
      default:
        // tool_result: folded into its tool item. State records: events().
        break;
    }
  }
  return items;
}

function stateEvents(records: AhsRecord[]): StateEvent[] {
  return records.filter((r) => STATE_TYPES.has(r.type)) as StateEvent[];
}

/**
 * Sum record-level usage. Cost is summed per currency; a single Usage can
 * carry only one currency, so with mixed currencies (never observed) the
 * lexicographically first currency's total is kept.
 */
function sumUsage(records: AhsRecord[]): Usage {
  const total: Usage = {};
  const costs = new Map<string, number>();
  for (const rec of records) {
    const u = rec.usage;
    if (u === undefined) continue;
    total.inputTokens = (total.inputTokens ?? 0) + (u.inputTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (u.outputTokens ?? 0);
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    total.reasoningTokens = (total.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0);
    if (u.durationMs !== undefined) total.durationMs = (total.durationMs ?? 0) + u.durationMs;
    if (u.cost !== undefined) {
      costs.set(u.cost.currency, (costs.get(u.cost.currency) ?? 0) + u.cost.amount);
    }
  }
  const first = [...costs.keys()].sort()[0];
  if (first !== undefined) total.cost = { amount: costs.get(first)!, currency: first };
  return total;
}

interface MaterializedSession {
  manifest: Manifest;
  branchRecords: Map<string, AhsRecord[]>;
}

class SessionView implements AhsSession {
  constructor(
    private readonly facade: FacadeImpl,
    private readonly session: MaterializedSession,
  ) {}

  get manifest(): Manifest {
    return this.session.manifest;
  }

  messages(): ConversationItem[] {
    const headBranch = this.session.manifest.HEAD.branch;
    const records = this.session.branchRecords.get(headBranch) ?? [];
    return projectMessages(records);
  }

  events(): StateEvent[] {
    const headBranch = this.session.manifest.HEAD.branch;
    const records = this.session.branchRecords.get(headBranch) ?? [];
    return stateEvents(records);
  }

  get usage(): Usage {
    const headBranch = this.session.manifest.HEAD.branch;
    const records = this.session.branchRecords.get(headBranch) ?? [];
    return sumUsage(records);
  }

  async children(): Promise<AhsSession[]> {
    return this.facade.childrenOf(this.session);
  }
}

class TaskView implements AhsTask {
  constructor(
    readonly sessionId: string,
    readonly head: AhsSession,
    readonly branches: string[],
    private readonly stitched: ConversationItem[],
  ) {}

  messages(): ConversationItem[] {
    return this.stitched;
  }
}

class FacadeImpl implements HarnessFacade {
  constructor(readonly adapter: HarnessAdapter) {}

  listSessions(filter?: SessionFilter): AsyncIterable<Manifest> {
    return this.adapter.listSessions(filter);
  }

  /** All manifests in the store, fork descendants included. */
  private async allManifests(): Promise<Manifest[]> {
    const manifests: Manifest[] = [];
    for await (const manifest of this.adapter.listSessions({ includeForks: true })) {
      manifests.push(manifest);
    }
    return manifests;
  }

  private async materialize(manifest: Manifest): Promise<MaterializedSession> {
    const branchRecords = new Map<string, AhsRecord[]>();
    for (const branchName of Object.keys(manifest.branches)) {
      const records: AhsRecord[] = [];
      for await (const rec of this.adapter.readRecords(manifest.sessionId, branchName)) {
        records.push(rec);
      }
      branchRecords.set(branchName, records);
    }
    return { manifest, branchRecords };
  }

  async loadSession(sessionId: string): Promise<AhsSession> {
    let manifest: Manifest;
    try {
      manifest = await this.adapter.readManifest(sessionId);
    } catch {
      throw new SessionNotFoundError(sessionId);
    }
    return new SessionView(this, await this.materialize(manifest));
  }

  /**
   * Direct invocation children (interface-0003): sessions whose invocation
   * back-link points here, plus targets of this session's tool_result
   * sessionIds forward links. Children not discoverable in this store
   * (not exported / another harness) are skipped silently.
   */
  async childrenOf(session: MaterializedSession): Promise<AhsSession[]> {
    const manifests = await this.allManifests();
    const byId = new Map(manifests.map((m) => [m.sessionId, m]));
    const childIds = new Set<string>();
    for (const m of manifests) {
      if (m.invocation?.sessionId === session.manifest.sessionId) childIds.add(m.sessionId);
    }
    // Forward links from HEAD branch records.
    const headBranch = session.manifest.HEAD.branch;
    const headRecords = session.branchRecords.get(headBranch) ?? [];
    for (const rec of headRecords) {
      if (rec.type !== "tool_result" || rec.sessionIds === undefined) continue;
      for (const id of rec.sessionIds) childIds.add(id);
    }
    childIds.delete(session.manifest.sessionId);
    const children: AhsSession[] = [];
    for (const id of [...childIds].sort()) {
      const manifest = byId.get(id);
      if (manifest === undefined) continue; // undiscoverable — skip, no error
      try {
        children.push(new SessionView(this, await this.materialize(manifest)));
      } catch {
        // Undiscoverable in practice (listed but unreadable) — same skip rule.
        continue;
      }
    }
    return children;
  }

  /**
   * User view (interface-0003): intra-session HEAD chain stitching
   * (ADR-0006). Walk from HEAD branch back through parentBranch to the
   * root branch, cutting at each segment's parentRecordId.
   */
  async loadTask(sessionId: string): Promise<AhsTask> {
    let manifest: Manifest;
    try {
      manifest = await this.adapter.readManifest(sessionId);
    } catch {
      throw new SessionNotFoundError(sessionId);
    }

    const session = await this.materialize(manifest);

    // Walk the HEAD chain: HEAD branch → parentBranch → ... → root branch.
    // Build oldest-first.
    const chain: { branchName: string; records: AhsRecord[] }[] = [];
    const seen = new Set<string>();
    let curBranch: string | null = session.manifest.HEAD.branch;
    while (curBranch !== null && !seen.has(curBranch)) {
      seen.add(curBranch);
      const branchDef: Manifest["branches"][string] | undefined = session.manifest.branches[curBranch];
      const records = session.branchRecords.get(curBranch) ?? [];
      chain.unshift({ branchName: curBranch, records });
      curBranch = branchDef?.parentBranch ?? null;
    }

    // Stitch: each segment cut at the next segment's parentRecordId
    // (inclusive). null parentRecordId = full parent slice.
    const stitched: ConversationItem[] = [];
    for (let i = 0; i < chain.length; i += 1) {
      const segment = chain[i]!;
      let end = segment.records.length;
      if (i + 1 < chain.length) {
        const nextBranchName = chain[i + 1]!.branchName;
        const nextBranchDef = session.manifest.branches[nextBranchName];
        const parentRecordId = nextBranchDef?.parentRecordId;
        if (parentRecordId !== null) {
          const idx = segment.records.findIndex((r) => r.recordId === parentRecordId);
          end = idx >= 0 ? idx + 1 : segment.records.length;
        }
        // null parentRecordId: keep full parent slice (start from beginning).
      }
      stitched.push(...projectMessages(segment.records.slice(0, end)));
    }

    const headView = new SessionView(this, session);
    const branches = Object.keys(session.manifest.branches).sort();
    return new TaskView(sessionId, headView, branches, stitched);
  }
}

/** Create a facade over any HarnessAdapter (test seam; openHarness for the registry). */
export function createFacade(adapter: HarnessAdapter): HarnessFacade {
  return new FacadeImpl(adapter);
}

const REGISTRY = {
  "claude-code": (basePath?: string) => new ClaudeCodeAdapter(basePath),
  codex: (basePath?: string) => new CodexAdapter(basePath),
  "kimi-code": (basePath?: string) => new KimiCodeAdapter(basePath),
  devin: (basePath?: string) => new DevinAdapter(basePath),
} as const;

export type HarnessName = keyof typeof REGISTRY;

/** Open one of the four registered harnesses (interface-0003 entry point). */
export function openHarness(name: HarnessName, options?: { basePath?: string }): HarnessFacade {
  const make = REGISTRY[name];
  if (make === undefined) throw new Error(`unknown harness: ${String(name)}`);
  return createFacade(make(options?.basePath));
}