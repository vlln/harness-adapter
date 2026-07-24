/**
 * Devin adapter — four-layer AC tests (see docs/plans/0009-linear-sessions).
 *
 * Fixture: programmatically generated SQLite (test/fixtures/devin-db.ts,
 * synthetic data only). Golden: test/fixtures/devin-golden.json (reviewed).
 * Model: ADR-0006 multi-branch sessions — forks/rewinds are intra-session
 * branches, not separate sessions. Only the base session manifest is listed;
 * branches are accessed via readRecords(sessionId, branchName).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DevinAdapter } from "../src/adapters/devin/index";
import { exportSessions } from "../src/ahs/writer";
import { renderReport } from "../examples/ahs-report";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import type { Usage } from "../src/schema/usage";
import type { Manifest } from "../src/schema/manifest";
import {
  checkIdempotency,
  collectSessions,
  stableSerialize,
  validateSessions,
  type SessionData,
} from "../src/validate/index";
import { BASE_TIP_NODE, createDevinFixture, ROOT40_TIP_NODE, T0 } from "./fixtures/devin-db";

let workDir: string;
let dbPath: string;
let adapter: DevinAdapter;
let sessions: SessionData[];

const iso = (offsetSec: number): string => new Date((T0 + offsetSec) * 1000).toISOString();

function session(id: string): SessionData {
  const found = sessions.find((s) => s.manifest.sessionId === id);
  if (found === undefined) throw new Error(`session missing from output: ${id}`);
  return found;
}

/** Read all records for a branch of a session via the adapter. */
async function readBranch(adapter: DevinAdapter, sessionId: string, branchName: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId, branchName)) records.push(rec);
  return records;
}

/** Read all branch records for a session (across all branches). */
async function readAllBranches(adapter: DevinAdapter, manifest: Manifest): Promise<AhsRecord[]> {
  const all: AhsRecord[] = [];
  for (const branchName of Object.keys(manifest.branches)) {
    for await (const rec of adapter.readRecords(manifest.sessionId, branchName)) {
      all.push(rec);
    }
  }
  return all;
}

function sumRecordUsage(records: AhsRecord[]): Usage {
  const total: Usage = {};
  for (const rec of records) {
    const u = rec.usage;
    if (u === undefined) continue;
    total.inputTokens = (total.inputTokens ?? 0) + (u.inputTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (u.outputTokens ?? 0);
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    total.durationMs = (total.durationMs ?? 0) + (u.durationMs ?? 0);
  }
  for (const key of Object.keys(total) as (keyof Usage)[]) {
    if (key !== "cost" && total[key] === 0) delete total[key];
  }
  return total;
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "devin-fixture-"));
  dbPath = createDevinFixture(workDir);
  adapter = new DevinAdapter(dbPath);
  sessions = await collectSessions(adapter);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("adapter shape", () => {
  it("declares harness and capabilities", () => {
    expect(adapter.harness).toBe("devin");
    expect(adapter.capabilities).toEqual({ history: "full", control: false });
  });

  it("lists only base session manifests (includeForks is a no-op)", async () => {
    const heads: string[] = [];
    for await (const m of adapter.listSessions()) heads.push(m.sessionId);
    expect(heads).toEqual(["odd-cove", "quiet-pond", "sunny-forest"]);

    // includeForks is a no-op in the multi-branch model — same output.
    const withForks: string[] = [];
    for await (const m of adapter.listSessions({ includeForks: true })) withForks.push(m.sessionId);
    expect(withForks).toEqual(["odd-cove", "quiet-pond", "sunny-forest"]);

    // collectSessions gathers only the listed manifests (HEAD-branch records).
    expect(sessions.map((s) => s.manifest.sessionId)).toEqual([
      "odd-cove",
      "quiet-pond",
      "sunny-forest",
    ]);
  });

  it("honors the harness filter", async () => {
    const listed: string[] = [];
    for await (const m of adapter.listSessions({ harness: "codex" })) listed.push(m.sessionId);
    expect(listed).toEqual([]);
    for await (const m of adapter.listSessions({ harness: "devin" })) listed.push(m.sessionId);
    expect(listed).toContain("sunny-forest");
  });

  it("honors the cwd filter", async () => {
    const listed: string[] = [];
    for await (const m of adapter.listSessions({ cwd: "/work/beta" })) {
      listed.push(m.sessionId);
    }
    expect(listed).toEqual(["quiet-pond"]);
  });

  it("rejects unknown session ids (fork IDs are now branch names, not session IDs)", async () => {
    await expect(async () => {
      for await (const _ of adapter.readRecords("no-such")) void _;
    }).rejects.toThrow(/session not found/);
    // Old fork session IDs are now branch names, not sessions.
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest#fork-16")) void _;
    }).rejects.toThrow(/session not found/);
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest#root-40")) void _;
    }).rejects.toThrow(/session not found/);
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest#root-999")) void _;
    }).rejects.toThrow(/session not found/);
    // The base session has no #root-0 alias.
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest#root-0")) void _;
    }).rejects.toThrow(/session not found/);
  });

  it("reads branch records via readRecords(sessionId, branchName)", async () => {
    // Read the fork-16 branch records (now branch "b002").
    const b002 = await readBranch(adapter, "sunny-forest", "b002");
    expect(b002.map((r) => r.recordId)).toEqual(["m-user-20", "m-asst-21"]);

    // Read the root-40 branch records (now branch "b004").
    const b004 = await readBranch(adapter, "sunny-forest", "b004");
    expect(b004.map((r) => r.recordId)).toEqual(["m-user-41", "m-asst-42"]);

    // Read the root-30 branch records (now branch "b003").
    const b003 = await readBranch(adapter, "sunny-forest", "b003");
    expect(b003.map((r) => r.recordId)).toEqual(["m-sys-30"]);

    // Read the root-50 branch records (now branch "b005").
    const b005 = await readBranch(adapter, "sunny-forest", "b005");
    expect(b005.map((r) => r.recordId)).toEqual(["m-asst-52"]);

    // Unknown branch name throws.
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest", "no-such-branch")) void _;
    }).rejects.toThrow(/branch not found/);
  });
});

