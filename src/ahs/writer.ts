import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Manifest } from "../schema/manifest";
import type { BlobRef } from "../schema/blob";
import type { AhsRecord } from "../schema/record";
import type { HarnessAdapter, SessionFilter } from "../store/adapter";

/**
 * AHS archive writer (spec section "磁盘布局与 blob 外置", ADR-0006
 * multi-branch layout).
 *
 * Layout:
 *   <outDir>/<sanitized-sessionId>/manifest.json        sorted-keys JSON
 *   <outDir>/<sanitized-sessionId>/records/<branch>.jsonl  one file per branch, file order
 *   <outDir>/<sanitized-sessionId>/blobs/sha256-<hex>
 *
 * Determinism / idempotency: manifest.json and each records JSONL line use
 * recursively sorted object keys; records are written in file (JSONL line)
 * order; blobs are content-addressed and skipped when already present.
 * Re-exporting over the same outDir yields byte-identical files.
 */

/** Spec threshold: content above 64 KiB is externalized. */
export const BLOB_THRESHOLD = 64 * 1024;

const PREVIEW_CHARS = 256;

/**
 * Map a sessionId to a directory-safe name. Characters outside
 * [A-Za-z0-9.-] are escaped as `_xHH` per UTF-8 byte (uppercase hex);
 * `_` itself is escaped (`_x5F`) so the `_x` introducer never appears
 * literally in output — the encoding is unambiguous, injective
 * (collision-free), and reversible by scanning for `_xHH` tokens.
 * Example: Devin's `grand-barometer#root-10` → `grand-barometer_x23root-10`.
 */
