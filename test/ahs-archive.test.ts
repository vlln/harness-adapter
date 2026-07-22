import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index";
import { CodexAdapter } from "../src/adapters/codex/index";
import { KimiCodeAdapter } from "../src/adapters/kimi-code/index";
import {
  BLOB_THRESHOLD,
  exportSessions,
  sanitizeSessionId,
  writeArchive,
} from "../src/ahs/writer";
import { readBlob, readManifest, readRecords } from "../src/ahs/reader";
import type { Manifest } from "../src/schema/manifest";
import type { AhsRecord } from "../src/schema/record";
import type { HarnessAdapter } from "../src/store/adapter";
import { collectSessions, validateSessions, type SessionData } from "../src/validate/index";

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const tmp = mkdtempSync(path.join(tmpdir(), "ahs-archive-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function readAllRecords(dir: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of readRecords(dir)) records.push(rec);
  return records;
}

function archiveSnapshot(dir: string): Map<string, string> {
  // path (relative) -> file content, recursively, for byte-identity checks.
  const snapshot = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(full, `${rel}/`);
      else snapshot.set(rel, readFileSync(full, "utf8"));
    }
  };
  walk(dir, "");
  return snapshot;
}

describe("ahs archive round-trip", () => {
  const adapters: HarnessAdapter[] = [
    new ClaudeCodeAdapter(path.join(fixturesRoot, "claude-code")),
    new CodexAdapter(path.join(fixturesRoot, "codex")),
    new KimiCodeAdapter(path.join(fixturesRoot, "kimi-code")),
  ];

  it("every adapter session round-trips byte-equal through the archive", async () => {
    for (const adapter of adapters) {
      const outDir = path.join(tmp, `rt-${adapter.harness}`);
      const direct = await collectSessions(adapter);
      expect(direct.length).toBeGreaterThan(0);
      await exportSessions(adapter, outDir);

      const reread: SessionData[] = [];
      for (const { manifest, records } of direct) {
        const dir = path.join(outDir, sanitizeSessionId(manifest.sessionId));
        const archivedManifest = await readManifest(dir);
        const archivedRecords = await readAllRecords(dir);
        // Small fixtures: nothing crosses the blob threshold, so the
        // archive must be an exact copy of the adapter output.
        expect(archivedManifest).toEqual(manifest);
        expect(archivedRecords).toEqual(records);
        reread.push({ manifest: archivedManifest, records: archivedRecords });
      }
      // Layer-2 invariants still hold on the re-read data.
      expect(validateSessions(reread)).toEqual([]);
    }
  });

  it("sanitizes sessionIds for directories, collision-free", () => {
    expect(sanitizeSessionId("grand-barometer#root-10")).toBe("grand-barometer_x23root-10");
    expect(sanitizeSessionId("uuid/agent-0")).toBe("uuid_x2Fagent-0");
    expect(sanitizeSessionId("plain-id.1_2")).toBe("plain-id.1_x5F2");
    // Injective on tricky inputs.
    const ids = ["A", "_x41", "a/b", "a_x2Fb", "#", "_x23", "中文", "中文_xE4"];
    const mapped = ids.map(sanitizeSessionId);
    expect(new Set(mapped).size).toBe(ids.length);
  });
});

describe("blob externalization", () => {
  const BIG_RESULT = "R".repeat(BLOB_THRESHOLD + 1024);
  const BIG_TEXT = "T".repeat(BLOB_THRESHOLD + 512);
  const SESSION = "blob-session";

  const manifest: Manifest = {
    sessionId: SESSION,
    harness: "fake",
    harnessVersion: "0",
    ahsVersion: "0.1.0",
    cwd: "/tmp",
    model: "fake-model",
  };
  const base = { parentId: null as string | null, timestamp: "2026-07-20T10:00:00.000Z" };
  const records: AhsRecord[] = [
    { ...base, recordId: "r0", seq: 0, type: "user_message", content: [{ type: "text", text: "go" }] },
    {
      ...base,
      recordId: "r1",
      parentId: "r0",
      seq: 1,
      type: "assistant_message",
      content: [
        { type: "text", text: BIG_TEXT },
        { type: "text", text: "small stays inline" },
      ],
    },
    { ...base, recordId: "r2", parentId: "r1", seq: 2, type: "tool_call", toolCallId: "tc1", name: "Bash", args: {} },
    { ...base, recordId: "r3", parentId: "r2", seq: 3, type: "tool_result", toolCallId: "tc1", content: BIG_RESULT },
    { ...base, recordId: "r4", parentId: "r3", seq: 4, type: "tool_result", toolCallId: "tc1", content: "tiny" },
  ];
  const fakeAdapter: HarnessAdapter = {
    harness: "fake",
    capabilities: { history: "full", control: false },
    async *listSessions() {
      yield manifest;
    },
    async *readRecords() {
      yield* records;
    },
  };

  it("externalizes >64 KiB text blocks and tool_result content; keeps small inline", async () => {
    const outDir = path.join(tmp, "blobs");
    const result = await writeArchive(fakeAdapter, SESSION, outDir);
    expect(result.blobCount).toBe(2);
    const dir = result.dir;

    const archived = await readAllRecords(dir);
    // Oversized assistant text block → blob_ref block; small block untouched.
    const msg = archived[1]!;
    expect(msg.type).toBe("assistant_message");
    if (msg.type === "assistant_message") {
      expect(msg.content[0]).toMatchObject({
        type: "blob_ref",
        mediaType: "text/plain",
        byteLength: Buffer.byteLength(BIG_TEXT, "utf8"),
        preview: BIG_TEXT.slice(0, 256),
      });
      expect(msg.content[1]).toEqual({ type: "text", text: "small stays inline" });
    }
    // Oversized tool_result → BlobRef; small tool_result stays a string.
    const big = archived[3]!;
    if (big.type === "tool_result" && typeof big.content !== "string") {
      expect(big.content).toMatchObject({
        type: "blob_ref",
        byteLength: Buffer.byteLength(BIG_RESULT, "utf8"),
        preview: BIG_RESULT.slice(0, 256),
      });
      // Blob file exists and round-trips with integrity check.
      const restored = await readBlob(dir, big.content.sha256);
      expect(restored).toBe(BIG_RESULT);
    } else {
      throw new Error("expected blob_ref content");
    }
    expect(archived[4]).toMatchObject({ content: "tiny" });

    // Integrity check rejects a tampered hash.
    await expect(
      readBlob(dir, "0".repeat(64)),
    ).rejects.toThrow();
  });

  it("re-export over the same outDir is byte-identical", async () => {
    const outDir = path.join(tmp, "blobs-idem");
    await writeArchive(fakeAdapter, SESSION, outDir);
    const first = archiveSnapshot(outDir);
    await writeArchive(fakeAdapter, SESSION, outDir);
    const second = archiveSnapshot(outDir);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [file, content] of first) {
      expect(second.get(file)).toBe(content);
    }
  });
});
