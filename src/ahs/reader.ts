import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ManifestSchema, type Manifest } from "../schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../schema/record";

/**
 * AHS archive reader — the consumer side of the spec's disk layout. Reads
 * ONLY the archive; no adapter or native-storage knowledge required.
 *
 * All functions take the SESSION archive dir (the one containing
 * manifest.json / records.jsonl / blobs/).
 */

/** Read and zod-validate a session manifest. */
export async function readManifest(dir: string): Promise<Manifest> {
  const raw = await readFile(path.join(dir, "manifest.json"), "utf8");
  return ManifestSchema.parse(JSON.parse(raw));
}

/** Read and zod-validate all records (seq order as written). */
export async function* readRecords(dir: string): AsyncIterable<AhsRecord> {
  const raw = await readFile(path.join(dir, "records.jsonl"), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    yield AhsRecordSchema.parse(JSON.parse(trimmed));
  }
}

/**
 * Read a blob by hash, verifying integrity: the file is re-hashed and a
 * mismatch throws (content-addressed storage guarantees immutability).
 */
export async function readBlob(dir: string, sha256: string): Promise<string> {
  const content = await readFile(path.join(dir, "blobs", `sha256-${sha256}`), "utf8");
  const actual = createHash("sha256").update(content, "utf8").digest("hex");
  if (actual !== sha256) {
    throw new Error(`blob integrity mismatch: expected sha256-${sha256}, got sha256-${actual}`);
  }
  return content;
}
