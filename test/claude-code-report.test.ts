/**
 * AC-0004-N-1 (usability): the Claude Code adapter output, exported to an
 * AHS archive, is consumable by examples/ahs-report — the child session
 * renders under its anchoring Task tool_call and token totals aggregate
 * exactly across parent + spawned child.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index";
import { exportSessions } from "../src/ahs/writer";
import { renderReport } from "../examples/ahs-report";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "claude-code",
);
const SESSION_B = "22222222-2222-4222-8222-222222222222";

const tmp = mkdtempSync(path.join(tmpdir(), "claude-code-report-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("claude-code archive + ahs-report (AC-0004-N-1)", () => {
  it("renders the transcript with the spawned child and aggregates usage exactly", async () => {
    const outDir = path.join(tmp, "archive");
    const adapter = new ClaudeCodeAdapter(fixturesDir);
    await exportSessions(adapter, outDir);

    const report = await renderReport(outDir, SESSION_B);

    // Child session rendered inline after the anchoring Task tool_call.
    const anchorIndex = report.text.indexOf("→ Task(");
    const childIndex = report.text.indexOf("  # abc123");
    expect(anchorIndex).toBeGreaterThan(-1);
    expect(childIndex).toBeGreaterThan(anchorIndex);
    expect(report.text).toContain("Search the codebase for parser implementations");
    expect(report.text).toContain("Found 3 parser files");

    // Aggregation = main session usage + child session usage, exact.
    // main:  input 5000+7000, output 120+80, cacheRead 0+2000, cacheWrite 1000+0
    // child: input 900+1500, output 60+90, cacheRead 0+400,  cacheWrite 200+0
    expect(report.aggregatedSessions.sort()).toEqual([SESSION_B, "abc123"].sort());
    expect(report.totalUsage).toMatchObject({
      inputTokens: 14400,
      outputTokens: 350,
      cacheReadTokens: 2400,
      cacheWriteTokens: 1200,
    });
    expect(report.text).toContain("input=14400");
    expect(report.text).toContain(`cost (${SESSION_B}):`);
    expect(report.text).toContain("cost (abc123):");
  });
});
