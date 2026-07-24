/**
 * AC-0004-N-1 (usability): the Pi adapter output, exported to an AHS
 * archive, is consumable by examples/ahs-report — the transcript renders
 * (model_change state lines, tool calls, fork folding) and token/cost
 * totals aggregate exactly over the rendered slices. Pi is the only
 * harness with cost data, so the cost aggregation path is exercised here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { PiAdapter } from "../src/adapters/pi/index";
import { exportSessions } from "../src/ahs/writer";
import { renderReport } from "../examples/ahs-report";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pi",
);
const SESSION_B = "019f4000-bbbb-7000-8000-0000000000b2";
const SESSION_C = "019f4000-cccc-7000-8000-0000000000c3";
const FORK_EDIT = `${SESSION_C}/fork/cc000005`;
const FORK_RETRY = `${SESSION_C}/fork/cc00000a`;

const tmp = mkdtempSync(path.join(tmpdir(), "pi-report-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pi archive + ahs-report (AC-0004-N-1)", () => {
  it("renders fixture B with state/tool lines and aggregates usage + cost exactly", async () => {
    const outDir = path.join(tmp, "archive");
    const adapter = new PiAdapter(fixturesDir);
    await exportSessions(adapter, outDir);

    const report = await renderReport(outDir, SESSION_B);

    expect(report.text).toContain(`# ${SESSION_B} [pi · DeepSeek-V4-Flash]`);
    expect(report.text).toContain("─ model change → DeepSeek-V4-Flash");
    expect(report.text).toContain("─ model change → grok-4.5");
    expect(report.text).toContain("→ bash(");
    expect(report.text).toContain("⤷ 12 tests passed");
    expect(report.text).toContain("⤷ error: Error: ENOENT");
    expect(report.text).toContain("Tests pass; the config file is missing.");

    // Aggregation = the session's own records, exact (the zero-usage error
    // message contributes nothing).
    expect(report.aggregatedSessions).toEqual([SESSION_B]);
    expect(report.totalUsage).toMatchObject({
      inputTokens: 3100,
      outputTokens: 160,
      cacheReadTokens: 100,
      cacheWriteTokens: 300,
      reasoningTokens: 64,
    });
    // Pi is the cost benchmark: 0.0016 + 0.0035 USD over the two assistants.
    expect(report.totalCost.get("USD")).toBeCloseTo(0.0051, 10);
    expect(report.text).toContain("cost=0.0051 USD");
  });

  it("folds forks into the HEAD chain view; --all lists them as alternates", async () => {
    const outDir = path.join(tmp, "archive");
    const report = await renderReport(outDir, SESSION_C, { all: true });

    // HEAD = main chain (last leaf): edited resend + latest retry answer.
    expect(report.headSessionId).toBe(SESSION_C);
    expect(report.aggregatedSessions).toEqual([SESSION_C]);
    expect(report.text).toContain("edited follow-up");
    expect(report.text).toContain("new answer to the retry");
    expect(report.text).not.toContain("original follow-up");
    expect(report.text).not.toContain("old answer to the retry");

    // Fork usage is NOT aggregated into the HEAD chain (no double-count).
    // main: input 100+160+180, output 10+16+18
    expect(report.totalUsage).toMatchObject({ inputTokens: 440, outputTokens: 44 });

    expect(report.alternates.sort()).toEqual([SESSION_C, FORK_EDIT, FORK_RETRY].sort());
    expect(report.text).toContain("== alternate versions");
    expect(report.text).toContain(FORK_EDIT);
    expect(report.text).toContain(FORK_RETRY);
  });
});
