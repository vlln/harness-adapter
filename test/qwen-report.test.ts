/**
 * AC-0004-N-1 (usability): the Qwen Code adapter output, exported to an AHS
 * archive, is consumable by examples/ahs-report — the transcript renders the
 * full conversation (thinking collapsed, tool calls inline) and the
 * aggregated token totals equal the record-level sums exactly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { QwenCodeAdapter } from "../src/adapters/qwen/index";
import { exportSessions } from "../src/ahs/writer";
import { renderReport } from "../examples/ahs-report";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "qwen",
);
const SESSION_B = "b2222222-2222-4222-8222-222222222222";

const tmp = mkdtempSync(path.join(tmpdir(), "qwen-report-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("qwen archive + ahs-report (AC-0004-N-1)", () => {
  it("renders the transcript with tool calls and aggregates usage exactly", async () => {
    const outDir = path.join(tmp, "archive");
    const adapter = new QwenCodeAdapter(fixturesDir);
    await exportSessions(adapter, outDir);

    const report = await renderReport(outDir, SESSION_B);

    // Transcript: user prompt, thinking collapsed, tool calls + results.
    expect(report.text).toContain(`# ${SESSION_B} [qwen-code · deepseek-v4-flash]`);
    expect(report.text).toContain("[user] Refactor the parser for nested generics");
    expect(report.text).toContain("[thinking 39 chars]");
    expect(report.text).toContain("→ Grep(");
    expect(report.text).toContain("⤷");
    expect(report.text).toContain("→ Bash(");
    expect(report.text).toContain("(interrupted)");

    // Aggregation = record-level sums over the rendered records, exact:
    // bb000002: 5200/48/300/12 + bb000006: 6100/22/0/5.
    expect(report.aggregatedSessions).toEqual([SESSION_B]);
    expect(report.totalUsage).toMatchObject({
      inputTokens: 11300,
      outputTokens: 70,
      cacheReadTokens: 300,
      reasoningTokens: 17,
    });
    expect(report.text).toContain("input=11300");
    expect(report.text).toContain("reasoning=17");
    expect(report.text).toContain(`cost (${SESSION_B}):`);
  });
});