export function sanitizeSessionId(sessionId: string): string {
  const bytes = Buffer.from(sessionId, "utf8");
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9.-]/.test(ch)) {
      out += ch;
    } else {
      out += `_x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Inverse of sanitizeSessionId; throws on malformed escape sequences. */
export function desanitizeSessionId(dirName: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < dirName.length; i += 1) {
    if (dirName.startsWith("_x", i)) {
      const hex = dirName.slice(i + 2, i + 4);
      if (!/^[0-9A-F]{2}$/.test(hex)) {
        throw new Error(`malformed _xHH escape at index ${i} in ${dirName}`);
      }
      bytes.push(Number.parseInt(hex, 16));
      i += 3;
    } else {
      bytes.push(dirName.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** JSON.stringify with recursively sorted object keys (deterministic). */
function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface BlobWrite {
  sha256: string;
  content: Buffer;
}

/**
 * Externalize oversized content in one record. Returns the rewritten record
 * plus any blobs to store. A text/thinking block whose text exceeds the
 * threshold becomes a blob_ref block; a tool_result string content becomes
 * a BlobRef. Everything at or below the threshold stays inline,
 * byte-identical.
 */
function externalizeRecord(rec: AhsRecord): { record: AhsRecord; blobs: BlobWrite[] } {
  const blobs: BlobWrite[] = [];
  const toBlobRef = (content: string): BlobRef => {
    const bytes = Buffer.from(content, "utf8");
    const sha256 = sha256Hex(bytes);
    blobs.push({ sha256, content: bytes });
    return {
      type: "blob_ref",
      sha256,
      mediaType: "text/plain",
      byteLength: bytes.byteLength,
      preview: content.slice(0, PREVIEW_CHARS),
    };
  };
  const oversized = (s: string): boolean => Buffer.byteLength(s, "utf8") > BLOB_THRESHOLD;

  if (
    rec.type === "user_message" ||
    rec.type === "assistant_message" ||
    rec.type === "harness_message"
  ) {
    let changed = false;
    const content = rec.content.map((block) => {
      if ((block.type === "text" || block.type === "thinking") && oversized(block.text)) {
        changed = true;
        return toBlobRef(block.text);
      }
      return block;
    });
    if (changed) return { record: { ...rec, content }, blobs };
  } else if (rec.type === "tool_result" && typeof rec.content === "string") {
    if (oversized(rec.content)) {
      const ref = toBlobRef(rec.content);
      return { record: { ...rec, content: ref }, blobs };
    }
  }
  return { record: rec, blobs };
}

export interface WriteArchiveResult {
  sessionId: string;
  dir: string;
  recordCount: number;
  blobCount: number;
}

/**
 * Write one already-collected session (manifest + per-branch records).
 * Shared by writeArchive and exportSessions.
 */
async function writeSessionArchive(
  manifest: Manifest,
  branchRecords: Map<string, AhsRecord[]>,
  outDir: string,
): Promise<WriteArchiveResult> {
  const dir = path.join(outDir, sanitizeSessionId(manifest.sessionId));
  const recordsDir = path.join(dir, "records");
  const blobsDir = path.join(dir, "blobs");
  await mkdir(recordsDir, { recursive: true });
  await mkdir(blobsDir, { recursive: true });

  let totalRecordCount = 0;
  let blobCount = 0;

  for (const [branchName, records] of branchRecords) {
    const lines: string[] = [];
    for (const rec of records) {
      const { record, blobs } = externalizeRecord(rec);
      for (const blob of blobs) {
        const blobPath = path.join(blobsDir, `sha256-${blob.sha256}`);
        try {
          // Content-addressed: an existing file holds the same bytes — skip.
          await readFile(blobPath);
        } catch {
          await writeFile(blobPath, blob.content);
          blobCount += 1;
        }
      }
      lines.push(stableStringify(record));
    }
    await writeFile(
      path.join(recordsDir, `${branchName}.jsonl`),
      lines.join("\n") + (lines.length > 0 ? "\n" : ""),
      "utf8",
    );
    totalRecordCount += records.length;
  }

  await writeFile(path.join(dir, "manifest.json"), `${stableStringify(manifest, 2)}\n`, "utf8");

  return { sessionId: manifest.sessionId, dir, recordCount: totalRecordCount, blobCount };
}

/** Read all branch records from the adapter (file order per branch). */
async function collectAllBranchRecords(
  adapter: HarnessAdapter,
  manifest: Manifest,
): Promise<Map<string, AhsRecord[]>> {
  const branchRecords = new Map<string, AhsRecord[]>();
  for (const branchName of Object.keys(manifest.branches)) {
    const records: AhsRecord[] = [];
    for await (const rec of adapter.readRecords(manifest.sessionId, branchName)) {
      records.push(rec);
    }
    branchRecords.set(branchName, records);
  }
  return branchRecords;
}

/**
 * Write one session's archive. The manifest is located via the adapter's
 * listSessions (adapters may synthesize manifests only there).
 */
export async function writeArchive(
  adapter: HarnessAdapter,
  sessionId: string,
  outDir: string,
): Promise<WriteArchiveResult> {
  let manifest: Manifest | undefined;
  // Storage view: look up among ALL sessions, fork descendants included.
  for await (const m of adapter.listSessions({ includeForks: true })) {
    if (m.sessionId === sessionId) {
      manifest = m;
      break;
    }
  }
  if (manifest === undefined) throw new Error(`session not found: ${sessionId}`);
  const branchRecords = await collectAllBranchRecords(adapter, manifest);
  return writeSessionArchive(manifest, branchRecords, outDir);
}

/** Export every session an adapter lists (optionally filtered) into outDir. */
export async function exportSessions(
  adapter: HarnessAdapter,
  outDir: string,
  filter?: SessionFilter,
): Promise<WriteArchiveResult[]> {
  // An archive is the storage view: default to the FULL set (forks included);
  // a caller-supplied filter may still narrow it down.
  const effective: SessionFilter = { includeForks: true, ...filter };
  const results: WriteArchiveResult[] = [];
  for await (const manifest of adapter.listSessions(effective)) {
    const branchRecords = await collectAllBranchRecords(adapter, manifest);
    results.push(await writeSessionArchive(manifest, branchRecords, outDir));
  }
  return results;
}