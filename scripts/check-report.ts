/**
 * Report gate (提测门禁): validates execution reports in docs/plans containers.
 *
 * Every file matching "*-report-*.md" in a container directory is checked for:
 *   1. frontmatter with `type: report`, a non-empty `status`, and `created`
 *   2. at least one AC id matching the pattern AC-XXXX-[NBEF]-n
 *   3. at least one commit reference (7-40 lowercase hex chars)
 *
 * Design decisions:
 *   - Containers whose directory ends in "-template" are skipped: their
 *     reports are writing placeholders, not executions.
 *   - Vacuous pass: if no reports exist yet, the gate passes. The gate
 *     guarantees completeness of *written* reports; that a plan actually
 *     produced its report is enforced by the container README status table.
 *   - TEST_INFRA reports reference the AC ids they provide infrastructure
 *     for (see report body); adapter AC verification itself is DEVELOP work.
 *
 * Exit code 0 on pass, 1 on any violation. Run with: npm run check:report
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PLANS_DIR = join(import.meta.dirname, "..", "docs", "plans");

const REPORT_FILE = /-report-.+\.md$/;
const AC_ID = /AC-\d{4}-[NBEF]-\d+/;
const COMMIT_REF = /\b[0-9a-f]{7,40}\b/;

interface Violation {
  file: string;
  reason: string;
}

function frontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match || match[1] === undefined) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv && kv[1] !== undefined && kv[2] !== undefined) {
      fields[kv[1]] = kv[2].trim();
    }
  }
  return fields;
}

function validate(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const fm = frontmatter(content);
  if (!fm) {
    violations.push({ file, reason: "missing or malformed frontmatter" });
  } else {
    if (fm["type"] !== "report") {
      violations.push({ file, reason: `frontmatter type must be "report", got "${fm["type"] ?? ""}"` });
    }
    if (!fm["status"]) {
      violations.push({ file, reason: "frontmatter missing status" });
    }
    if (!fm["created"]) {
      violations.push({ file, reason: "frontmatter missing created" });
    }
  }
  if (!AC_ID.test(content)) {
    violations.push({ file, reason: "no AC id matching AC-\\d{4}-[NBEF]-\\d+" });
  }
  if (!COMMIT_REF.test(content)) {
    violations.push({ file, reason: "no commit reference (7-40 hex)" });
  }
  return violations;
}

const violations: Violation[] = [];
let reportCount = 0;

for (const entry of readdirSync(PLANS_DIR)) {
  const dir = join(PLANS_DIR, entry);
  if (!statSync(dir).isDirectory() || entry.endsWith("-template")) continue;
  for (const file of readdirSync(dir)) {
    if (!REPORT_FILE.test(file)) continue;
    reportCount += 1;
    violations.push(...validate(join(dir, file), readFileSync(join(dir, file), "utf8")));
  }
}

if (violations.length > 0) {
  console.error(`[check-report] FAIL — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  process.exit(1);
}

console.log(`[check-report] OK — ${reportCount} report(s) validated (${reportCount === 0 ? "vacuous pass, none exist yet" : "all pass"})`);
