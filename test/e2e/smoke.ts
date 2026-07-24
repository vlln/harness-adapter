/**
 * System-test (CLI end-to-end) smoke entry — framework liveness check.
 *
 * Asserts that the e2e runner works and can load the library entry — the
 * same substrate the real CLI cases in test/e2e/adapter-chains.ts use
 * (adapter → archive → ahs-report CLI, run right after this smoke).
 *
 * Run with: npm run test:e2e
 */

const ahs = await import("../../src/index");

export {};

if (Object.keys(ahs).length === 0) {
  console.error("[e2e smoke] FAIL: library entry exports nothing");
  process.exit(1);
}

console.log(
  `[e2e smoke] OK — runner works, library entry loaded (${Object.keys(ahs).length} exports). ` +
    "Real CLI chains run next (test/e2e/adapter-chains.ts).",
);
