/**
 * System-test e2e — real adapter → archive → ahs-report CLI chains.
 *
 * For each of the 7 formal adapters the full chain runs end to end:
 *   1. the adapter reads its synthetic repo fixture (test/fixtures/*),
 *   2. exportSessions writes an AHS archive into a temp dir,
 *   3. examples/ahs-report.ts runs as a REAL CLI subprocess (vite-node,
 *      exactly as a user would invoke it) against the archive root,
 *   4. assertions: exit code 0, Task-view transcript structure in stdout
 *      (HEAD-chain rendering with stitched prefixes, indented invocation
 *      children, fork folding), and the aggregated usage numbers equal the
 *      record-level sums over the rendered slices computed independently
 *      from the archive's records.jsonl files.
 *
 * The devin fixture has lineage forks: the default view must fold them
 * (HEAD chain only) and `--all` must list them as alternate versions.
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
import { GrokAdapter } from "../../src/adapters/grok/index";
import { KimiCodeAdapter } from "../../src/adapters/kimi-code/index";
import { PiAdapter } from "../../src/adapters/pi/index";
import { QwenCodeAdapter } from "../../src/adapters/qwen/index";
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
    lineage?: { type: string; sessionId: string; atRecordId?: string };
    invocation?: { sessionId: string; atRecordId?: string };
  };
  records: {
    recordId: string;
    type: string;
    timestamp: string;
    usage?: Record<string, number>;
  }[];
}

function loadArchive(archiveRoot: string): Map<string, ArchivedSession> {
  const sessions = new Map<string, ArchivedSession>();
  for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(archiveRoot, entry.name);
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
      const records = readFileSync(path.join(dir, "records.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      sessions.set(manifest.sessionId, { dir, manifest, records });
    } catch {
      // not a session dir
    }
  }
  return sessions;
}

/**
 * Independently recompute what the report's `total:` line must show under
 * the Task view (ADR-0005 §5): resolve the root session's lineage group and
 * HEAD pointer, walk the HEAD chain (stitched prefix slices + fork
 * suffixes), recurse into invocation children (manifest back-links, with
 * fork-of-subagent inheritance resolved by walking lineage ancestors), and
 * sum usage over exactly the rendered record slices. Implemented from raw
 * manifests + records.jsonl only — no src/ahs/relations code.
 */