describe("AC-0001: output is schema-valid (layer 1)", () => {
  it("AC-0001-N-1: every Manifest and record passes zod parse", () => {
    let recordCount = 0;
    for (const s of sessions) {
      expect(() => ManifestSchema.parse(s.manifest)).not.toThrow();
      for (const rec of s.records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
        recordCount += 1;
      }
    }
    // 3 sessions' HEAD-branch records:
    // sunny-forest (main): 16, quiet-pond: 1, odd-cove: 1
    expect(recordCount).toBe(18);
  });

  it("AC-0001-E-1: unmappable source content is dropped, output stays valid", () => {
    const base = session("sunny-forest");
    const ids = base.records.map((r) => r.recordId);
    // Unknown role, malformed JSON, empty assistant, duplicate tool result —
    // none of them produce records. The dead twin's message appears once.
    expect(ids).not.toContain("m-unk-9");
    expect(ids).not.toContain("m-asst-13");
    expect(ids).not.toContain("m-tool-7");
    expect(ids.filter((id) => id === "m-asst-2")).toHaveLength(1);
    for (const s of sessions) {
      ManifestSchema.parse(s.manifest);
      for (const rec of s.records) {
        // No schema-external fields leaked: parse + re-serialize round-trips.
        expect(AhsRecordSchema.parse(rec)).toEqual(rec);
      }
    }
  });
});

