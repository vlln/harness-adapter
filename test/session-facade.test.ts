/**
 * Session Facade (interface-0003) contract-point tests, built from
 * test/builders.ts hand-made sessions (fakeAdapter — the facade reads only
 * the adapter substrate, never native storage).
 *
 * Coverage: projection mapping table row by row, XOR tool pairing,
 * interrupted → tool item without result, state records → events(),
 * usage sums, children() recursion + silent skip of undiscoverable
 * children, Task intra-session HEAD chain stitching (prefix cut /
 * null parentRecordId / chained branches), SessionNotFoundError,
 * openHarness registry.
 */

import { describe, expect, it } from "vitest";

import {
  createFacade,
  openHarness,
  projectMessages,
  SessionNotFoundError,
  type ConversationItem,
} from "../src/session/index";
import type { SessionData } from "../src/validate/index";
import {
  assistantMessage,
  fakeAdapter,
  makeSession,
  toolCall,
  toolResult,
  userMessage,
} from "./builders";

const T1 = "2026-07-20T10:00:00.000Z";
const T2 = "2026-07-20T11:00:00.000Z";
const T3 = "2026-07-20T12:00:00.000Z";

function kinds(items: ConversationItem[]): string[] {
  return items.map((i) => i.kind);
}

describe("openHarness registry (interface-0003 入口)", () => {
  it("opens all four registered harnesses", () => {
    for (const name of ["claude-code", "codex", "kimi-code", "devin"] as const) {
      const facade = openHarness(name, { basePath: "/tmp/no-such-store" });
      expect(facade.adapter.harness).toBe(name);
    }
    // basePath is optional (each adapter has its own default).
    expect(openHarness("devin").adapter.harness).toBe("devin");
  });

  it("rejects an unknown harness name", () => {
    // @ts-expect-error runtime validation of a bad name
    expect(() => openHarness("grok")).toThrow("unknown harness");
  });

  it("listSessions passes through to the adapter", async () => {
    const facade = createFacade(fakeAdapter([makeSession("s1"), makeSession("s2")]));
    const ids: string[] = [];
    for await (const m of facade.listSessions()) ids.push(m.sessionId);
    expect(ids).toEqual(["s1", "s2"]);
  });
});

