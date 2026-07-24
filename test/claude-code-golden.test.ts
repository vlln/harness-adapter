/**
 * AC-0003-N-1 (fidelity): golden diff against reviewed expected output.
 *
 * Golden files live in test/fixtures/claude-code/golden/<sessionId>.json —
 * one stable-serialized { manifest, records } per listed session (forks
 * included; "/" in fork session ids is escaped with the archive writer's
 * sanitizeSessionId), generated from the adapter and reviewed by hand. The
 * fixtures are synthetic (hand-crafted), so no sanitization concern
 * (AC-0003-E-1).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code/index";
import { sanitizeSessionId } from "../src/ahs/writer";
import { collectSessions, stableSerialize } from "../src/validate/index";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "claude-code",
);
const goldenDir = path.join(fixturesDir, "golden");

describe("claude-code golden (AC-0003-N-1)", () => {
  const adapter = new ClaudeCodeAdapter(fixturesDir);

  it("adapter output matches the reviewed golden files exactly", async () => {
    const sessions = await collectSessions(adapter);
    for (const session of sessions) {
      const goldenPath = path.join(goldenDir, `${sanitizeSessionId(session.manifest.sessionId)}.json`);
      const expected = readFileSync(goldenPath, "utf8");
      expect(stableSerialize(session), `golden diff for ${session.manifest.sessionId}`).toBe(
        expected.trimEnd(),
      );
    }
  });
});
