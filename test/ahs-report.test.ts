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

describe("ahs-report Task view (ADR-0005 §5)", () => {
  const T1 = "2026-07-20T10:00:00.000Z";
  const T2 = "2026-07-20T11:00:00.000Z";

  // A root session whose abandoned tail is cut by a fork (the group HEAD).
  const forkRoot = makeSession("task-root", [
    userMessage(0, "build it", { timestamp: T1 }),
    assistantMessage(1, "first attempt", {
      timestamp: T1,
      usage: { inputTokens: 100, outputTokens: 10 },
    }),
    assistantMessage(2, "abandoned direction", {
      timestamp: T1,
      usage: { inputTokens: 50, outputTokens: 5 },
    }),
  ]);
  const fork = makeSession(
    "task-fork",
    [
      userMessage(0, "new direction", { timestamp: T2 }),
      assistantMessage(1, "fork work", {
        timestamp: T2,
        usage: { inputTokens: 30, outputTokens: 3 },
      }),
    ],
    { lineage: { type: "forked_from", sessionId: "task-root", atRecordId: "r1" } },
  );

  it("renders the HEAD chain: stitched prefix + fork suffix, abandoning the cut tail", async () => {
    const outDir = path.join(tmp, "task-view");
    await exportSessions(fakeAdapter([forkRoot, fork]), outDir);

    // Invoking with ANY group member resolves the same group + HEAD.
    const report = await renderReport(outDir, "task-root");
    // groupId is the lexicographically smallest member (deterministic).
    expect(report.groupId).toBe("task-fork");
    expect(report.headSessionId).toBe("task-fork");

    // One continuous transcript: root prefix up to the anchor, fork suffix.
    expect(report.text).toContain("# task-root");
    expect(report.text).toContain("(shared prefix, stitched)");
    expect(report.text).toContain("# task-fork");
    expect(report.text).toContain("(task HEAD)");
    expect(report.text).toContain("first attempt");
    expect(report.text).toContain("new direction");
    expect(report.text).toContain("fork work");
    // The root's abandoned post-anchor records are NOT rendered.
    expect(report.text).not.toContain("abandoned direction");
    // The fork's records render after the root prefix.
    expect(report.text.indexOf("first attempt")).toBeLessThan(report.text.indexOf("new direction"));

    // Aggregation = rendered slices only: root prefix (100/10) + fork
    // suffix (30/3). The abandoned tail (50/5) is excluded — no prefix
    // double-count, no abandoned-branch count.
    expect(report.aggregatedSessions).toEqual(["task-root", "task-fork"]);
    expect(report.totalUsage).toMatchObject({ inputTokens: 130, outputTokens: 13 });
    expect(report.text).toContain("input=130");
  });

  it("--all lists the group's fork/attempt sessions as alternates, not stitched", async () => {
    const outDir = path.join(tmp, "task-view-all");
    await exportSessions(fakeAdapter([forkRoot, fork]), outDir);

    const report = await renderReport(outDir, "task-fork", { all: true });
    expect(report.alternates).toEqual(["task-fork", "task-root"]);
    expect(report.text).toContain("== alternate versions (group task-fork) ==");
    expect(report.text).toContain("HEAD: task-fork");
    expect(report.text).toContain("- task-fork (HEAD) forked_from task-root @ r1");
    expect(report.text).toContain("- task-root (group root)");
    // Alternates are listed, not stitched: the transcript part is unchanged.
    expect(report.text).not.toContain("abandoned direction");

    // Without --all there is no alternate-versions section.
    const plain = await renderReport(outDir, "task-fork");
    expect(plain.text).not.toContain("alternate versions");
  });

  it("retry-from-start (no atRecordId) renders only the fork — the parent contributes nothing", async () => {
    const base = makeSession("base", [
      userMessage(0, "the prompt", { timestamp: T1, usage: { inputTokens: 3 } }),
    ]);
    const retry = makeSession(
      "retry",
      [
        userMessage(0, "the prompt", { timestamp: T2 }),
        assistantMessage(1, "retry answer", { timestamp: T2, usage: { inputTokens: 8 } }),
      ],
      { lineage: { type: "sibling_attempt", sessionId: "base" } },
    );
    const outDir = path.join(tmp, "retry-from-start");
    await exportSessions(fakeAdapter([base, retry]), outDir);

    const report = await renderReport(outDir, "base");
    expect(report.headSessionId).toBe("retry");
    expect(report.text).not.toContain("# base");
    expect(report.text).toContain("# retry");
    // The fork carries its own prompt copy: exactly one "[user] the prompt".
    expect(report.text.split("[user] the prompt")).toHaveLength(2);
    // Only the fork's suffix is aggregated.
    expect(report.aggregatedSessions).toEqual(["retry"]);
    expect(report.totalUsage).toMatchObject({ inputTokens: 8 });
  });

  it("fork-of-subagent: the fork inherits the invocation via the closure and renders once", async () => {
    const parent = makeSession("p", [
      userMessage(0, "top task", { timestamp: T1 }),
      toolCall(1, "tc-task", { name: "Task", status: "completed", recordId: "p-call" }),
      toolResult(2, "tc-task", "sub done", { sessionIds: ["s"], timestamp: T1 }),
      assistantMessage(3, "done", { timestamp: T1, usage: { inputTokens: 10, outputTokens: 1 } }),
    ]);
    const sub = makeSession(
      "s",
      [
        userMessage(0, "subtask", { timestamp: T1 }),
        assistantMessage(1, "sub answer", {
          recordId: "s-r1",
          timestamp: T1,
          usage: { inputTokens: 7, outputTokens: 2 },
        }),
      ],
      { invocation: { sessionId: "p", atRecordId: "p-call" } },
    );
    // Fork of the sub-agent: lineage only, invocation inherited (ADR-0005 §2).
    const subFork = makeSession(
      "s-fork",
      [assistantMessage(0, "fork retry", { timestamp: T2, usage: { inputTokens: 5, outputTokens: 1 } })],
      { lineage: { type: "forked_from", sessionId: "s", atRecordId: "s-r1" } },
    );
    const outDir = path.join(tmp, "fork-of-subagent");
    await exportSessions(fakeAdapter([parent, sub, subFork]), outDir);

    const report = await renderReport(outDir, "p");
    // The sub-agent's group renders ONCE, indented after the anchoring
    // Task tool_call; the fork is the group HEAD and its suffix is stitched.
    expect(report.text.match(/# s /g)).toHaveLength(1);
    expect(report.text).toContain("sub answer");
    expect(report.text).toContain("fork retry");
    expect(report.text).not.toContain("cycle detected");
    const anchorIndex = report.text.indexOf("→ Task(");
    expect(report.text.indexOf("  # s ")).toBeGreaterThan(anchorIndex);

    // Each session aggregated exactly once (suffix-only): 10+7+5 / 1+2+1.
    expect(report.aggregatedSessions.sort()).toEqual(["p", "s", "s-fork"]);
    expect(report.totalUsage).toMatchObject({ inputTokens: 22, outputTokens: 4 });
  });
});
