/**
 * readManifest contract tests — AC-0001-N-2 (valid Manifest), AC-0001-E-2
 * (throws for unknown id), AC-0002-N-8 (consistent with listSessions).
 *
 * Contract-level tests use fakeAdapter; real-adapter tests verify
 * readManifest matches listSessions against existing fixtures for every
 * adapter that has static fixture directories.
 */

import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { ManifestSchema } from "../src/schema/manifest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code";
import { CodexAdapter } from "../src/adapters/codex";
import { GrokAdapter } from "../src/adapters/grok";
import { PiAdapter } from "../src/adapters/pi";
import { QwenCodeAdapter } from "../src/adapters/qwen";
import { KimiCodeAdapter } from "../src/adapters/kimi-code";
import { DevinAdapter } from "../src/adapters/devin";
import { createDevinFixture } from "./fixtures/devin-db";
import { fakeAdapter, makeSession, userMessage } from "./builders";
import type { Manifest } from "../src/schema/manifest";
import type { HarnessAdapter } from "../src/store/adapter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all manifests from listSessions into an array. */
async function listAllManifests(adapter: HarnessAdapter): Promise<Manifest[]> {
  const out: Manifest[] = [];
  for await (const m of adapter.listSessions({ includeForks: true })) out.push(m);
  return out;
}

/** Deep-compare two manifests field-by-field (JSON equality). */
function assertManifestEqual(a: Manifest, b: Manifest): void {
  expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
}

// ---------------------------------------------------------------------------
// Contract tests (fakeAdapter)
// ---------------------------------------------------------------------------

describe("readManifest contract (fakeAdapter)", () => {
  it("AC-0001-N-2: returns a valid Manifest (zod parse)", async () => {
    const adapter = fakeAdapter([makeSession("sess-1")]);
    const manifest = await adapter.readManifest("sess-1");
    expect(() => ManifestSchema.parse(manifest)).not.toThrow();
  });

  it("AC-0001-E-2: throws for non-existent sessionId", async () => {
    const adapter = fakeAdapter([makeSession("sess-1")]);
    await expect(adapter.readManifest("no-such-session")).rejects.toThrow("session not found");
  });

  it("AC-0002-N-8: readManifest result matches listSessions (field-by-field)", async () => {
    const sessions = [
      makeSession("sess-a", [userMessage("hello")]),
      makeSession("sess-b", [userMessage("world")]),
    ];
    const adapter = fakeAdapter(sessions);
    const listed = await listAllManifests(adapter);
    expect(listed).toHaveLength(2);
    for (const expected of listed) {
      const got = await adapter.readManifest(expected.sessionId);
      assertManifestEqual(got, expected);
    }
  });

});

// ---------------------------------------------------------------------------
// Real adapter tests — readManifest vs listSessions consistency
// ---------------------------------------------------------------------------

