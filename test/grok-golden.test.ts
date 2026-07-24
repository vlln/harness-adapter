import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GrokAdapter } from "../src/adapters/grok/index";
import { collectSessions, stableSerialize } from "../src/validate/index";

/**
 * Layer 3 (AC-0003-N-1): golden diff against the reviewed expected output
 * for the synthetic fixture. The golden file is generated once from the
 * adapter output and reviewed by a human; any projection change must be
 * reflected by re-generating AND re-reviewing it.
 */
const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "grok",
);

describe("grok adapter golden (AC-0003-N-1)", () => {
  it("adapter output matches the reviewed golden file exactly", async () => {
    const adapter = new GrokAdapter(path.join(fixturesDir, "sessions"));
    const actual = stableSerialize(await collectSessions(adapter));
    const golden = readFileSync(path.join(fixturesDir, "golden.json"), "utf8").trimEnd();
    expect(actual).toBe(golden);
  });
});