function expectedTotals(
  archive: Map<string, ArchivedSession>,
  rootId: string,
): { tokens: Record<string, number>; sessionCount: number } {
  // Lineage groups via union-find over manifest lineage back-links.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const id of archive.keys()) parent.set(id, id);
  for (const s of archive.values()) {
    const lin = s.manifest.lineage;
    if (lin === undefined || !archive.has(lin.sessionId)) continue;
    const ra = find(s.manifest.sessionId);
    const rb = find(lin.sessionId);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groupMembers = new Map<string, string[]>();
  for (const id of archive.keys()) {
    const root = find(id);
    const list = groupMembers.get(root) ?? [];
    list.push(id);
    groupMembers.set(root, list);
  }
  // HEAD: most recently updated member (last record timestamp; tie → smaller id).
  const lastTs = (id: string): string => {
    const records = archive.get(id)!.records;
    return records.length > 0 ? records[records.length - 1]!.timestamp : "";
  };
  const headOf = (members: string[]): string => {
    let head = members[0]!;
    for (const id of members.slice(1)) {
      if (lastTs(id) > lastTs(head) || (lastTs(id) === lastTs(head) && id < head)) head = id;
    }
    return head;
  };

  // Effective invocation: manifest back-link, else inherited from the first
  // lineage ancestor that has one (fork-of-subagent closure).
  const effectiveInvocation = (
    id: string,
  ): { sessionId: string; atRecordId?: string } | undefined => {
    const own = archive.get(id)!.manifest.invocation;
    if (own !== undefined) return own;
    const seen = new Set<string>([id]);
    let cur = archive.get(id)!.manifest.lineage?.sessionId;
    while (cur !== undefined && archive.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const inv = archive.get(cur)!.manifest.invocation;
      if (inv !== undefined) return inv;
      cur = archive.get(cur)!.manifest.lineage?.sessionId;
    }
    return undefined;
  };

  const tokens: Record<string, number> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  let sessionCount = 0;
  const visitedGroups = new Set<string>();

  const visit = (entryId: string): void => {
    const members = groupMembers.get(find(entryId));
    if (members === undefined) return;
    const groupKey = find(entryId);
    if (visitedGroups.has(groupKey)) return;
    visitedGroups.add(groupKey);

    // HEAD chain, oldest first.
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = headOf(members);
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      chain.unshift(cur);
      const lin: ArchivedSession["manifest"]["lineage"] = archive.get(cur)!.manifest.lineage;
      cur = lin !== undefined && members.includes(lin.sessionId) ? lin.sessionId : undefined;
    }

    for (let i = 0; i < chain.length; i += 1) {
      const sid = chain[i]!;
      const records = archive.get(sid)!.records;
      let end = records.length;
      if (i + 1 < chain.length) {
        const childLin = archive.get(chain[i + 1]!)!.manifest.lineage;
        if (childLin?.atRecordId === undefined) {
          end = 0;
        } else {
          const idx = records.findIndex((r) => r.recordId === childLin.atRecordId);
          end = idx >= 0 ? idx + 1 : records.length;
        }
      }
      if (end === 0) continue;
      sessionCount += 1;
      for (const rec of records.slice(0, end)) {
        if (rec.usage === undefined) continue;
        for (const [key, field] of TOKEN_FIELDS) tokens[key]! += rec.usage[field] ?? 0;
      }
      // Invocation children of this chain session (deduped by group).
      const childGroups = new Set<string>();
      for (const s of archive.values()) {
        const eff = effectiveInvocation(s.manifest.sessionId);
        if (eff?.sessionId !== sid) continue;
        childGroups.add(find(s.manifest.sessionId));
      }
      for (const childGroup of [...childGroups].sort()) visit(childGroup);
    }
  };
  visit(rootId);
  return { tokens, sessionCount };
}

interface E2eCase {
  name: string;
  makeAdapter: (tmp: string) => HarnessAdapter;
  /** Session the CLI is invoked with (any member of the target lineage group). */
  rootSessionId: string;
  /** Spawned descendants expected to render indented under the root. */
  childSessionIds: string[];
  /** Substrings the transcript must contain. */
  transcriptMarkers: string[];
  /** Substrings the default view must NOT contain (folded forks). */
  absentMarkers?: string[];
  /** Skip the generic tool_result-line check (HEAD chains without tool calls). */
  skipToolResultLine?: boolean;
  /** Extra CLI run with --all: substrings the output must contain. */
  allRunMarkers?: string[];
}