describe("readManifest vs listSessions — real adapters", () => {
  // Claude Code
  const ccFixtures = path.join(import.meta.dirname, "fixtures", "claude-code");
  const ccSession = "11111111-1111-4111-8111-111111111111";

  it("claude-code: readManifest matches listSessions", async () => {
    const adapter = new ClaudeCodeAdapter(ccFixtures);
    const listed = await listAllManifests(adapter);
    const target = listed.find((m) => m.sessionId === ccSession)!;
    const got = await adapter.readManifest(ccSession);
    assertManifestEqual(got, target);
  });

  it("claude-code: readManifest throws for unknown session", async () => {
    const adapter = new ClaudeCodeAdapter(ccFixtures);
    await expect(adapter.readManifest("no-such-session")).rejects.toThrow("session not found");
  });

  it("claude-code: readManifest finds subagent session (second-phase scan)", async () => {
    const adapter = new ClaudeCodeAdapter(ccFixtures);
    const listed = await listAllManifests(adapter);
    // "abc123" is a subagent child of SESSION_B — found via second-phase scan,
    // not the fast path (file named by id).
    const target = listed.find((m) => m.sessionId === "abc123")!;
    expect(target).toBeDefined();
    const got = await adapter.readManifest("abc123");
    assertManifestEqual(got, target);
  });

  // Grok
  const grokFixtures = path.join(import.meta.dirname, "fixtures", "grok", "sessions");
  const grokSession = "019f0000-0000-7000-8000-000000000001";

  it("grok: readManifest matches listSessions", async () => {
    const adapter = new GrokAdapter(grokFixtures);
    const listed = await listAllManifests(adapter);
    const target = listed.find((m) => m.sessionId === grokSession)!;
    const got = await adapter.readManifest(grokSession);
    assertManifestEqual(got, target);
  });

  it("grok: readManifest throws for unknown session", async () => {
    const adapter = new GrokAdapter(grokFixtures);
    await expect(adapter.readManifest("no-such-session")).rejects.toThrow("session not found");
  });

  // Pi
  const piFixtures = path.join(import.meta.dirname, "fixtures", "pi");
  const piSession = "019f4000-aaaa-7000-8000-0000000000a1";

  it("pi: readManifest matches listSessions", async () => {
    const adapter = new PiAdapter(piFixtures);
    const listed = await listAllManifests(adapter);
    const target = listed.find((m) => m.sessionId === piSession)!;
    const got = await adapter.readManifest(piSession);
    assertManifestEqual(got, target);
  });

  // Qwen
  const qwenFixtures = path.join(import.meta.dirname, "fixtures", "qwen");
  const qwenSession = "a1111111-1111-4111-8111-111111111111";

  it("qwen: readManifest matches listSessions", async () => {
    const adapter = new QwenCodeAdapter(qwenFixtures);
    const listed = await listAllManifests(adapter);
    const target = listed.find((m) => m.sessionId === qwenSession)!;
    const got = await adapter.readManifest(qwenSession);
    assertManifestEqual(got, target);
  });

  // Kimi Code
  const kimiFixtures = path.join(import.meta.dirname, "fixtures", "kimi-code");
  const kimiSession = "11111111-2222-4333-8444-555555555555";

  it("kimi-code: readManifest matches listSessions", async () => {
    const adapter = new KimiCodeAdapter(kimiFixtures);
    const listed = await listAllManifests(adapter);
    const target = listed.find((m) => m.sessionId === kimiSession)!;
    const got = await adapter.readManifest(kimiSession);
    assertManifestEqual(got, target);
  });

  it("kimi-code: readManifest finds subagent session", async () => {
    const adapter = new KimiCodeAdapter(kimiFixtures);
    const childId = `${kimiSession}/agent-0`;
    const listed = await listAllManifests(adapter);
    const target = listed.find((m) => m.sessionId === childId);
    if (target !== undefined) {
      const got = await adapter.readManifest(childId);
      assertManifestEqual(got, target);
    }
  });

  // Codex
  const codexSessionsDir = path.join(import.meta.dirname, "fixtures", "codex", "sessions");
  const codexSession = "019f8000-0000-7000-8000-0000000000a1";

  it("codex: readManifest matches listSessions", async () => {
    const adapter = new CodexAdapter(codexSessionsDir);
    const listed = await listAllManifests(adapter);
    const target = listed.find((m) => m.sessionId === codexSession)!;
    const got = await adapter.readManifest(codexSession);
    assertManifestEqual(got, target);
  });

  // Devin (dynamic SQLite fixture)
  let devinDir: string;
  let devinAdapter: DevinAdapter;

  it("devin: readManifest matches listSessions", async () => {
    devinDir = mkdtempSync(path.join(tmpdir(), "devin-rm-"));
    const dbPath = createDevinFixture(devinDir);
    devinAdapter = new DevinAdapter(dbPath);
    const listed = await listAllManifests(devinAdapter);
    expect(listed.length).toBeGreaterThan(0);
    const target = listed[0]!;
    const got = await devinAdapter.readManifest(target.sessionId);
    assertManifestEqual(got, target);
  });

  it("devin: readManifest throws for unknown session", async () => {
    // Reuse the adapter from the previous test (same fixture).
    const dir = mkdtempSync(path.join(tmpdir(), "devin-rm2-"));
    const adapter = new DevinAdapter(createDevinFixture(dir));
    await expect(adapter.readManifest("no-such-slug")).rejects.toThrow("session not found");
    rmSync(dir, { recursive: true, force: true });
  });
});
