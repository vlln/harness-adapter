import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index";
import { exportSessions } from "../src/ahs/writer";
import { renderReport } from "../examples/ahs-report";
import { collectSessions } from "../src/validate/index";
import type { AhsRecord } from "../src/schema/record";
import type { Usage } from "../src/schema/usage";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "claude-code",
);

const SESSION_B = "22222222-2222-4222-8222-222222222222"; // main session with subagent file
const CHILD = "abc123";

const tmp = mkdtempSync(path.join(tmpdir(), "ahs-report-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sumUsage(sessions: { records: AhsRecord[] }[]): Required<Pick<Usage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">> {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const { records } of sessions) {
    for (const rec of records) {
      total.inputTokens += rec.usage?.inputTokens ?? 0;
      total.outputTokens += rec.usage?.outputTokens ?? 0;
      total.cacheReadTokens += rec.usage?.cacheReadTokens ?? 0;
      total.cacheWriteTokens += rec.usage?.cacheWriteTokens ?? 0;
    }
  }
  return total;
}

describe("ahs-report (AC layer-4)", () => {
  it("renders parent + anchored child from the archive alone, with correct aggregated usage", async () => {
    // Export the claude-code fixtures, then FORGET the adapter: the report
    // reads only the archive directory.
    const adapter = new ClaudeCodeAdapter(fixturesDir);
    const direct = await collectSessions(adapter);
    await exportSessions(adapter, tmp);

    const report = await renderReport(tmp, SESSION_B);

    // Parent and child are both rendered; child session header appears.
    expect(report.text).toContain(`# ${SESSION_B}`);
    expect(report.text).toContain(`# ${CHILD}`);
    // Child renders indented, right after the anchoring Task tool_call.
    const anchorIndex = report.text.indexOf("→ Task(");
    const childIndex = report.text.indexOf(`# ${CHILD}`);
    expect(anchorIndex).toBeGreaterThan(-1);
    expect(childIndex).toBeGreaterThan(anchorIndex);
    expect(report.text).toContain("  # abc123");
    // Child content (thinking collapsed, tool rendering) is present.
    expect(report.text).toContain("[thinking");
    expect(report.text).toContain("→ Grep(");
    expect(report.text).toContain("Refactor the parser to handle nested generics");

    // Aggregated usage = parent + child record usage (AC-0004: 总代价口径).
    const expected = sumUsage(
      direct.filter((s) =>
        [SESSION_B, CHILD].includes(s.manifest.sessionId),
      ),
    );
    expect(report.aggregatedSessions.sort()).toEqual([CHILD, SESSION_B].sort());
    expect(report.totalUsage).toMatchObject(expected);
    expect(report.text).toContain(`input=${expected.inputTokens}`);
    expect(report.text).toContain(`output=${expected.outputTokens}`);
    // Per-session breakdown lines exist for both sessions.
    expect(report.text).toContain(`cost (${SESSION_B}):`);
    expect(report.text).toContain(`cost (${CHILD}):`);
  });

  it("cuts cycles in the relation graph defensively", async () => {
    // Hand-build a tiny archive with A spawned_by B and B spawned_by A.
    const cycleRoot = mkdtempSync(path.join(tmpdir(), "ahs-report-cycle-"));
    afterAll(() => rmSync(cycleRoot, { recursive: true, force: true }));
    const base = {
      harness: "fake",
      harnessVersion: "0",
      ahsVersion: "0.1.0",
      cwd: "/tmp",
      model: "m",
    };
    for (const [id, parent] of [
      ["sess-a", "sess-b"],
      ["sess-b", "sess-a"],
    ] as const) {
      const dir = path.join(cycleRoot, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ ...base, sessionId: id, relation: { type: "spawned_by", sessionId: parent } }),
      );
      writeFileSync(
        path.join(dir, "records.jsonl"),
        `${JSON.stringify({
          recordId: `${id}-0`,
          parentId: null,
          seq: 0,
          timestamp: "2026-07-20T10:00:00.000Z",
          type: "user_message",
          content: [{ type: "text", text: `hello from ${id}` }],
        })}\n`,
      );
    }
    const report = await renderReport(cycleRoot, "sess-a");
    expect(report.text).toContain("cycle detected");
    expect(report.text).toContain("hello from sess-a");
    expect(report.text).toContain("hello from sess-b");
  });

  it("throws for a session not in the archive", async () => {
    await expect(renderReport(tmp, "no-such-session")).rejects.toThrow("not in archive");
  });
});