const CLAUDE_SESSION_B = "22222222-2222-4222-8222-222222222222";
const CODEX_A1 = "019f8000-0000-7000-8000-0000000000a1";
const CODEX_B2 = "019f8000-0000-7000-8000-0000000000b2";
const KIMI_SESSION = "11111111-2222-4333-8444-555555555555";
const KIMI_CHILD = `${KIMI_SESSION}/agent-0`;
const GROK_SESSION = "019f0000-0000-7000-8000-000000000001";
const QWEN_SESSION_B = "b2222222-2222-4222-8222-222222222222";
const PI_SESSION_C = "019f4000-cccc-7000-8000-0000000000c3";

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
    // HEAD chain of the {a1, c3, f6} group: f6 is the HEAD (most recent).
    transcriptMarkers: [`# ${CODEX_A1} [codex`, "→ spawn_agent(", "(task HEAD)"],
  },
  {
    name: "kimi-code",
    makeAdapter: () => new KimiCodeAdapter(path.join(fixturesDir, "kimi-code")),
    rootSessionId: KIMI_SESSION,
    childSessionIds: [KIMI_CHILD],
    transcriptMarkers: [`# ${KIMI_SESSION} [kimi-code`, "→ "],
  },
  {
    name: "grok",
    makeAdapter: () => new GrokAdapter(path.join(fixturesDir, "grok", "sessions")),
    rootSessionId: GROK_SESSION,
    childSessionIds: [],
    transcriptMarkers: [
      `# ${GROK_SESSION} [grok`,
      "→ read_file(",
      "─ turn start (0)",
      "─ model change → grok-4.5-mini",
    ],
  },
  {
    name: "qwen",
    makeAdapter: () => new QwenCodeAdapter(path.join(fixturesDir, "qwen")),
    rootSessionId: QWEN_SESSION_B,
    childSessionIds: [],
    transcriptMarkers: [
      `# ${QWEN_SESSION_B} [qwen-code`,
      "→ Grep(",
      "→ Bash(",
      "(interrupted)",
    ],
  },
  {
    name: "pi",
    makeAdapter: () => new PiAdapter(path.join(fixturesDir, "pi")),
    rootSessionId: PI_SESSION_C,
    // Lineage forks (edit-resend + retry) are folded in the default view;
    // --all lists them as alternate versions.
    childSessionIds: [],
    transcriptMarkers: [
      `# ${PI_SESSION_C} [pi`,
      "─ model change → DeepSeek-V4-Flash",
      "edited follow-up",
      "new answer to the retry",
    ],
    absentMarkers: ["original follow-up", "old answer to the retry"],
    skipToolResultLine: true,
    allRunMarkers: [
      `HEAD: ${PI_SESSION_C}`,
      `${PI_SESSION_C}/fork/cc000005`,
      `${PI_SESSION_C}/fork/cc00000a`,
    ],
  },
  {
    name: "devin",
    makeAdapter: (tmp) => new DevinAdapter(createDevinFixture(tmp)),
    rootSessionId: "sunny-forest",
    // rewound_from/fork sessions are lineage-linked, NOT invocation
    // children — the default view folds them (HEAD chain only).
    childSessionIds: [],
    // Group HEAD by the recency heuristic is sunny-forest#root-50 (latest
    // record); its chain is [sunny-forest prefix, root-50 suffix].
    transcriptMarkers: [
      "# sunny-forest [devin",
      "(shared prefix, stitched)",
      "# sunny-forest#root-50 [devin",
      "(task HEAD)",
      "Different answer to the same prompt.",
    ],
    absentMarkers: ["#fork-16", "#root-30", "#root-40"],
    skipToolResultLine: true,
    allRunMarkers: [
      "== alternate versions (group sunny-forest) ==",
      "HEAD: sunny-forest#root-50",
      "- sunny-forest (group root)",
      "sunny-forest#fork-16",
      "sunny-forest#root-30",
      "sunny-forest#root-40",
      "- sunny-forest#root-50 (HEAD)",
    ],
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

    const run = (args: string[]): string => {
      const proc = spawnSync(process.execPath, [viteNode, reportCli, ...args], {
        encoding: "utf8",
      });
      check(
        proc.status === 0,
        `${c.name}: CLI exit code ${proc.status} (stderr: ${proc.stderr?.slice(0, 400)})`,
      );
      return proc.stdout ?? "";
    };
    const out = run([archiveRoot, c.rootSessionId]);

    // Transcript structure.
    for (const marker of c.transcriptMarkers) {
      check(out.includes(marker), `${c.name}: stdout missing transcript marker ${JSON.stringify(marker)}`);
    }
    if (c.skipToolResultLine !== true) {
      check(out.includes("⤷"), `${c.name}: stdout has no tool_result line`);
    }
    for (const absent of c.absentMarkers ?? []) {
      check(!out.includes(absent), `${c.name}: default view must fold ${JSON.stringify(absent)}`);
    }
    for (const childId of c.childSessionIds) {
      check(
        out.includes(`  # ${childId}`),
        `${c.name}: child session ${childId} not rendered indented`,
      );
    }

    // --all: fork/attempt sessions become visible as alternate versions.
    if (c.allRunMarkers !== undefined) {
      const allOut = run([archiveRoot, c.rootSessionId, "--all"]);
      for (const marker of c.allRunMarkers) {
        check(allOut.includes(marker), `${c.name}: --all stdout missing ${JSON.stringify(marker)}`);
      }
    }

    // Aggregated usage: CLI total line vs independent record-level sums over
    // the rendered HEAD-chain slices.
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
