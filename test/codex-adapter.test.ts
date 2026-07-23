/**
 * Codex adapter — AC coverage over synthetic fixtures
 * (test/fixtures/codex/sessions, hand-crafted, no real user data).
 *
 * Fixture set:
 * - a1: full-featured main session — redundant response_item/event_msg/
 *   top-level duplicates, encrypted reasoning, web_search_call, model_change,
 *   custom_tool_call, spawn_agent + sub_agent_activity (child anchor +
 *   forward link), compaction pair, goal verdicts, token_count with an
 *   unchanged-total duplicate.
 * - b2: sub-agent child of a1 (thread_spawn) with ancestor lineage headers
 *   (invocation wins over lineage).
 * - c3: resumed session (forked_from a1), turn_aborted with an unpaired
 *   tool_call, no token_count at all, truncated tail line.
 * - d4: session_meta only (no projectable content) — must be skipped.
 * - g7: session that crashed right after a user_message (its last record is
 *   a user_message).
 * - e5: resumed from g7, re-answering the pending prompt — sibling_attempt
 *   anchored at g7's user_message (AC-0002-N-7 type judgment).
 * - f6: resumed from c3 (chained fork) — forked_from anchored at c3's last
 *   record; also makes f6 the HEAD of the {a1, c3, f6} lineage group.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CodexAdapter, projectRecords, type RawLine } from "../src/adapters/codex/index";
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

const FIXTURES = path.join(import.meta.dirname, "fixtures", "codex");
const SESSIONS_DIR = path.join(FIXTURES, "sessions");
const GOLDEN_PATH = path.join(FIXTURES, "golden", "sessions.json");

const A1 = "019f8000-0000-7000-8000-0000000000a1";
const B2 = "019f8000-0000-7000-8000-0000000000b2";
const C3 = "019f8000-0000-7000-8000-0000000000c3";
const D4 = "019f8000-0000-7000-8000-0000000000d4";
const E5 = "019f8000-0000-7000-8000-0000000000e5";
const F6 = "019f8000-0000-7000-8000-0000000000f6";
const G7 = "019f8000-0000-7000-8000-0000000000g7";
const ALL_CONTENT = [A1, B2, C3, E5, F6, G7];

const tmp = mkdtempSync(path.join(tmpdir(), "codex-adapter-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sumUsage(records: AhsRecord[]): Usage {
  const total: Usage = {};
  for (const rec of records) {
    const u = rec.usage;
    if (u === undefined) continue;
    total.inputTokens = (total.inputTokens ?? 0) + (u.inputTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (u.outputTokens ?? 0);
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    total.reasoningTokens = (total.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0);
  }
  return total;
}

function textsOf(records: AhsRecord[], type: "user_message" | "assistant_message"): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (r.type !== type) continue;
    for (const b of r.content) {
      if (b.type === "text") out.push(b.text);
    }
  }
  return out;
}

describe("codex adapter", () => {
  let sessions: SessionData[];
  let byId: Map<string, SessionData>;

  beforeAll(async () => {
    sessions = await collectSessions(new CodexAdapter(SESSIONS_DIR));
    byId = new Map(sessions.map((s) => [s.manifest.sessionId, s]));
  });

  it("lists exactly the six content-bearing sessions (empty file skipped)", () => {
    expect([...byId.keys()].sort()).toEqual([...ALL_CONTENT].sort());
    expect(byId.has(D4)).toBe(false);
  });

  it("AC-0001-N-1: every manifest and record passes the AHS zod schemas", () => {
    for (const { manifest, records } of sessions) {
      expect(() => ManifestSchema.parse(manifest)).not.toThrow();
      expect(records.length).toBeGreaterThan(0);
      for (const rec of records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
      }
    }
  });

  it("AC-0001-E-1: unmapped source data (encrypted reasoning, server tools, system prompt, rewritten context) is dropped without breaking schema validity", () => {
    const source = readFileSync(
      path.join(
        SESSIONS_DIR,
        "2026/07/20",
        "rollout-2026-07-20T09-00-00-019f8000-0000-7000-8000-0000000000a1.jsonl",
      ),
      "utf8",
    );
    expect(source).toContain("encrypted_content");
    const projected = stableSerialize(sessions);
    for (const dropped of [
      "gAAAAABsynthetic-encrypted-blob-not-decryptable",
      "synthetic system prompt",
      "rewritten context, dropped as redundant bulk",
      "ws_synthetic_1",
      "rate_limits",
      "sandbox_policy",
    ]) {
      expect(projected).not.toContain(dropped);
    }
    // Output still fully schema-valid (re-checked after the drop assertions).
    for (const { records } of sessions) {
      for (const rec of records) AhsRecordSchema.parse(rec);
    }
  });

  it("AC-0002-N-1/N-2/N-6: linear, relation and tool-pairing invariants hold", () => {
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("AC-0002-N-2: thread_spawn child gets the invocation two-link (anchor + forward link reconciled)", () => {
    const child = byId.get(B2)!;
    expect(child.manifest.invocation?.sessionId).toBe(A1);
    // Anchor: resolved via the parent's sub_agent_activity
    // (agent_thread_id b2 → event_id call_spwn3 → that tool_call's recordId).
    const anchorId = child.manifest.invocation?.atRecordId;
    expect(anchorId).toBeDefined();
    const parent = byId.get(A1)!;
    const anchor = parent.records.find((r) => r.recordId === anchorId);
    expect(anchor).toBeDefined();
    expect(anchor!.type === "tool_call" && anchor!.name).toBe("spawn_agent");
    expect(anchor!.type === "tool_call" && anchor!.toolCallId).toBe("call_spwn3");
    // Forward link: the parent's paired tool_result carries the child id.
    const callId = anchor!.type === "tool_call" ? anchor!.toolCallId : "";
    const paired = parent.records.find((r) => r.type === "tool_result" && r.toolCallId === callId);
    expect(paired).toBeDefined();
    expect(paired!.type === "tool_result" && paired!.sessionId).toBe(B2);
  });

  it("AC-0002-N-7: lineage anchors resolve and the type is judged by the anchor record", () => {
    // c3 forked_from a1, anchored at a1's last record (a turn_boundary).
    const a1Last = byId.get(A1)!.records.at(-1)!;
    expect(a1Last.type).toBe("turn_boundary");
    expect(byId.get(C3)!.manifest.lineage).toEqual({
      type: "forked_from",
      sessionId: A1,
      atRecordId: a1Last.recordId,
    });
    // f6 chained fork from c3, anchored at c3's last record.
    const c3Last = byId.get(C3)!.records.at(-1)!;
    expect(byId.get(F6)!.manifest.lineage).toEqual({
      type: "forked_from",
      sessionId: C3,
      atRecordId: c3Last.recordId,
    });
    // e5 anchored at g7's last record — a user_message ⇔ sibling_attempt.
    const g7Last = byId.get(G7)!.records.at(-1)!;
    expect(g7Last.type).toBe("user_message");
    expect(byId.get(E5)!.manifest.lineage).toEqual({
      type: "sibling_attempt",
      sessionId: G7,
      atRecordId: g7Last.recordId,
    });
    // The sub-agent child carries invocation, NOT lineage, despite its lineage headers.
    expect(byId.get(B2)!.manifest.invocation).toBeDefined();
    expect(byId.get(B2)!.manifest.lineage).toBeUndefined();
  });

  it("AC-0002-N-3: user/assistant message counts match the source and text is verbatim", () => {
    const all = sessions.flatMap((s) => s.records);
    expect(textsOf(all, "user_message")).toEqual([
      "修复登录页的崩溃 bug",
      "请审查 src/login.ts 的改动",
      "继续，补充一个回归测试",
      "把缓存层也一起优化了吧",
      "换个思路：直接重构登录模块",
    ]);
    expect(textsOf(all, "assistant_message")).toEqual([
      "我先定位登录页代码。",
      "已修复：崩溃原因是空指针，已加防护并交给子代理审查。",
      "审查完成：修复正确，无回归风险。",
      "好的，我先起草重构计划。",
      "缓存层已优化：为登录查询加了 memo 缓存。",
    ]);
  });

  it("dedup: response_item/event_msg/top-level duplicates collapse to one record each", () => {
    const a1 = byId.get(A1)!.records;
    // event_msg user_message / agent_message duplicates did not double records.
    expect(a1.filter((r) => r.type === "user_message")).toHaveLength(1);
    expect(a1.filter((r) => r.type === "assistant_message")).toHaveLength(2);
    // Top-level function_call / function_call_output duplicates deduped by call_id.
    expect(a1.filter((r) => r.type === "tool_call" && r.toolCallId === "call_aaa1")).toHaveLength(1);
    expect(
      a1.filter((r) => r.type === "tool_result" && r.toolCallId === "call_aaa1"),
    ).toHaveLength(1);
  });

  it("AC-0002-N-4: record-level usage sums to the source's final total_token_usage (unchanged-total duplicates skipped)", () => {
    const a1 = byId.get(A1)!;
    expect(sumUsage(a1.records)).toEqual({
      inputTokens: 2000,
      outputTokens: 180,
      cacheReadTokens: 400,
      reasoningTokens: 90,
    });
    expect(a1.manifest.stats?.totalUsage).toEqual({
      inputTokens: 2000,
      outputTokens: 180,
      cacheReadTokens: 400,
      reasoningTokens: 90,
    });
  });

  it("AC-0002-N-5: two runs over the same input are byte-identical", async () => {
    expect(await checkIdempotency(new CodexAdapter(SESSIONS_DIR))).toEqual([]);
  });

  it("AC-0002-B-1: an unpaired tool_call (turn_aborted) is marked interrupted, no synthetic result", () => {
    const c3 = byId.get(C3)!.records;
    const call = c3.find((r) => r.type === "tool_call" && r.toolCallId === "call_ccc4");
    expect(call).toBeDefined();
    expect(call!.type === "tool_call" && call!.status).toBe("interrupted");
    expect(c3.some((r) => r.type === "tool_result" && r.toolCallId === "call_ccc4")).toBe(false);
    // turn_aborted surfaced as a turn_boundary end.
    const boundaries = c3.filter((r) => r.type === "turn_boundary");
    expect(boundaries.map((r) => (r.type === "turn_boundary" ? r.phase : ""))).toEqual([
      "start",
      "end",
    ]);
  });

  it("AC-0002-B-2: a session with no source usage data has usage absent, not fabricated", () => {
    const c3 = byId.get(C3)!;
    expect(c3.records.every((r) => r.usage === undefined)).toBe(true);
    expect(c3.manifest.stats?.totalUsage).toBeUndefined();
  });

  it("state records: model_change, single compaction per pair, goal verdicts, developer→harness_message", () => {
    const a1 = byId.get(A1)!.records;
    const modelChanges = a1.filter((r) => r.type === "model_change");
    expect(modelChanges).toHaveLength(1);
    expect(modelChanges[0]!.type === "model_change" && modelChanges[0]!.model).toBe("gpt-5.5-mini");
    expect(a1.filter((r) => r.type === "compaction")).toHaveLength(1);
    const goals = a1.filter((r) => r.type === "goal_update");
    expect(goals.map((r) => (r.type === "goal_update" ? r.status : ""))).toEqual([
      "pending",
      "met",
    ]);
    const harnessMsgs = a1.filter((r) => r.type === "harness_message");
    expect(harnessMsgs).toHaveLength(1);
    expect(
      harnessMsgs[0]!.type === "harness_message" &&
        harnessMsgs[0]!.content[0]!.type === "text" &&
        harnessMsgs[0]!.content[0]!.text,
    ).toBe("Reminder: keep changes minimal.");
  });

  it("manifest fields: version, cwd, workspaceRoots, git, model, provider, stats", () => {
    const m = byId.get(A1)!.manifest;
    expect(m).toMatchObject({
      sessionId: A1,
      harness: "codex",
      harnessVersion: "0.142.5",
      cwd: "/workspace/demo",
      workspaceRoots: ["/workspace/demo", "/workspace/lib"],
      git: {
        branch: "main",
        commit: "0123456789abcdef0123456789abcdef01234567",
        repoUrl: "https://github.com/example/demo.git",
      },
      model: "gpt-5.5",
      provider: "openai",
    });
    expect(m.ahsVersion).toBeTypeOf("string");
    expect(m.stats?.turnCount).toBe(2);
  });

  it("custom_tool_call keeps its raw input verbatim; function_call args are parsed JSON", () => {
    const a1 = byId.get(A1)!.records;
    const patch = a1.find((r) => r.type === "tool_call" && r.toolCallId === "call_bbb2")!;
    expect(patch.type === "tool_call" && patch.args).toBe(
      "*** Begin Patch\n*** Update File: src/login.ts\n@@\n-crash()\n+guard()\n*** End Patch",
    );
    const exec = a1.find((r) => r.type === "tool_call" && r.toolCallId === "call_aaa1")!;
    expect(exec.type === "tool_call" && exec.args).toEqual({
      cmd: "ls src",
      workdir: "/workspace/demo",
    });
  });

  it("listSessions filters by harness and cwd", async () => {
    const adapter = new CodexAdapter(SESSIONS_DIR);
    const wrongHarness: string[] = [];
    for await (const m of adapter.listSessions({ harness: "kimi" })) wrongHarness.push(m.sessionId);
    expect(wrongHarness).toEqual([]);
    const byCwd: string[] = [];
    for await (const m of adapter.listSessions({ cwd: "/workspace/demo", includeForks: true })) {
      byCwd.push(m.sessionId);
    }
    expect(byCwd.sort()).toEqual([...ALL_CONTENT].sort());
    const noMatch: string[] = [];
    for await (const m of adapter.listSessions({ cwd: "/elsewhere" })) noMatch.push(m.sessionId);
    expect(noMatch).toEqual([]);
  });

  it("includeForks (interface/0001): default lists only lineage-group HEADs; true lists everything", async () => {
    const adapter = new CodexAdapter(SESSIONS_DIR);
    const heads: string[] = [];
    for await (const m of adapter.listSessions()) heads.push(m.sessionId);
    // HEAD = most recently updated per lineage group: f6 for {a1, c3, f6},
    // e5 for {g7, e5}; b2 (invocation-only) is its own group and never folds.
    expect(heads.sort()).toEqual([B2, E5, F6].sort());

    const all: string[] = [];
    for await (const m of adapter.listSessions({ includeForks: true })) all.push(m.sessionId);
    expect(all.sort()).toEqual([...ALL_CONTENT].sort());
  });

  it("readRecords throws for an unknown sessionId", async () => {
    const adapter = new CodexAdapter(SESSIONS_DIR);
    await expect(async () => {
      for await (const _ of adapter.readRecords("no-such-session")) {
        // unreachable
      }
    }).rejects.toThrow("session not found");
  });

  it("AC-0003-N-1: golden diff against the reviewed expected output", () => {
    const golden = readFileSync(GOLDEN_PATH, "utf8");
    expect(`${stableSerialize(sessions)}\n`).toBe(golden);
  });

  it("AC-0004-N-1: archive export + report renders the child under its anchor and aggregates usage exactly", async () => {
    const outDir = path.join(tmp, "archive");
    await exportSessions(new CodexAdapter(SESSIONS_DIR), outDir);

    const report = await renderReport(outDir, A1);
    expect(report.aggregatedSessions.sort()).toEqual([A1, B2].sort());
    // Child rendered indented, right after the anchoring spawn_agent call.
    const anchorIndex = report.text.indexOf("→ spawn_agent(");
    const childIndex = report.text.indexOf(`  # ${B2}`);
    expect(anchorIndex).toBeGreaterThan(-1);
    expect(childIndex).toBeGreaterThan(anchorIndex);
    expect(report.text).toContain("审查完成：修复正确，无回归风险。");
    // a1 (2000/180/400/90) + b2 (500/80/100/20), forked_from c3 NOT included.
    expect(report.totalUsage).toMatchObject({
      inputTokens: 2500,
      outputTokens: 260,
      cacheReadTokens: 500,
      reasoningTokens: 110,
    });
  });

  it("projectRecords: usage arriving before any record is held for the next one (never lost)", () => {
    const lines: RawLine[] = [
      {
        timestamp: "2026-07-20T09:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 5 },
            last_token_usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      },
      {
        timestamp: "2026-07-20T09:00:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
    ];
    const records = projectRecords("sess-x", lines);
    expect(records).toHaveLength(1);
    expect(records[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("projectRecords: duplicate tool_results keep the first in file order", () => {
    const lines: RawLine[] = [
      {
        timestamp: "2026-07-20T09:00:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: "{}",
          call_id: "call_dup",
        },
      },
      {
        timestamp: "2026-07-20T09:00:01.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_dup", output: "first" },
      },
      {
        timestamp: "2026-07-20T09:00:02.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_dup", output: "second" },
      },
    ];
    const records = projectRecords("sess-y", lines);
    const results = records.filter((r) => r.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]!.type === "tool_result" && results[0]!.content).toBe("first");
  });

  it("sessionId falls back to the filename when session_meta is absent", async () => {
    const dir = path.join(tmp, "filename-fallback", "2026", "07", "23");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "rollout-2026-07-23T08-30-00-019f8000-0000-7000-8000-0000000000e5.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-07-23T08:30:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "no meta here" }],
        },
      })}\n`,
    );
    const adapter = new CodexAdapter(path.join(tmp, "filename-fallback"));
    const ids: string[] = [];
    for await (const m of adapter.listSessions()) ids.push(m.sessionId);
    expect(ids).toEqual(["019f8000-0000-7000-8000-0000000000e5"]);
    const records: AhsRecord[] = [];
    for await (const r of adapter.readRecords("019f8000-0000-7000-8000-0000000000e5")) {
      records.push(r);
    }
    expect(records).toHaveLength(1);
    expect(() => AhsRecordSchema.parse(records[0]!)).not.toThrow();
  });
});
