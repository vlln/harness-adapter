import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DevinAdapter } from "../src/adapters/devin/index";
import { collectSessions, stableSerialize } from "../src/validate/index";
import { createDevinFixture } from "../test/fixtures/devin-db";

const dir = await mkdtemp(path.join(tmpdir(), "devin-golden-"));
const adapter = new DevinAdapter(createDevinFixture(dir));
const sessions = await collectSessions(adapter);
await writeFile(
  path.join(import.meta.dirname, "..", "test", "fixtures", "devin-golden.json"),
  `${stableSerialize(sessions)}\n`,
  "utf8",
);
await rm(dir, { recursive: true, force: true });
console.log("golden written");
