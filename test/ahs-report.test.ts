/**
 * AC-0004-N-1: the report consumer reads ONLY an AHS archive, renders the
 * child session indented under its anchoring tool_call, and aggregates
 * Usage across the invocation graph exactly (parent + child sums).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { exportSessions } from "../src/ahs/writer";
import { renderReport } from "../examples/ahs-report";
import type { Usage } from "../src/schema/usage";
import {
  assistantMessage,
  fakeAdapter,
  makeSession,
  toolCall,
  toolResult,
  userMessage,
} from "./builders";

const tmp = mkdtempSync(path.join(tmpdir(), "ahs-report-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PARENT_USAGE: Usage = { inputTokens: 100, outputTokens: 40, durationMs: 500 };
const PARENT_USAGE_2: Usage = { inputTokens: 20, outputTokens: 10 };
const CHILD_USAGE: Usage = {
  inputTokens: 7,
  outputTokens: 3,
  reasoningTokens: 2,
  cost: { amount: 0.01, currency: "USD" },
};

const parent = makeSession("sess-parent", [
  userMessage(0, "build the feature"),
  assistantMessage(1, "delegating", { usage: PARENT_USAGE }),
  toolCall(2, "tc-task", { name: "Task", status: "completed", recordId: "p-call" }),
  toolResult(3, "tc-task", "child finished", { sessionId: "sess-child" }),
  assistantMessage(4, "all done", { usage: PARENT_USAGE_2 }),
]);
const child = makeSession(
  "sess-child",
  [
    userMessage(0, "subtask instructions"),
    assistantMessage(1, "child working", { usage: CHILD_USAGE }),
  ],
  { invocation: { sessionId: "sess-parent", atRecordId: "p-call" } },
);

describe("ahs-report (AC-0004-N-1)", () => {
  it("renders parent + anchored child from the archive alone, aggregating usage exactly", async () => {
    // Export through the writer's adapter-facing API, then FORGET the
    // adapter: the report reads only the archive directory.
    const outDir = path.join(tmp, "report");
    await exportSessions(fakeAdapter([parent, child]), outDir);

    const report = await renderReport(outDir, "sess-parent");

    // Both sessions rendered; child header appears indented, right after
    // the anchoring Task tool_call.
    expect(report.text).toContain("# sess-parent");
    const anchorIndex = report.text.indexOf("→ Task(");
    const childIndex = report.text.indexOf("  # sess-child");
    expect(anchorIndex).toBeGreaterThan(-1);
    expect(childIndex).toBeGreaterThan(anchorIndex);
    // Child content is present.
    expect(report.text).toContain("subtask instructions");
    expect(report.text).toContain("child working");

    // Aggregated usage = parent + child record usage, summed exactly.
    expect(report.aggregatedSessions.sort()).toEqual(["sess-child", "sess-parent"]);
    expect(report.totalUsage).toMatchObject({
      inputTokens: 127, // 100 + 20 + 7
      outputTokens: 53, // 40 + 10 + 3
      reasoningTokens: 2,
      durationMs: 500,
    });
    expect(report.totalCost.get("USD")).toBe(0.01);
    expect(report.text).toContain("input=127");
    expect(report.text).toContain("output=53");
    expect(report.text).toContain("cost=0.01 USD");
    // Per-session breakdown lines exist for both sessions.
    expect(report.text).toContain("cost (sess-parent):");
    expect(report.text).toContain("cost (sess-child):");
  });

  it("cuts cycles in the relation graph defensively", async () => {
    // Hand-build a tiny archive with A invoked by B and B invoked by A.
    const cycleRoot = mkdtempSync(path.join(tmpdir(), "ahs-report-cycle-"));
    afterAll(() => rmSync(cycleRoot, { recursive: true, force: true }));
    const base = {
      harness: "fake",
      harnessVersion: "0",
      ahsVersion: "0.1.0",
      cwd: "/tmp",
      model: "m",
    };
    for (const [id, parentId] of [
      ["sess-a", "sess-b"],
      ["sess-b", "sess-a"],
    ] as const) {
      const dir = path.join(cycleRoot, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          ...base,
          sessionId: id,
          invocation: { sessionId: parentId },
        }),
      );
      writeFileSync(
        path.join(dir, "records.jsonl"),
        `${JSON.stringify({
          recordId: `${id}-0`,
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
