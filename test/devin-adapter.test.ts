/**
 * Devin adapter — four-layer AC tests (see docs/plans/0009-linear-sessions).
 *
 * Fixture: programmatically generated SQLite (test/fixtures/devin-db.ts,
 * synthetic data only). Golden: test/fixtures/devin-golden.json (reviewed).
 * Model: ADR-0005 linear sessions + fork synthesis (per-root sessions,
 * twin-branch skip, shared-prefix lineage anchors, group HEAD pointer).
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

  it("lists group HEADs only by default; includeForks lists every session", async () => {
    const heads: string[] = [];
    for await (const m of adapter.listSessions()) heads.push(m.sessionId);
    expect(heads).toEqual(["odd-cove", "quiet-pond", "sunny-forest"]);
    // Full set: same groups, with every lineage descendant.
    expect(sessions.map((s) => s.manifest.sessionId)).toEqual([
      "odd-cove",
      "quiet-pond",
      "sunny-forest",
      "sunny-forest#fork-16",
      "sunny-forest#root-30",
      "sunny-forest#root-40",
      "sunny-forest#root-50",
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
    for await (const m of adapter.listSessions({ cwd: "/work/beta", includeForks: true })) {
      listed.push(m.sessionId);
    }
    expect(listed).toEqual(["quiet-pond"]);
  });

  it("rejects unknown session ids (incl. unknown fork/root forms)", async () => {
    await expect(async () => {
      for await (const _ of adapter.readRecords("no-such")) void _;
    }).rejects.toThrow(/session not found/);
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest#root-999")) void _;
    }).rejects.toThrow(/session not found/);
    // The dead twin produces no fork session.
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest#fork-2")) void _;
    }).rejects.toThrow(/session not found/);
    // The base session has no #root-0 alias anymore.
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest#root-0")) void _;
    }).rejects.toThrow(/session not found/);
  });

  it("reads every session's own linear records", async () => {
    const fork: AhsRecord[] = [];
    for await (const rec of adapter.readRecords("sunny-forest#fork-16")) fork.push(rec);
    expect(fork.map((r) => r.recordId)).toEqual(["m-user-20", "m-asst-21"]);
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
    expect(recordCount).toBe(24);
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

  it("AC-0002-N-7: twin branch stays main, real fork splits with forked_from anchor", () => {
    // Dead twin: no session; the shared message lives once in the base.
    expect(sessions.some((s) => s.manifest.sessionId === "sunny-forest#fork-2")).toBe(false);
    const fork = session("sunny-forest#fork-16");
    expect(fork.manifest.lineage).toEqual({
      type: "forked_from",
      sessionId: "sunny-forest",
      atRecordId: "m-asst-15/tool_call/0",
    });
    // Suffix-only: the twin message and the ancestor-orphaned tool_result
    // are not stored in the fork.
    expect(fork.records.map((r) => r.recordId)).toEqual(["m-user-20", "m-asst-21"]);
  });

  it("AC-0002-N-7: cross-root lineage anchors by message_id reconciliation + type judgment", () => {
    // Shared system prefix → harness_message anchor → forked_from.
    expect(session("sunny-forest#root-40").manifest.lineage).toEqual({
      type: "forked_from",
      sessionId: "sunny-forest",
      atRecordId: "m-sys-0",
    });
    expect(session("sunny-forest#root-40").records.map((r) => r.recordId)).toEqual([
      "m-user-41",
      "m-asst-42",
    ]);
    // Shared [system, user] prefix → user_message anchor → sibling_attempt.
    expect(session("sunny-forest#root-50").manifest.lineage).toEqual({
      type: "sibling_attempt",
      sessionId: "sunny-forest",
      atRecordId: "m-user-1",
    });
    expect(session("sunny-forest#root-50").records.map((r) => r.recordId)).toEqual(["m-asst-52"]);
    // Nothing shared → anchor-less retry from start.
    expect(session("sunny-forest#root-30").manifest.lineage).toEqual({
      type: "sibling_attempt",
      sessionId: "sunny-forest",
    });
    expect(session("sunny-forest#root-30").records.map((r) => r.recordId)).toEqual(["m-sys-30"]);
    // The base session carries no lineage.
    expect(session("sunny-forest").manifest.lineage).toBeUndefined();
  });

  it("AC-0002-N-3: message counts match the source after dedup; text is verbatim", () => {
    const group = sessions.filter((s) => s.manifest.sessionId.startsWith("sunny-forest"));
    // Distinct user-role messages in the source group: m-user-1 (+copy),
    // m-user-10, m-user-12, m-user-18, m-user-20, m-user-41 (+ m-harness-14
    // routed to harness_message); assistant: m-asst-2 (twins deduped),
    // m-asst-8, m-asst-15, m-asst-21, m-asst-42, m-asst-52.
    expect(group.flatMap((s) => s.records).filter((r) => r.type === "user_message")).toHaveLength(6);
    expect(
      group.flatMap((s) => s.records).filter((r) => r.type === "assistant_message"),
    ).toHaveLength(6);
    const base = session("sunny-forest");
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
    // Manifest stats aggregate this session only; the group-level credit
    // cost rides on the BASE session (winner-independent, B-4).
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
    // Fork sessions carry no cost (no per-chain attribution).
    for (const id of ["sunny-forest#fork-16", "sunny-forest#root-40"]) {
      expect(session(id).manifest.stats?.totalUsage?.cost).toBeUndefined();
    }
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

  it("AC-0002-B-4: winner flip moves only the derived HEAD, never the session set", async () => {
    const dirA = await mkdtemp(path.join(tmpdir(), "devin-b4-a-"));
    const dirB = await mkdtemp(path.join(tmpdir(), "devin-b4-b-"));
    try {
      const adapterA = new DevinAdapter(createDevinFixture(dirA, BASE_TIP_NODE));
      const adapterB = new DevinAdapter(createDevinFixture(dirB, ROOT40_TIP_NODE));
      const setA = stableSerialize(await collectSessions(adapterA));
      const setB = stableSerialize(await collectSessions(adapterB));
      expect(setA).toBe(setB);
      const headsOf = async (a: DevinAdapter): Promise<string[]> => {
        const ids: string[] = [];
        for await (const m of a.listSessions()) ids.push(m.sessionId);
        return ids;
      };
      expect(await headsOf(adapterA)).toEqual(["odd-cove", "quiet-pond", "sunny-forest"]);
      expect(await headsOf(adapterB)).toEqual([
        "odd-cove",
        "quiet-pond",
        "sunny-forest#root-40",
      ]);
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
      const written = await exportSessions(adapter, archiveDir, { includeForks: true });
      expect(written.map((w) => w.sessionId).sort()).toEqual(
        [
          "odd-cove",
          "quiet-pond",
          "sunny-forest",
          "sunny-forest#fork-16",
          "sunny-forest#root-30",
          "sunny-forest#root-40",
          "sunny-forest#root-50",
        ].sort(),
      );

      const report = await renderReport(archiveDir, "sunny-forest");
      // Task view (ADR-0005 §5): the group's HEAD by the recency heuristic
      // is sunny-forest#root-50 (latest record); the transcript is the HEAD
      // chain — sunny-forest's records up to the lineage anchor (system
      // prompt + first user message) stitched with root-50's suffix.
      expect(report.headSessionId).toBe("sunny-forest#root-50");
      expect(report.text).toContain(
        "# sunny-forest [devin · claude-test-medium] — Alpha Refactor (shared prefix, stitched)",
      );
      expect(report.text).toContain("[user] Refactor the parser.");
      expect(report.text).toContain("# sunny-forest#root-50 [devin · claude-test-medium]");
      expect(report.text).toContain("Different answer to the same prompt.");
      // Folded alternates (and the abandoned tail past the anchor) are NOT
      // stitched into the default view.
      expect(report.text).not.toContain("sunny-forest#fork-16");
      expect(report.text).not.toContain("sunny-forest#root-40");
      expect(report.text).not.toContain("file contents here");
      // Aggregation is over the rendered slices only; the metrics records
      // (m-asst-2, tc-2) live past the anchor in the folded alternate, so
      // the HEAD chain itself carries no usage (all-zero totals).
      expect(report.aggregatedSessions).toEqual(["sunny-forest", "sunny-forest#root-50"]);
      expect(report.totalUsage).toMatchObject({ inputTokens: 0, outputTokens: 0 });

      // Fork sessions are archived under sanitized, resolvable dir names:
      // invoking with any group member resolves the same group + HEAD, and
      // --all lists the folded forks as alternate versions.
      const forkReport = await renderReport(archiveDir, "sunny-forest#root-40", { all: true });
      expect(forkReport.headSessionId).toBe("sunny-forest#root-50");
      expect(forkReport.alternates).toEqual([
        "sunny-forest",
        "sunny-forest#fork-16",
        "sunny-forest#root-30",
        "sunny-forest#root-40",
        "sunny-forest#root-50",
      ]);
      expect(forkReport.text).toContain("== alternate versions (group sunny-forest) ==");
      expect(forkReport.text).toContain("sunny-forest#root-40");
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
});
