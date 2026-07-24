import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { GrokAdapter } from "../src/adapters/grok/index";
import { exportSessions } from "../src/ahs/writer";
import { renderReport } from "../examples/ahs-report";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "grok",
);

const SESSION_ID = "019f0000-0000-7000-8000-000000000001";

const tmp = mkdtempSync(path.join(tmpdir(), "grok-report-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("grok archive + ahs-report (AC layer-4, AC-0004-N-1)", () => {
  it("renders a readable transcript from the archive alone", async () => {
    // Export the grok fixtures, then FORGET the adapter: the report reads
    // only the archive directory.
    const adapter = new GrokAdapter(path.join(fixturesDir, "sessions"));
    const results = await exportSessions(adapter, tmp);
    expect(results).toHaveLength(2);

    const report = await renderReport(tmp, SESSION_ID);

    // Transcript content is readable: user text, thinking collapse, tool
    // rendering, turn boundaries, model change, interrupted call.
    expect(report.text).toContain(`# ${SESSION_ID}`);
    expect(report.text).toContain("[user] <user_query>\n修复登录页空指针");
    expect(report.text).toContain("[harness] <system-reminder>");
    expect(report.text).toContain("[thinking");
    expect(report.text).toContain("→ read_file(");
    expect(report.text).toContain("⤷"); // tool_result line
    expect(report.text).toContain("(interrupted)");
    expect(report.text).toContain("─ turn start (0)");
    expect(report.text).toContain("─ turn end (1)");
    expect(report.text).toContain("─ model change → grok-4.5-mini");

    // Grok has no record-level usage (source has none) — the cost summary
    // still renders, with zero token totals and the session's own slice.
    expect(report.aggregatedSessions).toEqual([SESSION_ID]);
    expect(report.text).toContain(`cost (${SESSION_ID}):`);
    expect(report.text).toContain("== cost summary (1 session(s)) ==");
  });
});