describe("AhsSession (存储视角)", () => {
  const session = makeSession("root", [
    userMessage(0, "build it", { timestamp: T1 }),
    assistantMessage(1, "working", { timestamp: T1, usage: { inputTokens: 100, outputTokens: 10 } }),
    toolCall(2, "tc-1", { name: "Bash", status: "completed", timestamp: T1 }),
    toolResult(3, "tc-1", "done", { sessionIds: ["sub"], timestamp: T1 }),
    toolCall(4, "tc-2", { name: "Edit", status: "interrupted", timestamp: T1 }),
    { ...userMessage(0, "ignored"), seq: 5, recordId: "r5", type: "harness_message" } as never,
    {
      recordId: "r6",
      seq: 6,
      timestamp: T1,
      type: "turn_boundary",
      phase: "start",
    } as never,
    {
      recordId: "r7",
      seq: 7,
      timestamp: T1,
      type: "turn_boundary",
      phase: "end",
    } as never,
    { recordId: "r8", seq: 8, timestamp: T1, type: "model_change", model: "m2" } as never,
    { recordId: "r9", seq: 9, timestamp: T1, type: "compaction", summary: "s" } as never,
    { recordId: "r10", seq: 10, timestamp: T1, type: "goal_update", status: "met" } as never,
  ]);
  const facade = createFacade(fakeAdapter([session]));

  it("messages() projects the mapping table row by row, in seq order", async () => {
    const s = await facade.loadSession("root");
    expect(s.manifest.sessionId).toBe("root");
    const items = s.messages();
    expect(kinds(items)).toEqual(["user", "assistant", "tool", "tool", "harness"]);
    // user / harness carry content; assistant carries blocks.
    expect(items[0]).toMatchObject({ kind: "user", timestamp: T1 });
    expect(items[4]).toMatchObject({ kind: "harness", timestamp: T1 });
    // Paired tool item: call {name, args}, result {content, status}, sessionIds.
    expect(items[2]).toMatchObject({
      kind: "tool",
      call: { name: "Bash" },
      result: { content: "done" },
      status: "completed",
      sessionIds: ["sub"],
    });
    // Interrupted tool item: NO result (XOR pairing).
    expect(items[3]).toMatchObject({ kind: "tool", call: { name: "Edit" }, status: "interrupted" });
    expect(items[3]).not.toHaveProperty("result");
  });

  it("events() exposes state records in seq order; none leak into messages()", async () => {
    const s = await facade.loadSession("root");
    expect(s.events().map((e) => `${e.type}${e.type === "turn_boundary" ? `:${e.phase}` : ""}`)).toEqual([
      "turn_boundary:start",
      "turn_boundary:end",
      "model_change",
      "compaction",
      "goal_update",
    ]);
    expect(s.messages().some((i) => i.kind !== "user" && i.kind !== "assistant" && i.kind !== "tool" && i.kind !== "harness")).toBe(false);
  });

  it("usage sums the session's own records", async () => {
    const s = await facade.loadSession("root");
    expect(s.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it("loadSession throws SessionNotFoundError for an unknown id", async () => {
    const err = await facade.loadSession("ghost").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionNotFoundError);
    expect((err as SessionNotFoundError).sessionId).toBe("ghost");
  });
});

describe("tool pairing edge cases (projection-internal, XOR)", () => {
  it("pairs with the FIRST result in seq order; drops unpaired results defensively", () => {
    const items = projectMessages([
      toolCall(0, "tc", { name: "Bash" }),
      toolResult(1, "tc", "first"),
      toolResult(2, "tc", "second"),
      toolResult(3, "orphan", "no call for this"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", result: { content: "first" } });
  });
});

describe("children() (invocation 直接子 session)", () => {
  // root → sub (back-link) + sub → grand (forward link in sub's records);
  // root also forward-links "ghost-child", which is not in the store.
  const root = makeSession("root", [
    userMessage(0, "go", { timestamp: T1 }),
    toolCall(1, "tc-1", { name: "Task", status: "completed", recordId: "root-call", timestamp: T1 }),
    toolResult(2, "tc-1", "sub done", { sessionIds: ["sub", "ghost-child"], timestamp: T1 }),
  ]);
  const sub = makeSession(
    "sub",
    [
      userMessage(0, "subtask", { timestamp: T1 }),
      toolCall(1, "tc-2", { name: "Task", status: "completed", timestamp: T1 }),
      toolResult(2, "tc-2", "grand done", { sessionIds: ["grand"], timestamp: T1 }),
    ],
    { invocation: { sessionId: "root", atRecordId: "root-call" } },
  );
  const grand = makeSession("grand", [userMessage(0, "grand task", { timestamp: T1 })], {
    invocation: { sessionId: "sub" },
  });
  const facade = createFacade(fakeAdapter([root, sub, grand]));

  it("returns direct children (back-link + forward link) and recurses", async () => {
    const rootView = await facade.loadSession("root");
    const children = await rootView.children();
    expect(children.map((c) => c.manifest.sessionId)).toEqual(["sub"]);
    const grandChildren = await children[0]!.children();
    expect(grandChildren.map((c) => c.manifest.sessionId)).toEqual(["grand"]);
    expect(await grandChildren[0]!.children()).toEqual([]);
  });

  it("skips undiscoverable children silently (forward link to a session not in the store)", async () => {
    const rootView = await facade.loadSession("root");
    // "ghost-child" is forward-linked but not listed by the store — skipped, no throw.
    const children = await rootView.children();
    expect(children.map((c) => c.manifest.sessionId)).not.toContain("ghost-child");
  });
});

describe("AhsTask (用户视角：intra-session HEAD chain stitching)", () => {
  it("stitches the HEAD chain: parent prefix cut at parentRecordId + fork suffix, no duplicated prefix", async () => {
    // A session with two branches: main (base) and fork-1 (forked from main at r1)
    const session = makeSession(
      "sess-1",
      [
        userMessage(0, "build it", { timestamp: T1, recordId: "r0" }),
        assistantMessage(1, "first attempt", { timestamp: T1, recordId: "r1" }),
        assistantMessage(2, "abandoned direction", { timestamp: T1, recordId: "r2" }),
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
          assistantMessage(1, "fork work", { timestamp: T2, recordId: "r4" }),
        ],
      },
    );
    const facade = createFacade(fakeAdapter([session]));

    const task = await facade.loadTask("sess-1");
    expect(task.sessionId).toBe("sess-1");
    expect(task.branches).toEqual(["fork-1", "main"]);
    expect(task.head.manifest.sessionId).toBe("sess-1");

    const items = task.messages();
    expect(kinds(items)).toEqual(["user", "assistant", "user", "assistant"]);
    const texts = items.map((i) =>
      i.kind === "tool" ? "" : i.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    );
    expect(texts).toEqual(["build it", "first attempt", "new direction", "fork work"]);
    // Prefix not duplicated; abandoned tail past the anchor not rendered.
    expect(texts.filter((t) => t === "build it")).toHaveLength(1);
    expect(texts).not.toContain("abandoned direction");
  });

  it("null parentRecordId: the parent branch slice is kept in full", async () => {
    const session = makeSession(
      "sess-1",
      [
        userMessage(0, "build it", { timestamp: T1, recordId: "r0" }),
        assistantMessage(1, "work", { timestamp: T1, recordId: "r1" }),
      ],
      {
        branches: {
          main: { parentBranch: null, parentRecordId: null },
          "fork-1": { parentBranch: "main", parentRecordId: null },
        },
        HEAD: { branch: "fork-1", recordId: "r3" },
      },
      {
        "fork-1": [
          userMessage(0, "continued", { timestamp: T2, recordId: "r2" }),
          assistantMessage(1, "more work", { timestamp: T2, recordId: "r3" }),
        ],
      },
    );
    const facade = createFacade(fakeAdapter([session]));
    const task = await facade.loadTask("sess-1");
    const texts = task.messages().map((i) =>
      i.kind === "tool" ? "" : i.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    );
    expect(texts).toEqual(["build it", "work", "continued", "more work"]);
  });

  it("chained branches (main → fork-1 → fork-2): each segment cut at the next segment's anchor", async () => {
    const session = makeSession(
      "sess-1",
      [
        userMessage(0, "a0", { timestamp: T1, recordId: "ra0" }),
        assistantMessage(1, "a1", { timestamp: T1, recordId: "ra1" }),
      ],
      {
        branches: {
          main: { parentBranch: null, parentRecordId: null },
          "fork-1": { parentBranch: "main", parentRecordId: "ra1" },
          "fork-2": { parentBranch: "fork-1", parentRecordId: "rb1" },
        },
        HEAD: { branch: "fork-2", recordId: "rc0" },
      },
      {
        "fork-1": [
          userMessage(0, "b0", { timestamp: T2, recordId: "rb0" }),
          assistantMessage(1, "b1", { timestamp: T2, recordId: "rb1" }),
          assistantMessage(2, "b2 abandoned", { timestamp: T2, recordId: "rb2" }),
        ],
        "fork-2": [
          userMessage(0, "c0", { timestamp: T3, recordId: "rc0" }),
        ],
      },
    );
    const facade = createFacade(fakeAdapter([session]));
    const task = await facade.loadTask("sess-1");
    expect(task.branches).toEqual(["fork-1", "fork-2", "main"]);
    const texts = task.messages().map((i) =>
      i.kind === "tool" ? "" : i.content.map((b2) => (b2.type === "text" ? b2.text : "")).join(""),
    );
    expect(texts).toEqual(["a0", "a1", "b0", "b1", "c0"]);
  });

  it("loadTask throws SessionNotFoundError for an unknown id", async () => {
    const facade = createFacade(fakeAdapter([makeSession("s1")]));
    await expect(facade.loadTask("ghost")).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
