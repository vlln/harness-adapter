/**
 * System-test e2e — real adapter → archive → ahs-report CLI chains.
 *
 * For each of the 4 formal adapters the full chain runs end to end:
 *   1. the adapter reads its synthetic repo fixture (test/fixtures/*),
 *   2. exportSessions writes an AHS archive into a temp dir,
 *   3. examples/ahs-report.ts runs as a REAL CLI subprocess (vite-node,
 *      exactly as a user would invoke it) against the archive root,
 *   4. assertions: exit code 0, transcript structure in stdout (tool-call
 *      lines, indented child sessions for fixtures with sub-agents), and
 *      the aggregated usage numbers equal the record-level sums computed
 *      independently from the archive's records.jsonl files.
 *
 * Run with: npm run test:e2e (after test/e2e/smoke.ts)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index";
import { CodexAdapter } from "../../src/adapters/codex/index";
import { DevinAdapter } from "../../src/adapters/devin/index";
import { KimiCodeAdapter } from "../../src/adapters/kimi-code/index";
import { exportSessions } from "../../src/ahs/writer";
import type { HarnessAdapter } from "../../src/store/adapter";
import { createDevinFixture } from "../fixtures/devin-db";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const fixturesDir = path.join(repoRoot, "test", "fixtures");
const viteNode = path.join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const reportCli = path.join(repoRoot, "examples", "ahs-report.ts");

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.error(`[e2e] FAIL: ${msg}`);
  }
}

const TOKEN_FIELDS = [
  ["input", "inputTokens"],
  ["output", "outputTokens"],
  ["cacheRead", "cacheReadTokens"],
  ["cacheWrite", "cacheWriteTokens"],
  ["reasoning", "reasoningTokens"],
] as const;

interface ArchivedSession {
  dir: string;
  manifest: {
    sessionId: string;
    invocation?: { sessionId: string; atRecordId?: string };
  };
}

function loadArchive(archiveRoot: string): Map<string, ArchivedSession> {
  const sessions = new Map<string, ArchivedSession>();
  for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(archiveRoot, entry.name);
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
      sessions.set(manifest.sessionId, { dir, manifest });
    } catch {
      // not a session dir
    }
  }
  return sessions;
}

/**
 * Independently recompute what the report's `total:` line must show: walk
 * the invocation graph from the root and sum usage over every record in
 * each visited session's records.jsonl.
 */
function expectedTotals(
  archive: Map<string, ArchivedSession>,
  rootId: string,
): { tokens: Record<string, number>; sessionCount: number } {
  const childrenOf = new Map<string, string[]>();
  for (const s of archive.values()) {
    if (s.manifest.invocation === undefined) continue;
    const list = childrenOf.get(s.manifest.invocation.sessionId) ?? [];
    list.push(s.manifest.sessionId);
    childrenOf.set(s.manifest.invocation.sessionId, list);
  }
  const tokens: Record<string, number> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  let sessionCount = 0;
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const session = archive.get(id);
    if (session === undefined) return;
    sessionCount += 1;
    const jsonl = readFileSync(path.join(session.dir, "records.jsonl"), "utf8");
    for (const line of jsonl.split("\n")) {
      if (line.trim() === "") continue;
      const rec = JSON.parse(line);
      const u = rec.usage;
      if (u === undefined) continue;
      for (const [key, field] of TOKEN_FIELDS) {
        tokens[key]! += u[field] ?? 0;
      }
    }
    for (const child of childrenOf.get(id) ?? []) visit(child);
  };
  visit(rootId);
  return { tokens, sessionCount };
}

interface E2eCase {
  name: string;
  makeAdapter: (tmp: string) => HarnessAdapter;
  /** Session the CLI is invoked with (a root with spawned children where the fixture has any). */
  rootSessionId: string;
  /** Spawned descendants expected to render indented under the root. */
  childSessionIds: string[];
  /** Substrings the transcript must contain. */
  transcriptMarkers: string[];
}

const CLAUDE_SESSION_B = "22222222-2222-4222-8222-222222222222";
const CODEX_A1 = "019f8000-0000-7000-8000-0000000000a1";
const CODEX_B2 = "019f8000-0000-7000-8000-0000000000b2";
const KIMI_SESSION = "11111111-2222-4333-8444-555555555555";
const KIMI_CHILD = `${KIMI_SESSION}/agent-0`;

