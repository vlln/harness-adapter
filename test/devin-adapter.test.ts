/**
 * Devin adapter — four-layer AC tests (see docs/plans/0007-devin-adapter).
 *
 * Fixture: programmatically generated SQLite (test/fixtures/devin-db.ts,
 * synthetic data only). Golden: test/fixtures/devin-golden.json (reviewed).
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
import { createDevinFixture, T0 } from "./fixtures/devin-db";

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

  it("lists visible sessions only, main chain then siblings", () => {
    expect(sessions.map((s) => s.manifest.sessionId)).toEqual([
      "odd-cove",
      "quiet-pond",
      "sunny-forest",
      "sunny-forest#root-20",
      "sunny-forest#root-30",
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
    for await (const m of adapter.listSessions({ cwd: "/work/beta" })) listed.push(m.sessionId);
    expect(listed).toEqual(["quiet-pond"]);
  });

  it("rejects unknown session ids (incl. unknown sibling roots)", async () => {
    await expect(async () => {
      for await (const _ of adapter.readRecords("no-such")) void _;
    }).rejects.toThrow(/session not found/);
    await expect(async () => {
      for await (const _ of adapter.readRecords("sunny-forest#root-999")) void _;
    }).rejects.toThrow(/session not found/);
  });

  it("reads the main chain via its explicit #root-0 form", async () => {
    const explicit: AhsRecord[] = [];
    for await (const rec of adapter.readRecords("sunny-forest#root-0")) explicit.push(rec);
    expect(explicit.map((r) => r.recordId)).toEqual(session("sunny-forest").records.map((r) => r.recordId));
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
    expect(recordCount).toBe(18);
  });

  it("AC-0001-E-1: unmappable source content is dropped, output stays valid", () => {
    const main = session("sunny-forest");
    const ids = main.records.map((r) => r.recordId);
    // Unknown role, malformed JSON, empty assistant, branch-retry duplicate,
    // duplicate tool result — none of them produce records.
    expect(ids).not.toContain("m-unk-10");
    expect(ids).not.toContain("m-asst-14");
    expect(ids).not.toContain("m-tool-8");
    expect(ids.filter((id) => id === "m-user-1")).toHaveLength(1);
    for (const rec of main.records) AhsRecordSchema.parse(rec);
    // No schema-external fields leaked: parse + re-serialize round-trips.
    for (const rec of main.records) {
      expect(AhsRecordSchema.parse(rec)).toEqual(rec);
    }
  });
});

describe("AC-0002: output is complete (layer 2 invariants)", () => {
  it("AC-0002-N-1/N-2/N-6: validateSessions passes on the full output", () => {
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("AC-0002-N-1: forest splits — each AHS session is linear (seq contiguous from 0)", () => {
    for (const s of sessions) {
      expect(s.records.map((r) => r.seq)).toEqual(s.records.map((_, i) => i));
    }
    // Main chain root resolved by walking UP from main_chain_id (a tip, 5).
    const main = session("sunny-forest");
    expect(main.records[0]).toMatchObject({ recordId: "m-sys-0", seq: 0 });
    // Dedup: branch-retry duplicates of a message_id are skipped — the
    // reply to the duplicate lands after the first occurrence.
    const reply = main.records.find((r) => r.recordId === "m-asst-7");
    expect(reply).toBeDefined();
  });

  it("AC-0002-N-7: sibling_attempt lineage edges resolve to the main session", () => {
    const main = session("sunny-forest");
    expect(main.manifest.lineage).toBeUndefined();
    expect(main.manifest.invocation).toBeUndefined();
    for (const id of ["sunny-forest#root-20", "sunny-forest#root-30"]) {
      const sibling = session(id);
      // TODO(Plan 02): atRecordId shared-prefix anchor (message_id reconciliation).
      expect(sibling.manifest.lineage).toEqual({ type: "sibling_attempt", sessionId: "sunny-forest" });
    }
  });

  it("AC-0002-N-3: message counts match the source after dedup; text is verbatim", () => {
    const main = session("sunny-forest");
    // Source sunny-forest: 6 user-role nodes + 6 assistant-role nodes; after
    // dedup/drops: user m-user-1, m-user-11, m-user-13 (+1 harness-impersonated
    // routed to harness_message); assistant m-asst-2, m-asst-9, m-asst-7.
    expect(main.records.filter((r) => r.type === "user_message")).toHaveLength(3);
    expect(main.records.filter((r) => r.type === "assistant_message")).toHaveLength(3);
    const m2 = main.records.find((r) => r.recordId === "m-asst-2");
    expect(m2).toMatchObject({
      type: "assistant_message",
      content: [
        { type: "thinking", text: "Let me think." },
        { type: "text", text: "I'll inspect the file." },
      ],
      timestamp: iso(20),
    });
    // system → harness_message; user with is_user_input=false → harness_message.
    expect(main.records.find((r) => r.recordId === "m-sys-0")?.type).toBe("harness_message");
    expect(main.records.find((r) => r.recordId === "m-harness-15")).toMatchObject({
      type: "harness_message",
      content: [{ type: "text", text: "<system-reminder>tick</system-reminder>" }],
    });
    // Tool result content verbatim.
    expect(main.records.find((r) => r.recordId === "m-tool-3")).toMatchObject({
      type: "tool_result",
      toolCallId: "tc-1",
      content: "file contents here",
    });
  });

  it("AC-0002-N-4: record-level usage reconciles with the source totals", () => {
    const main = session("sunny-forest");
    // Source metrics: n2 (100/20/177w/1500ms) + n4 (50/10/800ms); cache_read null dropped.
    expect(sumRecordUsage(main.records)).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheWriteTokens: 177,
      durationMs: 2300,
    });
    // Tool-only assistant: usage rides on the first tool_call (not lost).
    expect(main.records.find((r) => r.recordId === "m-asst-4/tool_call/0")?.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      durationMs: 800,
    });
    // Manifest stats aggregate this session only, plus the credit cost.
    expect(main.manifest.stats).toEqual({
      turnCount: 3,
      totalUsage: {
        inputTokens: 150,
        outputTokens: 30,
        cacheWriteTokens: 177,
        durationMs: 2300,
        cost: { amount: 7, currency: "credit" },
      },
      durationMs: 3600000,
    });
    // Sibling sessions carry no cost (no per-tree attribution).
    expect(session("sunny-forest#root-30").manifest.stats?.totalUsage).toBeUndefined();
  });

  it("AC-0002-N-5: two runs are byte-identical", async () => {
    expect(await checkIdempotency(adapter)).toEqual([]);
  });

  it("AC-0002-N-6: tool pairing XOR holds; duplicate result keeps DFS-first", () => {
    const main = session("sunny-forest");
    const calls = main.records.filter((r) => r.type === "tool_call");
    expect(calls.map((r) => [r.toolCallId, r.status])).toEqual([
      ["tc-1", "completed"],
      ["tc-2", "completed"],
      ["tc-3", "interrupted"],
    ]);
    const resultsForTc2 = main.records.filter((r) => r.type === "tool_result" && r.toolCallId === "tc-2");
    expect(resultsForTc2).toHaveLength(1);
    expect(resultsForTc2[0]).toMatchObject({ recordId: "m-tool-5", content: "ok" });
  });

  it("AC-0002-B-1: interrupted tool_call gets no synthetic tool_result", () => {
    const main = session("sunny-forest");
    expect(main.records.some((r) => r.type === "tool_result" && r.toolCallId === "tc-3")).toBe(false);
  });

  it("AC-0002-B-2: source without usage yields no usage fields; existing usage kept", () => {
    const quiet = session("quiet-pond");
    expect(quiet.records.every((r) => r.usage === undefined)).toBe(true);
    expect(quiet.manifest.stats?.totalUsage).toBeUndefined();
    // odd-cove: invalid metadata JSON → no cost, adapter does not crash.
    expect(session("odd-cove").manifest.stats?.totalUsage).toBeUndefined();
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
      const written = await exportSessions(adapter, archiveDir);
      expect(written.map((w) => w.sessionId).sort()).toEqual(
        ["odd-cove", "quiet-pond", "sunny-forest", "sunny-forest#root-20", "sunny-forest#root-30"].sort(),
      );

      const report = await renderReport(archiveDir, "sunny-forest");
      // Transcript renders the key records readably.
      expect(report.text).toContain("# sunny-forest [devin · claude-test-medium] — Alpha Refactor");
      expect(report.text).toContain("[user] Refactor the parser.");
      expect(report.text).toContain("[thinking 13 chars]");
      expect(report.text).toContain("→ read_file(");
      expect(report.text).toContain("⤷ file contents here");
      // Token aggregation matches record-level reconciliation (AC-0002-N-4).
      // (renderReport materializes unused token keys as 0 — match on values.)
      expect(report.totalUsage).toMatchObject({
        inputTokens: 150,
        outputTokens: 30,
        cacheWriteTokens: 177,
        durationMs: 2300,
      });
      expect(report.aggregatedSessions).toEqual(["sunny-forest"]);

      // Sibling sessions are archived under sanitized, resolvable dir names.
      const siblingReport = await renderReport(archiveDir, "sunny-forest#root-30");
      expect(siblingReport.text).toContain("[user] Try differently.");
    } finally {
      await rm(archiveDir, { recursive: true, force: true });
    }
  });
});

describe("manifest mapping", () => {
  it("maps session fields; titleOrigin custom; harnessVersion unknown", () => {
    const main = session("sunny-forest").manifest;
    expect(main).toMatchObject({
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
    expect(session("odd-cove").records[0]).toMatchObject({ recordId: "node-0", type: "user_message" });
  });
});
