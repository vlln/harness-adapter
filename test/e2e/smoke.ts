/**
 * System-test (CLI end-to-end) smoke entry — framework placeholder.
 *
 * The real e2e cases run the consumer CLI (examples/ahs-report.ts) against
 * synthetic fixture archives. That CLI lives on the unmerged spike branch
 * today and lands with the adapters in DEVELOP, so per the devloop rule
 * ("the framework must start successfully even with empty/trivial cases")
 * this placeholder only asserts that the runner works and can load the
 * library entry — the same substrate the real CLI cases will use.
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
    "Real CLI e2e cases arrive in DEVELOP with the adapters.",
);