const cases: E2eCase[] = [
  {
    name: "claude-code",
    makeAdapter: () => new ClaudeCodeAdapter(path.join(fixturesDir, "claude-code")),
    rootSessionId: CLAUDE_SESSION_B,
    childSessionIds: ["abc123"],
    transcriptMarkers: [
      `# ${CLAUDE_SESSION_B} [claude-code`,
      "→ Task(",
      "Search the codebase for parser implementations",
    ],
  },
  {
    name: "codex",
    makeAdapter: () => new CodexAdapter(path.join(fixturesDir, "codex", "sessions")),
    rootSessionId: CODEX_A1,
    childSessionIds: [CODEX_B2],
    transcriptMarkers: [`# ${CODEX_A1} [codex`, "→ spawn_agent("],
  },
  {
    name: "kimi-code",
    makeAdapter: () => new KimiCodeAdapter(path.join(fixturesDir, "kimi-code")),
    rootSessionId: KIMI_SESSION,
    childSessionIds: [KIMI_CHILD],
    transcriptMarkers: [`# ${KIMI_SESSION} [kimi-code`, "→ "],
  },
  {
    name: "devin",
    makeAdapter: (tmp) => new DevinAdapter(createDevinFixture(tmp)),
    rootSessionId: "sunny-forest",
    // sibling_attempt sessions are lineage-linked, NOT invocation children —
    // the report aggregates only the root session itself.
    childSessionIds: [],
    transcriptMarkers: ["# sunny-forest [devin", "→ "],
  },
];

const workRoot = mkdtempSync(path.join(tmpdir(), "ahs-e2e-"));
try {
  for (const c of cases) {
    console.log(`[e2e] ${c.name}: adapter → archive → ahs-report CLI`);
    const tmp = mkdtempSync(path.join(workRoot, `${c.name}-`));
    const archiveRoot = path.join(tmp, "archive");
    const adapter = c.makeAdapter(tmp);

    const exported = await exportSessions(adapter, archiveRoot);
    check(exported.length > 0, `${c.name}: adapter exported no sessions`);

    const proc = spawnSync(
      process.execPath,
      [viteNode, reportCli, archiveRoot, c.rootSessionId],
      { encoding: "utf8" },
    );
    check(
      proc.status === 0,
      `${c.name}: CLI exit code ${proc.status} (stderr: ${proc.stderr?.slice(0, 400)})`,
    );
    const out = proc.stdout ?? "";

    // Transcript structure.
    for (const marker of c.transcriptMarkers) {
      check(out.includes(marker), `${c.name}: stdout missing transcript marker ${JSON.stringify(marker)}`);
    }
    check(out.includes("⤷"), `${c.name}: stdout has no tool_result line`);
    for (const childId of c.childSessionIds) {
      check(
        out.includes(`  # ${childId}`),
        `${c.name}: child session ${childId} not rendered indented`,
      );
    }

    // Aggregated usage: CLI total line vs independent record-level sums.
    const totalLine = out.split("\n").find((l) => l.startsWith("total: "));
    check(totalLine !== undefined, `${c.name}: stdout has no total: line`);
    const summaryLine = out
      .split("\n")
      .find((l) => l.startsWith("== cost summary"));
    const expected = expectedTotals(loadArchive(archiveRoot), c.rootSessionId);
    check(
      summaryLine === `== cost summary (${expected.sessionCount} session(s)) ==`,
      `${c.name}: summary line ${JSON.stringify(summaryLine)} does not match ${expected.sessionCount} session(s)`,
    );
    if (totalLine !== undefined) {
      const shown = new Map<string, number>();
      for (const m of totalLine.matchAll(/(\w+)=([0-9.]+)/g)) {
        shown.set(m[1]!, Number(m[2]));
      }
      for (const key of Object.keys(expected.tokens)) {
        check(
          shown.get(key) === expected.tokens[key],
          `${c.name}: total ${key} — CLI shows ${shown.get(key)}, record-level sum is ${expected.tokens[key]}`,
        );
      }
    }
  }
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`[e2e] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log(`[e2e] OK — ${cases.length} adapter chains passed (export → archive → report CLI)`);
