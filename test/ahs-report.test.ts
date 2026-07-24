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
  toolResult(3, "tc-task", "child finished", { sessionIds: ["sess-child"] }),
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
      mkdirSync(path.join(dir, "records"), { recursive: true });
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          ...base,
          sessionId: id,
          invocation: { sessionId: parentId },
          branches: { main: { parentBranch: null, parentRecordId: null } },
          HEAD: { branch: "main", recordId: `${id}-0` },
        }),
      );
      writeFileSync(
        path.join(dir, "records", "main.jsonl"),
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

describe("ahs-report Task view (ADR-0006 intra-session branches)", () => {
  const T1 = "2026-07-20T10:00:00.000Z";
  const T2 = "2026-07-20T11:00:00.000Z";

  // A session with two branches: main (base) and fork-1 (forked from main at r1).
  // The fork picks up from the anchor and adds its own suffix.
  const session = makeSession(
    "task-sess",
    [
      userMessage(0, "build it", { timestamp: T1, recordId: "r0" }),
      assistantMessage(1, "first attempt", {
        timestamp: T1,
        recordId: "r1",
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
      assistantMessage(2, "abandoned direction", {
        timestamp: T1,
        recordId: "r2",
        usage: { inputTokens: 50, outputTokens: 5 },
      }),
    ],
    {
      branches: {
        main: { parentBranch: null, parentRecordId: null },
        "fork-1": { parentBranch: "main", parentRecordId: "r1" },
      },
      HEAD: { branch: "fork-1", recordId: "r4" },
    },
    {
      "fork-1": [
        userMessage(0, "new direction", { timestamp: T2, recordId: "r3" }),
        assistantMessage(1, "fork work", {
          timestamp: T2,
          recordId: "r4",
          usage: { inputTokens: 30, outputTokens: 3 },
        }),
      ],
    },
  );

  it("renders the HEAD chain: stitched prefix + fork suffix, abandoning the cut tail", async () => {
    const outDir = path.join(tmp, "task-view");
    await exportSessions(fakeAdapter([session]), outDir);

    const report = await renderReport(outDir, "task-sess");

    // One continuous transcript: root prefix up to the anchor, fork suffix.
    expect(report.text).toContain("# task-sess");
    expect(report.text).toContain("(shared prefix, stitched)");
    expect(report.text).toContain("(task HEAD)");
    expect(report.text).toContain("first attempt");
    expect(report.text).toContain("new direction");
    expect(report.text).toContain("fork work");
    // The abandoned post-anchor records are NOT rendered.
    expect(report.text).not.toContain("abandoned direction");
    // The fork's records render after the root prefix.
    expect(report.text.indexOf("first attempt")).toBeLessThan(report.text.indexOf("new direction"));

    // Aggregation = rendered slices only: main prefix (100/10) + fork suffix (30/3).
    // The abandoned tail (50/5) is excluded.
    expect(report.aggregatedSessions).toEqual(["task-sess"]);
    expect(report.totalUsage).toMatchObject({ inputTokens: 130, outputTokens: 13 });
    expect(report.text).toContain("input=130");
  });

  it("--all lists the session's branches as alternates, not stitched", async () => {
    const outDir = path.join(tmp, "task-view-all");
    await exportSessions(fakeAdapter([session]), outDir);

    const report = await renderReport(outDir, "task-sess", { all: true });
    expect(report.alternates).toEqual(["fork-1", "main"]);
    expect(report.text).toContain("== alternate versions");
    expect(report.text).toContain("HEAD: fork-1");

    // Without --all there is no alternate-versions section.
    const plain = await renderReport(outDir, "task-sess");
    expect(plain.text).not.toContain("alternate versions");
  });

  it("fork-of-subagent: the fork inherits the invocation and renders once", async () => {
    const parent = makeSession("p", [
      userMessage(0, "top task", { timestamp: T1, recordId: "p0" }),
      toolCall(1, "tc-task", { name: "Task", status: "completed", recordId: "p-call" }),
      toolResult(2, "tc-task", "sub done", { sessionIds: ["s"], timestamp: T1, recordId: "p-result" }),
      assistantMessage(3, "done", { timestamp: T1, recordId: "p3", usage: { inputTokens: 10, outputTokens: 1 } }),
    ]);
    const sub = makeSession(
      "s",
      [
        userMessage(0, "subtask", { timestamp: T1, recordId: "s0" }),
        assistantMessage(1, "sub answer", {
          recordId: "s-r1",
          timestamp: T1,
          usage: { inputTokens: 7, outputTokens: 2 },
        }),
      ],
      { invocation: { sessionId: "p", atRecordId: "p-call" } },
    );
    // Fork of the sub-agent: runs within the same session, different branch.
    const subFork = makeSession(
      "s",
      [
        userMessage(0, "subtask", { timestamp: T1, recordId: "s0" }),
        assistantMessage(1, "sub answer", {
          recordId: "s-r1",
          timestamp: T1,
          usage: { inputTokens: 7, outputTokens: 2 },
        }),
      ],
      {
        invocation: { sessionId: "p", atRecordId: "p-call" },
        branches: {
          main: { parentBranch: null, parentRecordId: null },
          "fork-1": { parentBranch: "main", parentRecordId: "s-r1" },
        },
        HEAD: { branch: "fork-1", recordId: "sf2" },
      },
      {
        "fork-1": [
          assistantMessage(0, "fork retry", { timestamp: T2, recordId: "sf2", usage: { inputTokens: 5, outputTokens: 1 } }),
        ],
      },
    );
    const outDir = path.join(tmp, "fork-of-subagent");
    await exportSessions(fakeAdapter([parent, subFork]), outDir);

    const report = await renderReport(outDir, "p");
    // The sub-agent renders with a header per branch segment
    const headerCount = (report.text.match(/# s /g) ?? []).length;
    expect(headerCount).toBeGreaterThanOrEqual(1);
    expect(report.text).toContain("sub answer");
    expect(report.text).toContain("fork retry");
    expect(report.text).not.toContain("cycle detected");
    const anchorIndex = report.text.indexOf("→ Task(");
    expect(report.text.indexOf("  # s ")).toBeGreaterThan(anchorIndex);

    // Each session aggregated exactly once.
    expect(report.aggregatedSessions.sort()).toEqual(["p", "s"]);
    expect(report.totalUsage).toMatchObject({ inputTokens: 22, outputTokens: 4 });
  });
});
