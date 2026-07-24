import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { GrokAdapter } from "../src/adapters/grok/index";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import {
  checkIdempotency,
  collectSessions,
  validateSessions,
} from "../src/validate/index";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "grok",
);
const sessionsDir = path.join(fixturesDir, "sessions");

const SESSION_ID = "019f0000-0000-7000-8000-000000000001";
const FALLBACK_SESSION_ID = "019f0000-0000-7000-8000-000000000002";

async function readAll(adapter: GrokAdapter, sessionId: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId)) records.push(rec);
  return records;
}

/** Write a synthetic session dir under a fresh tmp base path. */
function writeSession(
  base: string,
  sessionId: string,
  files: Record<string, string>,
): void {
  const dir = path.join(base, "%2Fhome%2Ftest%2Ftmp", sessionId);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "grok-adapter-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("grok adapter", () => {
  const adapter = new GrokAdapter(sessionsDir);

  it("declares harness + capabilities (history full, control false)", () => {
    expect(adapter.harness).toBe("grok");
    expect(adapter.capabilities).toEqual({ history: "full", control: false });
  });

  it("layer 1 (AC-0001-N-1): every manifest and record passes the zod schemas", async () => {
    const sessions = await collectSessions(adapter);
    expect(sessions.length).toBeGreaterThan(0);
    for (const { manifest, records } of sessions) {
      expect(() => ManifestSchema.parse(manifest)).not.toThrow();
      expect(records.length).toBeGreaterThan(0);
      for (const rec of records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
      }
    }
  });

  it("layer 1 (AC-0001-E-1): unmappable source content is dropped, output stays schema-clean", async () => {
    // The fixture carries the base system prompt, encrypted reasoning blobs,
    // an empty-summary reasoning, model_fingerprint/reasoning_effort and
    // loop/phase lifecycle events — none are projectable.
    const records = await readAll(adapter, SESSION_ID);
    for (const rec of records) {
      const parsed = AhsRecordSchema.parse(rec);
      expect(Object.keys(rec).sort()).toEqual(Object.keys(parsed).sort());
    }
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("You are Grok 4.5 released by xAI"); // system prompt dropped
    expect(serialized).not.toContain("SYNTHETIC-ENCRYPTED-BLOB"); // encrypted_content dropped
    expect(serialized).not.toContain("phase_changed"); // lifecycle events dropped
  });

  it("layer 2 (AC-0002): all semantic invariants hold on all fixtures", async () => {
    const sessions = await collectSessions(adapter);
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("layer 2 (AC-0002-N-5): idempotent — two runs are byte-identical", async () => {
    expect(await checkIdempotency(adapter)).toEqual([]);
  });

  it("maps the manifest from summary.json + signals.json + version.json", async () => {
    const sessions = await collectSessions(adapter);
    const main = sessions.find((s) => s.manifest.sessionId === SESSION_ID)!.manifest;
    expect(main).toMatchObject({
      harness: "grok",
      harnessVersion: "0.2.93-test", // <base>/../version.json
      cwd: "/home/test/demo", // summary.json info.cwd
      title: "修复登录页空指针",
      titleOrigin: "generated",
      model: "grok-4.5", // summary.current_model_id, NOT the later model_id
      provider: "xai",
    });
    expect(main.stats?.turnCount).toBe(2); // events turn_started count
    expect(main.stats?.durationMs).toBe(95000); // signals.sessionDurationSeconds * 1000
    // AC-0002-B-2: the source has no record-level usage; signals aggregates
    // are context-window metrics, not Usage — nothing is fabricated.
    expect(main.stats?.totalUsage).toBeUndefined();
  });

  it("synthesizes a deterministic linear chain (AC-0002-N-1)", async () => {
    const records = await readAll(adapter, SESSION_ID);
    expect(records).toHaveLength(16);
    records.forEach((rec, i) => {
      expect(rec.recordId).toBe(`${SESSION_ID}:${i}`);
      expect(rec.seq).toBe(i);
      expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("provenance: synthetic_reason marks harness_message, its absence marks user_message", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const users = records.filter((r) => r.type === "user_message");
    expect(users).toHaveLength(3); // user_info (unmarked) + two real queries
    expect(users[1]).toMatchObject({
      content: [{ type: "text", text: "<user_query>\n修复登录页空指针\n</user_query>" }],
    });
    const harness = records.filter((r) => r.type === "harness_message");
    expect(harness).toHaveLength(1); // synthetic_reason: system_reminder
    expect(harness[0]).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("<system-reminder>") }],
    });
    // Session 2: project_instructions is harness provenance too.
    const records2 = await readAll(adapter, FALLBACK_SESSION_ID);
    expect(records2.map((r) => r.type)).toEqual(["harness_message", "user_message"]);
  });

  it("reasoning summary[] becomes a thinking block on the next assistant_message", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const first = records.find((r) => r.type === "assistant_message");
    expect(first).toMatchObject({
      content: [
        { type: "thinking", text: "先定位空指针出现的位置。" },
        { type: "text", text: "我来查看登录页代码。" },
      ],
    });
    // The empty-summary reasoning is dropped entirely: the second turn's
    // tool-call-only assistant produces NO assistant_message at all.
    const assistants = records.filter((r) => r.type === "assistant_message");
    expect(assistants).toHaveLength(2);
  });

  it("maps tool_calls/tool_results, derives status completed XOR interrupted (AC-0002-N-6, B-1)", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const calls = records.filter((r) => r.type === "tool_call");
    expect(calls).toHaveLength(3);
    // arguments is a JSON-encoded string in the source — parsed into args.
    expect(calls[0]).toMatchObject({
      toolCallId: "call-g001",
      name: "read_file",
      args: { target_file: "/home/test/demo/src/login.ts" },
      status: "completed",
    });
    expect(calls[2]).toMatchObject({ toolCallId: "call-g003", status: "interrupted" });
    expect(records.some((r) => r.type === "tool_result" && r.toolCallId === "call-g003")).toBe(
      false,
    );
    // The source carries no error marker → paired results default to success.
    const results = records.filter((r) => r.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      toolCallId: "call-g001",
      content: "42→  const user = session.user;",
      status: "success",
    });
  });

  it("emits model_change when a later assistant model_id differs", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const changes = records.filter((r) => r.type === "model_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ model: "grok-4.5-mini" });
  });

  it("recovers turn boundaries + per-turn timestamps from events.jsonl", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const boundaries = records.filter((r) => r.type === "turn_boundary");
    expect(boundaries.map((b) => [b.type === "turn_boundary" ? b.phase : "", b.timestamp])).toEqual([
      ["start", "2026-07-20T09:00:00.000Z"],
      ["end", "2026-07-20T09:05:00.000Z"],
      ["start", "2026-07-20T09:10:00.000Z"],
      ["end", "2026-07-20T09:12:00.000Z"],
    ]);
    // Records of turn 0 inherit the turn start ts; pre-turn-0 records fall
    // back to summary created_at.
    expect(records[0]!.timestamp).toBe("2026-07-20T08:59:00.000Z"); // user_info
    const query = records.find(
      (r) => r.type === "user_message" && JSON.stringify(r).includes("修复登录页空指针"),
    );
    expect(query!.timestamp).toBe("2026-07-20T09:00:00.000Z");
  });

  it("fallback session (no events/signals): created_at timestamps, no boundaries, minimal stats (AC-0002-B-2)", async () => {
    const sessions = await collectSessions(adapter);
    const fallback = sessions.find((s) => s.manifest.sessionId === FALLBACK_SESSION_ID)!;
    expect(fallback.records).toHaveLength(2);
    expect(fallback.records.every((r) => r.timestamp === "2026-07-21T10:00:00.000Z")).toBe(true);
    expect(fallback.records.some((r) => r.type === "turn_boundary")).toBe(false);
    expect(fallback.manifest.stats?.turnCount).toBe(0);
    expect(fallback.manifest.stats?.durationMs).toBeUndefined();
    expect(fallback.manifest.stats?.totalUsage).toBeUndefined();
    expect(fallback.records.every((r) => r.usage === undefined)).toBe(true);
    expect(validateSessions([fallback])).toEqual([]);
  });

  it("duplicate tool_results for one call id: first in file order wins (AC-0002-N-6)", async () => {
    const base = path.join(tmp, "dup-result", "sessions");
    writeSession(base, "019f0000-0000-7000-8000-0000000000d1", {
      "chat_history.jsonl": [
        '{"type":"assistant","content":"","tool_calls":[{"id":"call-d1","name":"read_file","arguments":"not-json"}],"model_id":"grok-4.5"}',
        '{"type":"tool_result","tool_call_id":"call-d1","content":"first"}',
        '{"type":"tool_result","tool_call_id":"call-d1","content":"second"}',
        "",
      ].join("\n"),
      "summary.json": '{"info":{"cwd":"/home/test/tmp"},"current_model_id":"grok-4.5","created_at":"2026-07-22T00:00:00.000Z"}',
    });
    const dup = new GrokAdapter(base);
    const sessions = await collectSessions(dup);
    expect(validateSessions(sessions)).toEqual([]);
    const records = sessions[0]!.records;
    const results = records.filter((r) => r.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ content: "first", status: "success" });
    // Unparseable arguments string is kept verbatim.
    const call = records.find((r) => r.type === "tool_call");
    expect(call).toMatchObject({ args: "not-json", status: "completed" });
  });

  it("tool_result status field (older shape) maps completed→success, else error", async () => {
    const base = path.join(tmp, "status-shape", "sessions");
    writeSession(base, "019f0000-0000-7000-8000-0000000000e1", {
      "chat_history.jsonl": [
        '{"type":"assistant","content":"","tool_calls":[{"id":"call-e1","name":"Bash","arguments":"{}"}],"model_id":"grok-4.5"}',
        '{"type":"tool_result","tool_call_id":"call-e1","result":"boom","status":"failed"}',
        "",
      ].join("\n"),
      "summary.json": '{"info":{"cwd":"/home/test/tmp"},"current_model_id":"grok-4.5","created_at":"2026-07-22T00:00:00.000Z"}',
    });
    const st = new GrokAdapter(base);
    const sessions = await collectSessions(st);
    expect(validateSessions(sessions)).toEqual([]);
    const records = sessions[0]!.records;
    expect(records.find((r) => r.type === "tool_result")).toMatchObject({
      content: "boom",
      status: "error",
    });
    expect(records.find((r) => r.type === "tool_call")).toMatchObject({ status: "failed" });
  });

  it("tolerates a truncated tail line and skips sessions without projectable content", async () => {
    const base = path.join(tmp, "truncated", "sessions");
    writeSession(base, "019f0000-0000-7000-8000-0000000000f1", {
      "chat_history.jsonl":
        '{"type":"user","content":[{"type":"text","text":"完整的一行"}]}\n' +
        '{"type":"user","content":[{"type":"text","text":"半截',
      "summary.json": '{"info":{"cwd":"/home/test/tmp"},"created_at":"2026-07-22T00:00:00.000Z"}',
    });
    // A session whose chat_history holds only the dropped system prompt.
    writeSession(base, "019f0000-0000-7000-8000-0000000000f2", {
      "chat_history.jsonl": '{"type":"system","content":"You are Grok."}\n',
      "summary.json": '{"info":{"cwd":"/home/test/tmp"},"created_at":"2026-07-22T00:00:00.000Z"}',
    });
    const trunc = new GrokAdapter(base);
    const sessions = await collectSessions(trunc);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.records).toHaveLength(1);
    expect(sessions[0]!.records[0]).toMatchObject({
      type: "user_message",
      content: [{ type: "text", text: "完整的一行" }],
    });
    // No summary model and no assistant model_id → "unknown"; cwd from summary.
    expect(sessions[0]!.manifest.model).toBe("unknown");
    expect(sessions[0]!.manifest.harnessVersion).toBe("unknown"); // no version.json
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("decodes the project dir name as cwd when summary.json lacks info.cwd", async () => {
    const base = path.join(tmp, "cwd-decode", "sessions");
    writeSession(base, "019f0000-0000-7000-8000-0000000000c1", {
      "chat_history.jsonl": '{"type":"user","content":[{"type":"text","text":"hi"}]}\n',
      "summary.json": '{"created_at":"2026-07-22T00:00:00.000Z"}',
    });
    const dec = new GrokAdapter(base);
    const sessions = await collectSessions(dec);
    expect(sessions[0]!.manifest.cwd).toBe("/home/test/tmp");
  });

  it("throws for an unknown session id", async () => {
    await expect(readAll(adapter, "no-such-session")).rejects.toThrow("session not found");
  });

  it("listSessions honors the harness and cwd filters", async () => {
    const mismatched: string[] = [];
    for await (const m of adapter.listSessions({ harness: "codex" })) {
      mismatched.push(m.sessionId);
    }
    expect(mismatched).toEqual([]);
    const matched: string[] = [];
    for await (const m of adapter.listSessions({ harness: "grok", cwd: "/home/test/demo" })) {
      matched.push(m.sessionId);
    }
    expect(matched.sort()).toEqual([FALLBACK_SESSION_ID, SESSION_ID].sort());
    const wrongCwd: string[] = [];
    for await (const m of adapter.listSessions({ cwd: "/elsewhere" })) {
      wrongCwd.push(m.sessionId);
    }
    expect(wrongCwd).toEqual([]);
  });

  it("listSessions includeForks: no-op — no lineage is ever emitted, every session is its own group HEAD", async () => {
    const collect = async (includeForks?: boolean): Promise<string[]> => {
      const ids: string[] = [];
      for await (const m of adapter.listSessions(
        includeForks === undefined ? {} : { includeForks },
      )) {
        ids.push(m.sessionId);
      }
      return ids.sort();
    };
    const all = [FALLBACK_SESSION_ID, SESSION_ID].sort();
    expect(await collect()).toEqual(all);
    expect(await collect(false)).toEqual(all);
    expect(await collect(true)).toEqual(all);
  });
});
