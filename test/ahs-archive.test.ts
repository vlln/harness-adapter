/**
 * AHS archive writer/reader tests: round-trip fidelity, blob externalization
 * rules, sessionId sanitization, and re-export byte-identity (AC-0002-N-5
 * at the archive layer).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  BLOB_THRESHOLD,
  desanitizeSessionId,
  exportSessions,
  sanitizeSessionId,
  writeArchive,
} from "../src/ahs/writer";
import { readBlob, readManifest, readRecords } from "../src/ahs/reader";
import type { AhsRecord } from "../src/schema/record";
import { validateSessions, type SessionData } from "../src/validate/index";
import {
  assistantMessage,
  fakeAdapter,
  makeSession,
  toolCall,
  toolResult,
  userMessage,
} from "./builders";

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

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const PARENT_RECORDS = [
  userMessage(0, "go", { usage: { inputTokens: 10, outputTokens: 5 } }),
  assistantMessage(1, "working"),
  toolCall(2, "tc1", { status: "completed" }),
  toolResult(3, "tc1", "done", { sessionId: "child" }),
];

describe("archive round-trip", () => {
  const sessions: SessionData[] = [
    makeSession("parent", PARENT_RECORDS),
    makeSession("child", [userMessage(0, "subtask")], {
      invocation: { sessionId: "parent", atRecordId: "r2" },
    }),
  ];

  it("manifest and records survive write → read deep-equal; invariants still hold", async () => {
    const outDir = path.join(tmp, "round-trip");
    const adapter = fakeAdapter(sessions);
    const results = await exportSessions(adapter, outDir);
    expect(results).toHaveLength(2);

    const reread: SessionData[] = [];
    for (const { manifest, records } of sessions) {
      const dir = path.join(outDir, sanitizeSessionId(manifest.sessionId));
      const archivedManifest = await readManifest(dir);
      const archivedRecords = await readAllRecords(dir);
      // Nothing crosses the blob threshold: the archive is an exact copy.
      expect(archivedManifest).toEqual(manifest);
      expect(archivedRecords).toEqual(records);
      reread.push({ manifest: archivedManifest, records: archivedRecords });
    }
    // Layer-2 invariants still hold on the re-read data.
    expect(validateSessions(reread)).toEqual([]);
  });

  it("writeArchive throws for a session the adapter does not list", async () => {
    await expect(
      writeArchive(fakeAdapter(sessions), "no-such-session", path.join(tmp, "missing")),
    ).rejects.toThrow("session not found");
  });

  it("reader rejects a corrupted manifest (zod-validated)", async () => {
    const outDir = path.join(tmp, "corrupt");
    const adapter = fakeAdapter([makeSession("sess-1")]);
    const dir = (await exportSessions(adapter, outDir))[0]!.dir;
    const manifestPath = path.join(dir, "manifest.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(manifestPath, JSON.stringify({ sessionId: 42 }));
    await expect(readManifest(dir)).rejects.toThrow();
  });
});

describe("sessionId sanitization", () => {
  it("escapes characters outside [A-Za-z0-9.-] as _xHH per UTF-8 byte", () => {
    expect(sanitizeSessionId("grand-barometer#root-10")).toBe("grand-barometer_x23root-10");
    expect(sanitizeSessionId("uuid/agent-0")).toBe("uuid_x2Fagent-0");
    expect(sanitizeSessionId("plain-id.1_2")).toBe("plain-id.1_x5F2");
  });

  it("is reversible — desanitize(sanitize(id)) === id, incl. the _xHH self-escape case", () => {
    const ids = [
      "plain",
      "_x41", // literal escape introducer in the source id
      "_x5F",
      "a/b_c#d",
      "中文-xE4",
      "trailing_",
      "_leading",
      "UPPER.lower-123",
    ];
    for (const id of ids) {
      expect(desanitizeSessionId(sanitizeSessionId(id))).toBe(id);
    }
  });

  it("is injective on tricky inputs", () => {
    const ids = ["A", "_x41", "a/b", "a_x2Fb", "#", "_x23", "中文", "中文_xE4"];
    const mapped = ids.map(sanitizeSessionId);
    expect(new Set(mapped).size).toBe(ids.length);
  });

  it("desanitize rejects malformed _xHH escapes", () => {
    expect(() => desanitizeSessionId("bad_xGH escape")).toThrow("malformed");
    expect(() => desanitizeSessionId("truncated_x4")).toThrow("malformed");
  });
});

describe("blob externalization", () => {
  const BIG_RESULT = "R".repeat(BLOB_THRESHOLD + 1024);
  const BIG_TEXT = "T".repeat(BLOB_THRESHOLD + 512);
  const EXACTLY_AT = "E".repeat(BLOB_THRESHOLD);

  const session = makeSession("blob-session", [
    userMessage(0, "go"),
    assistantMessage(1, BIG_TEXT),
    toolCall(2, "tc1"),
    toolResult(3, "tc1", BIG_RESULT),
    toolCall(4, "tc2"),
    toolResult(5, "tc2", EXACTLY_AT), // at threshold → stays inline (rule is > 64 KiB)
  ]);
  const adapter = fakeAdapter([session]);

  it("externalizes >64 KiB text blocks and tool_result content; keeps small inline", async () => {
    const outDir = path.join(tmp, "blobs");
    const result = await writeArchive(adapter, "blob-session", outDir);
    expect(result.blobCount).toBe(2);
    const dir = result.dir;

    const archived = await readAllRecords(dir);
    // Oversized assistant text block → blob_ref block.
    const msg = archived[1]!;
    expect(msg.type).toBe("assistant_message");
    if (msg.type === "assistant_message") {
      expect(msg.content[0]).toMatchObject({
        type: "blob_ref",
        mediaType: "text/plain",
        byteLength: Buffer.byteLength(BIG_TEXT, "utf8"),
        preview: BIG_TEXT.slice(0, 256),
      });
    }
    // Oversized tool_result → BlobRef; blob file round-trips with integrity check.
    const big = archived[3]!;
    if (big.type === "tool_result" && typeof big.content !== "string") {
      expect(big.content).toMatchObject({
        type: "blob_ref",
        byteLength: Buffer.byteLength(BIG_RESULT, "utf8"),
        preview: BIG_RESULT.slice(0, 256),
      });
      const restored = await readBlob(dir, big.content.sha256);
      expect(decode(restored)).toBe(BIG_RESULT);
    } else {
      throw new Error("expected blob_ref content");
    }
    // Exactly-at-threshold content stays inline.
    expect(archived[5]).toMatchObject({ content: EXACTLY_AT });

    // Integrity check rejects a tampered hash.
    await expect(readBlob(dir, "0".repeat(64))).rejects.toThrow();
  });

  it("readBlob re-hash detects corrupted blob content", async () => {
    const outDir = path.join(tmp, "blobs-tamper");
    const dir = (await exportSessions(adapter, outDir))[0]!.dir;
    const archived = await readAllRecords(dir);
    const big = archived[3]!;
    if (big.type !== "tool_result" || typeof big.content === "string") {
      throw new Error("expected blob_ref content");
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "blobs", `sha256-${big.content.sha256}`), "tampered");
    await expect(readBlob(dir, big.content.sha256)).rejects.toThrow("integrity");
  });

  it("re-export over the same outDir is byte-identical (AC-0002-N-5 archive layer)", async () => {
    const outDir = path.join(tmp, "blobs-idem");
    await exportSessions(adapter, outDir);
    const first = archiveSnapshot(outDir);
    await exportSessions(adapter, outDir);
    const second = archiveSnapshot(outDir);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [file, content] of first) {
      expect(second.get(file)).toBe(content);
    }
  });
});