describe("AC-0002: output is complete (layer 2 invariants)", () => {
  it("AC-0002-N-1/N-2/N-6/N-7: validateSessions passes on the full output", () => {
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("AC-0002-N-1: every session is linear (seq contiguous from 0, first record is the root)", () => {
    for (const s of sessions) {
      expect(s.records.map((r) => r.seq)).toEqual(s.records.map((_, i) => i));
    }
    const base = session("sunny-forest");
    expect(base.records[0]).toMatchObject({ recordId: "m-sys-0", seq: 0 });
  });

  it("AC-0002-N-2: no invocation edges — Devin CLI has no subagent sessions (vacuous)", () => {
    for (const s of sessions) expect(s.manifest.invocation).toBeUndefined();
  });

  it("AC-0002-N-7: twin branch stays main, real fork produces a branch within the session", () => {
    // Dead twin (node 2): no branch — the shared message lives once in main.
    expect("b001" in session("sunny-forest").manifest.branches).toBe(false);

    // Real fork (old sunny-forest#fork-16) is now branch "b002" within sunny-forest.
    const sunny = session("sunny-forest").manifest;
    expect(sunny.branches).toHaveProperty("b002");
    expect(sunny.branches["b002"]).toEqual({
      parentBranch: "main",
      parentRecordId: "m-asst-15/tool_call/0",
    });
    // The branch suffix: user + assistant (ancestor-orphaned tool_result dropped).
  });

  it("AC-0002-N-7: cross-root branches anchor by message_id reconciliation", () => {
    const sunny = session("sunny-forest").manifest;

    // Root 40 (old sunny-forest#root-40) → branch "b004":
    // Shared system prefix → anchored at harness_message m-sys-0.
    expect(sunny.branches["b004"]).toEqual({
      parentBranch: "main",
      parentRecordId: "m-sys-0",
    });

    // Root 50 (old sunny-forest#root-50) → branch "b005":
    // Shared [system, user] prefix → anchored at user_message m-user-1.
    expect(sunny.branches["b005"]).toEqual({
      parentBranch: "main",
      parentRecordId: "m-user-1",
    });

    // Root 30 (old sunny-forest#root-30) → branch "b003":
    // Nothing shared → anchor-less (parentRecordId: null).
    expect(sunny.branches["b003"]).toEqual({
      parentBranch: "main",
      parentRecordId: null,
    });

    // The base session's main branch is the root (no parent).
    expect(sunny.branches["main"]).toEqual({
      parentBranch: null,
      parentRecordId: null,
    });
  });

  it("AC-0002-N-3: message counts match the source after dedup; text is verbatim", async () => {
    // Read all branches for sunny-forest to count across the full session.
    const sunnyRecords = await readAllBranches(adapter, session("sunny-forest").manifest);

    // Main branch (HEAD) user messages: m-user-1, m-user-10, m-user-12, m-user-18.
    const base = session("sunny-forest");
    const baseUserCount = base.records.filter((r) => r.type === "user_message").length;
    expect(baseUserCount).toBe(4);

    // Across all branches of sunny-forest, all 6 user messages are present.
    expect(sunnyRecords.filter((r) => r.type === "user_message")).toHaveLength(6);
    // Assistant messages: m-asst-2 (twins deduped), m-asst-8, m-asst-15, m-asst-21, m-asst-42, m-asst-52.
    expect(sunnyRecords.filter((r) => r.type === "assistant_message")).toHaveLength(6);

    const m2 = base.records.find((r) => r.recordId === "m-asst-2");
    expect(m2).toMatchObject({
      type: "assistant_message",
      content: [
        { type: "thinking", text: "Let me think." },
        { type: "text", text: "I'll inspect the file." },
      ],
      timestamp: iso(21), // the continuing twin (node 3), not the dead one
    });
    // system → harness_message; user with is_user_input=false → harness_message.
    expect(base.records.find((r) => r.recordId === "m-sys-0")?.type).toBe("harness_message");
    expect(base.records.find((r) => r.recordId === "m-harness-14")).toMatchObject({
      type: "harness_message",
      content: [{ type: "text", text: "<system-reminder>tick</system-reminder>" }],
    });
    // Tool result content verbatim.
    expect(base.records.find((r) => r.recordId === "m-tool-4")).toMatchObject({
      type: "tool_result",
      toolCallId: "tc-1",
      content: "file contents here",
    });
  });

  it("AC-0002-N-4: record-level usage reconciles with the source totals", () => {
    const base = session("sunny-forest");
    // Source metrics: m-asst-2 (100/20/177w/1500ms — twins carry the same
    // metrics, counted once) + m-asst-5 (50/10/800ms); cache_read null dropped.
    expect(sumRecordUsage(base.records)).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheWriteTokens: 177,
      durationMs: 2300,
    });
    // Tool-only assistant: usage rides on the first tool_call (not lost).
    expect(base.records.find((r) => r.recordId === "m-asst-5/tool_call/0")?.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      durationMs: 800,
    });
    // Manifest stats aggregate the main branch only; the group-level credit
    // cost rides on the base session (winner-independent, B-4).
    expect(base.manifest.stats).toEqual({
      turnCount: 4,
      totalUsage: {
        inputTokens: 150,
        outputTokens: 30,
        cacheWriteTokens: 177,
        durationMs: 2300,
        cost: { amount: 7, currency: "credit" },
      },
      durationMs: 3600000,
    });
    // The credit cost is on the base session's manifest; branches have no separate manifests.
    expect(base.manifest.stats?.totalUsage?.cost).toEqual({ amount: 7, currency: "credit" });
  });

  it("AC-0002-N-5: two runs are byte-identical", async () => {
    expect(await checkIdempotency(adapter)).toEqual([]);
  });

  it("AC-0002-N-6: tool pairing XOR holds; duplicate result keeps chain-first", () => {
    const base = session("sunny-forest");
    const calls = base.records.filter((r) => r.type === "tool_call");
    expect(calls.map((r) => [r.toolCallId, r.status])).toEqual([
      ["tc-1", "completed"],
      ["tc-2", "completed"],
      ["tc-3", "interrupted"],
      ["tc-4", "completed"],
    ]);
    const resultsForTc2 = base.records.filter(
      (r) => r.type === "tool_result" && r.toolCallId === "tc-2",
    );
    expect(resultsForTc2).toHaveLength(1);
    expect(resultsForTc2[0]).toMatchObject({ recordId: "m-tool-6", content: "ok" });
  });

  it("AC-0002-B-1: interrupted tool_call gets no synthetic tool_result", () => {
    const base = session("sunny-forest");
    expect(base.records.some((r) => r.type === "tool_result" && r.toolCallId === "tc-3")).toBe(
      false,
    );
  });

  it("AC-0002-B-2: source without usage yields no usage fields; existing usage kept", () => {
    const quiet = session("quiet-pond");
    expect(quiet.records.every((r) => r.usage === undefined)).toBe(true);
    expect(quiet.manifest.stats?.totalUsage).toBeUndefined();
    // odd-cove: invalid metadata JSON → no cost, adapter does not crash.
    expect(session("odd-cove").manifest.stats?.totalUsage).toBeUndefined();
  });

  it("AC-0002-B-4: winner flip moves only the HEAD branch, never the session set", async () => {
    const dirA = await mkdtemp(path.join(tmpdir(), "devin-b4-a-"));
    const dirB = await mkdtemp(path.join(tmpdir(), "devin-b4-b-"));
    try {
      const adapterA = new DevinAdapter(createDevinFixture(dirA, BASE_TIP_NODE));
      const adapterB = new DevinAdapter(createDevinFixture(dirB, ROOT40_TIP_NODE));

      // Session IDs are the same regardless of winner.
      const idsA: string[] = [];
      for await (const m of adapterA.listSessions()) idsA.push(m.sessionId);
      const idsB: string[] = [];
      for await (const m of adapterB.listSessions()) idsB.push(m.sessionId);
      expect(idsA).toEqual(["odd-cove", "quiet-pond", "sunny-forest"]);
      expect(idsB).toEqual(["odd-cove", "quiet-pond", "sunny-forest"]);

      // The manifests are identical except for HEAD.branch and HEAD.recordId.
      const manifestsA = new Map<string, Manifest>();
      for await (const m of adapterA.listSessions()) manifestsA.set(m.sessionId, m);
      const manifestsB = new Map<string, Manifest>();
      for await (const m of adapterB.listSessions()) manifestsB.set(m.sessionId, m);

      // odd-cove and quiet-pond are identical.
      expect(manifestsA.get("odd-cove")).toEqual(manifestsB.get("odd-cove"));
      expect(manifestsA.get("quiet-pond")).toEqual(manifestsB.get("quiet-pond"));

      // sunny-forest: only HEAD differs.
      const sfA = manifestsA.get("sunny-forest")!;
      const sfB = manifestsB.get("sunny-forest")!;
      expect(sfA.HEAD.branch).toBe("main");
      expect(sfB.HEAD.branch).toBe("b004");
      // HEAD.recordId is from the main branch records (winner-independent) — same.
      expect(sfA.HEAD.recordId).toBe("m-user-18");
      expect(sfB.HEAD.recordId).toBe("m-user-18");
      // Branches are identical.
      expect(sfA.branches).toEqual(sfB.branches);
      // Stats are from main branch records — same.
      expect(sfA.stats).toEqual(sfB.stats);

      // collectSessions reads HEAD-branch records, so the records differ.
      const setA = await collectSessions(adapterA);
      const setB = await collectSessions(adapterB);
      const sfRecordsA = setA.find((s) => s.manifest.sessionId === "sunny-forest")!.records;
      const sfRecordsB = setB.find((s) => s.manifest.sessionId === "sunny-forest")!.records;
      expect(sfRecordsA.map((r) => r.recordId)).not.toEqual(sfRecordsB.map((r) => r.recordId));
      // adapterA reads main branch, adapterB reads b004 branch.
      expect(sfRecordsA[0]?.recordId).toBe("m-sys-0");
      expect(sfRecordsB[0]?.recordId).toBe("m-user-41");
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });
});

