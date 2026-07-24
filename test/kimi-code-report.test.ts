import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { KimiCodeAdapter } from "../src/adapters/kimi-code/index";
import { exportSessions } from "../src/ahs/writer";
import { renderReport } from "../examples/ahs-report";
import { collectSessions } from "../src/validate/index";
import type { AhsRecord } from "../src/schema/record";
import type { Usage } from "../src/schema/usage";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "kimi-code",
);

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const CHILD_ID = `${SESSION_ID}/agent-0`;

const tmp = mkdtempSync(path.join(tmpdir(), "kimi-report-test-"));
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

describe("kimi-code archive + ahs-report (AC layer-4, AC-0004-N-1)", () => {
  it("renders parent + unanchored child from the archive alone, with correct aggregated usage", async () => {
    // Export the kimi-code fixtures, then FORGET the adapter: the report
    // reads only the archive directory.
    const adapter = new KimiCodeAdapter(fixturesDir);
    const direct = await collectSessions(adapter);
    const results = await exportSessions(adapter, tmp);
    expect(results).toHaveLength(2);

    const report = await renderReport(tmp, SESSION_ID);

    // Parent and child are both rendered. The child has NO toolCallId anchor
    // (AC-0002-B-3), so it renders indented after the parent's records.
    expect(report.text).toContain(`# ${SESSION_ID}`);
    expect(report.text).toContain(`  # ${CHILD_ID}`);
    const parentIndex = report.text.indexOf(`# ${SESSION_ID}`);
    const childIndex = report.text.indexOf(`  # ${CHILD_ID}`);
    expect(parentIndex).toBeGreaterThan(-1);
    expect(childIndex).toBeGreaterThan(parentIndex);
    // Transcript content is readable: user text, thinking collapse, tool
    // rendering, state events, and the plan-document tail.
    expect(report.text).toContain("[user] 修复登录页空指针");
    expect(report.text).toContain("[thinking");
    expect(report.text).toContain("→ Grep(");
    expect(report.text).toContain("(interrupted)");
    expect(report.text).toContain("─ goal pending: 完成登录页修复并验证");
    expect(report.text).toContain("─ goal met");
    expect(report.text).toContain("─ compaction");
    expect(report.text).toContain("# Plan: 修复登录页空指针");

    // Aggregated usage = parent + child record usage (AC-0004: 总代价口径),
    // matching the source turn-scope usage totals exactly.
    const expected = sumUsage(
      direct.filter((s) => [SESSION_ID, CHILD_ID].includes(s.manifest.sessionId)),
    );
    expect(expected).toEqual({
      inputTokens: 1400,
      outputTokens: 110,
      cacheReadTokens: 150,
      cacheWriteTokens: 5,
    });
    expect(report.aggregatedSessions.sort()).toEqual([CHILD_ID, SESSION_ID].sort());
    expect(report.totalUsage).toMatchObject(expected);
    expect(report.text).toContain(`input=${expected.inputTokens}`);
    expect(report.text).toContain(`output=${expected.outputTokens}`);
    // Per-session breakdown lines exist for both sessions.
    expect(report.text).toContain(`cost (${SESSION_ID}):`);
    expect(report.text).toContain(`cost (${CHILD_ID}):`);
  });
});
