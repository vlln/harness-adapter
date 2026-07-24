#!/usr/bin/env node
/**
 * ahs-export — project native harness sessions to AHS archive on disk.
 *
 * The inverse of ahs-report: ahs-report reads an AHS archive and renders a
 * transcript; ahs-export reads native harness storage and writes an AHS
 * archive (manifest.json + records/*.jsonl + blobs/).
 *
 * Usage:
 *   vite-node examples/ahs-export.ts <harness> <sessionId> <outDir>
 *     Project a single session.
 *   vite-node examples/ahs-export.ts <harness> <outDir>
 *     Project all sessions (equivalent to exportSessions).
 *
 * Registered harnesses: claude-code, codex, kimi-code, devin.
 * For unregistered adapters (grok, qwen, pi), use the programmatic API:
 *   writeArchive(new GrokAdapter(basePath), sessionId, outDir)
 */

import { openHarness, type HarnessName } from "../src/session/facade";
import { writeArchive, exportSessions } from "../src/ahs/writer";

const REGISTRY = ["claude-code", "codex", "kimi-code", "devin"] as const;

// CLI entry — same invocation-detection pattern as ahs-report.ts.
const entry = process.argv[1] ?? "";
const invokedAsScript =
  /[\\/]ahs-export\.ts$/.test(entry) || /[\\/](vite-node|tsx)(\.[cm]?[jt]s)?$/.test(entry);

if (invokedAsScript) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    console.error("usage: ahs-export <harness> <sessionId> <outDir>");
    console.error("       ahs-export <harness> <outDir>");
    console.error(`harnesses: ${REGISTRY.join(", ")}`);
    process.exit(1);
  }

  const harness = args[0] as HarnessName;
  if (!REGISTRY.includes(harness)) {
    console.error(`unknown harness: ${harness}`);
    console.error(`available: ${REGISTRY.join(", ")}`);
    process.exit(1);
  }

  const facade = openHarness(harness);

  if (args.length === 3) {
    const [, sessionId, outDir] = args as [string, string, string];
    writeArchive(facade.adapter, sessionId, outDir)
      .then((result) => {
        console.log(`exported ${result.sessionId}: ${result.recordCount} records, ${result.blobCount} blobs → ${result.dir}`);
      })
      .catch((err: unknown) => {
        console.error(err);
        process.exit(1);
      });
  } else {
    const [, outDir] = args as [string, string];
    exportSessions(facade.adapter, outDir)
      .then((results) => {
        console.log(`exported ${results.length} session(s) → ${outDir}`);
        for (const r of results) {
          console.log(`  ${r.sessionId}: ${r.recordCount} records, ${r.blobCount} blobs`);
        }
      })
      .catch((err: unknown) => {
        console.error(err);
        process.exit(1);
      });
  }
}

export { writeArchive, exportSessions };