describe("AC-0003: output is faithful (layer 3 golden)", () => {
  it("AC-0003-N-1: full output matches the reviewed golden file", async () => {
    const goldenPath = path.join(import.meta.dirname, "fixtures", "devin-golden.json");
    const golden = await readFile(goldenPath, "utf8");
    expect(stableSerialize(sessions)).toBe(golden.trimEnd());
  });
});

describe("AC-0004: output is usable (layer 4 archive + consumer)", () => {
  it("AC-0004-N-1: archive round-trips and ahs-report aggregates tokens", async () => {
    const archiveDir = await mkdtemp(path.join(tmpdir(), "devin-archive-"));
    try {
      // includeForks is a no-op in ADR-0006 — only base sessions are written.
      const written = await exportSessions(adapter, archiveDir, { includeForks: true });
      expect(written.map((w) => w.sessionId).sort()).toEqual(
        ["odd-cove", "quiet-pond", "sunny-forest"].sort(),
      );

      // Render the base session. In the multi-branch model, headSessionId is the
      // session ID itself (branching is intra-session). The HEAD chain is just
      // the main branch (root branch, no parent) — no stitching annotation.
      const report = await renderReport(archiveDir, "sunny-forest");
      expect(report.headSessionId).toBe("sunny-forest");
      expect(report.text).toContain(
        "# sunny-forest [devin · claude-test-medium] — Alpha Refactor",
      );
      expect(report.text).toContain("[user] Refactor the parser.");
      // The main branch has usage (m-asst-2, m-asst-5).
      expect(report.aggregatedSessions).toEqual(["sunny-forest"]);
      expect(report.totalUsage).toMatchObject({ inputTokens: 150, outputTokens: 30 });

      // Old fork session IDs are not in the archive.
      await expect(renderReport(archiveDir, "sunny-forest#root-40")).rejects.toThrow(
        /session not in archive/,
      );

      // --all lists the session's branches as alternate versions.
      const allReport = await renderReport(archiveDir, "sunny-forest", { all: true });
      expect(allReport.headSessionId).toBe("sunny-forest");
      // Alternates are the branch names.
      expect(allReport.alternates.sort()).toEqual(
        ["b002", "b003", "b004", "b005", "main"].sort(),
      );
      expect(allReport.text).toContain("== alternate versions (session sunny-forest) ==");
      expect(allReport.text).toContain("b004");
      expect(allReport.text).toContain("b002");
      expect(allReport.text).toContain("b003");
      expect(allReport.text).toContain("b005");
    } finally {
      await rm(archiveDir, { recursive: true, force: true });
    }
  });
});

