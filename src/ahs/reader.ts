import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ManifestSchema, type Manifest } from "../schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../schema/record";

/**
 * AHS archive reader — the consumer side of the spec's disk layout (ADR-0006
 * multi-branch). Reads ONLY the archive; no adapter or native-storage
 * knowledge required.
 *
 * All functions take the SESSION archive dir (the one containing
 * manifest.json / records/ / blobs/).
 */

/** Read and zod-validate a session manifest. */
export async function readManifest(dir: string): Promise<Manifest> {
  const raw = await readFile(path.join(dir, "manifest.json"), "utf8");
  return ManifestSchema.parse(JSON.parse(raw));
}

/**
 * Read and zod-validate all records for a branch.
 *
 * When `branchName` is provided, reads from `records/<branchName>.jsonl`
 * (ADR-0006 multi-branch layout). When omitted, falls back to the legacy
 * `records.jsonl` single-file layout for backward compatibility.
 */
export async function* readRecords(dir: string, branchName?: string): AsyncIterable<AhsRecord> {
  const fileName = branchName !== undefined
    ? path.join("records", `${branchName}.jsonl`)
    : "records.jsonl";
  const raw = await readFile(path.join(dir, fileName), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    yield AhsRecordSchema.parse(JSON.parse(trimmed));
  }
}

/**
 * Read a blob by hash, verifying integrity: the file's raw bytes are
 * re-hashed and a mismatch throws (content-addressed storage guarantees
 * immutability).
 */
export async function readBlob(dir: string, sha256: string): Promise<Uint8Array> {
  const content = await readFile(path.join(dir, "blobs", `sha256-${sha256}`));
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== sha256) {
    throw new Error(`blob integrity mismatch: expected sha256-${sha256}, got sha256-${actual}`);
  }
  return content;
}