describe("manifest mapping", () => {
  it("maps session fields; titleOrigin custom; harnessVersion unknown", () => {
    const base = session("sunny-forest").manifest;
    expect(base).toMatchObject({
      harness: "devin",
      harnessVersion: "unknown",
      cwd: "/work/alpha",
      model: "claude-test-medium",
      title: "Alpha Refactor",
      titleOrigin: "custom",
    });
    // quiet-pond: no title, zero-duration session.
    const quiet = session("quiet-pond").manifest;
    expect(quiet.title).toBeUndefined();
    expect(quiet.titleOrigin).toBeUndefined();
    expect(quiet.stats).toEqual({ turnCount: 1, durationMs: 0 });
    // odd-cove: node without message_id → recordId node-<id> fallback.
    expect(session("odd-cove").records[0]).toMatchObject({
      recordId: "node-0",
      type: "user_message",
    });
  });

  it("manifest has branches and HEAD (ADR-0006 multi-branch model)", () => {
    const sunny = session("sunny-forest").manifest;
    expect(sunny.branches).toBeDefined();
    expect(sunny.HEAD).toBeDefined();
    expect(sunny.HEAD.branch).toBe("main");
    expect(sunny.HEAD.recordId).toBe("m-user-18");
    // "main" is always present as a root branch.
    expect(sunny.branches["main"]).toEqual({
      parentBranch: null,
      parentRecordId: null,
    });
    // All branches point to "main" as parent.
    for (const [name, def] of Object.entries(sunny.branches)) {
      if (name === "main") continue;
      expect(def.parentBranch).toBe("main");
    }
    // lineage is not present on the base session manifest (it's optional metadata).
    // The branch definitions carry the fork-point information via parentRecordId.
  });
});