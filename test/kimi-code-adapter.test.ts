import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { KimiCodeAdapter } from "../src/adapters/kimi-code/index";
import { ManifestSchema } from "../src/schema/manifest";
import { AhsRecordSchema, type AhsRecord } from "../src/schema/record";
import {
  checkIdempotency,
  collectSessions,
  validateSessions,
} from "../src/validate/index";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "kimi-code",
);

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const CHILD_ID = `${SESSION_ID}/agent-0`;

async function readAll(adapter: KimiCodeAdapter, sessionId: string): Promise<AhsRecord[]> {
  const records: AhsRecord[] = [];
  for await (const rec of adapter.readRecords(sessionId)) records.push(rec);
  return records;
}

/** Write a programmatic session dir under a fresh tmp base path. */
function writeSession(
  base: string,
  wd: string,
  uuid: string,
  state: unknown,
  wires: Record<string, string>,
): string {
  const dir = path.join(base, wd, `session_${uuid}`);
  for (const [agent, wire] of Object.entries(wires)) {
    const agentDir = path.join(dir, "agents", agent);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "wire.jsonl"), wire);
  }
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

const tmp = mkdtempSync(path.join(tmpdir(), "kimi-adapter-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("kimi-code adapter", () => {
  const adapter = new KimiCodeAdapter(fixturesDir);

  it("declares harness + capabilities (history full, control false)", () => {
    expect(adapter.harness).toBe("kimi-code");
    expect(adapter.capabilities).toEqual({ history: "full", control: false });
  });

  it("layer 1 (AC-0001-N-1): every manifest and record passes the zod schemas", async () => {
    const sessions = await collectSessions(adapter);
    expect(sessions.length).toBeGreaterThan(0);
    for (const { manifest, records } of sessions) {
      expect(() => ManifestSchema.parse(manifest)).not.toThrow();
      expect(records.length).toBeGreaterThan(0);
      for (const rec of records) {
        expect(() => AhsRecordSchema.parse(rec)).not.toThrow();
      }
    }
  });

  it("layer 1 (AC-0001-E-1): unmappable source events are dropped, output stays schema-clean", async () => {
    // The fixture wire carries permission.*, llm.request, tools.*, plan_mode.*,
    // full_compaction.*, goal telemetry and session-scope usage — none are
    // projectable. Output must still parse and contain no extra fields.
    const records = await readAll(adapter, SESSION_ID);
    for (const rec of records) {
      const parsed = AhsRecordSchema.parse(rec);
      expect(Object.keys(rec).sort()).toEqual(Object.keys(parsed).sort());
    }
  });

  it("layer 2 (AC-0002): all semantic invariants hold on all fixtures", async () => {
    const sessions = await collectSessions(adapter);
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("layer 2 (AC-0002-N-5): idempotent — two runs are byte-identical", async () => {
    expect(await checkIdempotency(adapter)).toEqual([]);
  });

  it("multi-wire = multi-session: sub-agent gets an invocation back-link without atRecordId (AC-0002-N-2, B-3)", async () => {
    const sessions = await collectSessions(adapter);
    const ids = sessions.map((s) => s.manifest.sessionId).sort();
    expect(ids).toEqual([CHILD_ID, SESSION_ID].sort());
    const child = sessions.find((s) => s.manifest.sessionId === CHILD_ID)!.manifest;
    expect(child.invocation).toEqual({ sessionId: SESSION_ID });
    expect(child.invocation).not.toHaveProperty("atRecordId");
  });

  it("maps the manifest from state.json + wire (title/titleOrigin, model, provider, stats)", async () => {
    const sessions = await collectSessions(adapter);
    const main = sessions.find((s) => s.manifest.sessionId === SESSION_ID)!.manifest;
    expect(main).toMatchObject({
      harness: "kimi-code",
      harnessVersion: "unknown", // no CLI version in the source
      cwd: "", // source-unavailable: wd_<id> is a hash, not a path
      title: "修复登录页空指针",
      titleOrigin: "generated",
      model: "moonshot/kimi-k2",
      provider: "moonshot",
    });
    expect(main.stats?.turnCount).toBe(2); // turn.prompt count (user + system_trigger)
    // AC-0002-N-4: record-level usage sums to the source turn-scope totals;
    // the session-scope usage.record (cumulative) is dropped, not double counted.
    expect(main.stats?.totalUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 90,
      cacheReadTokens: 150,
      cacheWriteTokens: 5,
    });
  });

  it("synthesizes a deterministic linear chain per wire (AC-0002-N-1)", async () => {
    const records = await readAll(adapter, SESSION_ID);
    expect(records).toHaveLength(15);
    records.forEach((rec, i) => {
      expect(rec.recordId).toBe(`${SESSION_ID}:${i}`);
      expect(rec.seq).toBe(i);
      // Unix-ms `time` converted to ISO 8601.
      expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("dedups turn.prompt/turn.steer against append_message (AC-0002-N-3: each input emitted once, verbatim)", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const users = records.filter((r) => r.type === "user_message");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      content: [{ type: "text", text: "修复登录页空指针" }],
    });
    // system_trigger + background_task inputs → harness_message (source-marked
    // provenance), one each — no double emission from prompt/steer.
    const harness = records.filter((r) => r.type === "harness_message");
    expect(harness).toHaveLength(2);
    expect(harness[0]).toMatchObject({
      content: [{ type: "text", text: "<system-reminder>后台任务已完成。</system-reminder>" }],
    });
    expect(harness[1]).toMatchObject({
      content: [{ type: "text", text: "<notification>后台任务 x 已完成。</notification>" }],
    });
  });

  it("groups consecutive content.parts into one assistant_message with thinking blocks", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const first = records.find((r) => r.type === "assistant_message");
    expect(first).toMatchObject({
      content: [
        { type: "thinking", text: "先定位空指针出现的位置。" },
        { type: "text", text: "我来查看登录页代码。" },
      ],
    });
  });

  it("maps tool.call/tool.result, derives status completed XOR interrupted (AC-0002-N-6, B-1)", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const calls = records.filter((r) => r.type === "tool_call");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      toolCallId: "call_k001",
      name: "Grep",
      args: { pattern: "session.user", path: "/home/test/demo/src" },
      kind: "file_io",
      status: "completed",
    });
    // The Agent spawning call pairs with its result → completed.
    expect(calls[1]).toMatchObject({ toolCallId: "call_k002", name: "Agent", status: "completed" });
    // call_k003 dangles at wire end → interrupted, no synthetic result.
    expect(calls[2]).toMatchObject({ toolCallId: "call_k003", status: "interrupted" });
    expect(records.some((r) => r.type === "tool_result" && r.toolCallId === "call_k003")).toBe(
      false,
    );
  });

  it("invocation forward link: the Agent tool_result carries the child sessionId (ADR-0005, AC-0002-N-2)", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const result = records.find((r) => r.type === "tool_result" && r.toolCallId === "call_k002");
    expect(result).toMatchObject({
      type: "tool_result",
      status: "success",
      sessionIds: [CHILD_ID],
    });
    // The result content is preserved verbatim (agent_id header included).
    expect(result).toMatchObject({
      content: expect.stringContaining("agent_id: agent-0"),
    });
    // Non-Agent results carry no forward link.
    const grep = records.find((r) => r.type === "tool_result" && r.toolCallId === "call_k001");
    expect(grep).not.toHaveProperty("sessionId");
  });

  it("attaches turn-scope usage to the immediately preceding record", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const result = records.find((r) => r.type === "tool_result");
    expect(result?.usage).toEqual({
      inputTokens: 800,
      outputTokens: 60,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
    });
    const modelChange = records.find((r) => r.type === "model_change");
    expect(modelChange?.usage).toEqual({
      inputTokens: 400,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    });
  });

  it("emits state events: model_change, goal create/verdict (telemetry dropped), compaction", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const modelChange = records.filter((r) => r.type === "model_change");
    expect(modelChange).toHaveLength(1);
    expect(modelChange[0]).toMatchObject({ model: "moonshot/kimi-k2-turbo" });
    const goals = records.filter((r) => r.type === "goal_update");
    // goal.create → pending; verdict complete → met; {tokensUsed} telemetry dropped.
    expect(goals).toHaveLength(2);
    expect(goals[0]).toMatchObject({
      status: "pending",
      goalId: "goal-0001",
      reason: "完成登录页修复并验证",
    });
    expect(goals[1]).toMatchObject({ status: "met" });
    const compactions = records.filter((r) => r.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({
      summary: "## 前文摘要\n用户要求修复登录页空指针，已定位到 login.ts:42。",
    });
  });

  it("appends plans/*.md as a file-side assistant_message at the end", async () => {
    const records = await readAll(adapter, SESSION_ID);
    const last = records[records.length - 1]!;
    expect(last.type).toBe("assistant_message");
    expect(last).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("# Plan: 修复登录页空指针") }],
    });
  });

  it("sub-agent wire: system_trigger prompt is a harness_message, usage lands on the reply", async () => {
    const records = await readAll(adapter, CHILD_ID);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: "harness_message",
      content: [{ type: "text", text: "审查登录页补丁是否正确" }],
    });
    expect(records[1]).toMatchObject({
      type: "assistant_message",
      content: [{ type: "text", text: "补丁正确，无回归风险。" }],
    });
    expect(records[1]?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("throws for an unknown session id", async () => {
    await expect(readAll(adapter, "no-such-session")).rejects.toThrow("session not found");
  });

  it("listSessions honors the harness filter", async () => {
    const mismatched: string[] = [];
    for await (const m of adapter.listSessions({ harness: "codex" })) {
      mismatched.push(m.sessionId);
    }
    expect(mismatched).toEqual([]);
    const matched: string[] = [];
    for await (const m of adapter.listSessions({ harness: "kimi-code" })) {
      matched.push(m.sessionId);
    }
    expect(matched.sort()).toEqual([CHILD_ID, SESSION_ID].sort());
  });

  it("listSessions includeForks: no-op — no lineage is ever emitted, every session is its own group HEAD", async () => {
    const collect = async (includeForks?: boolean): Promise<string[]> => {
      const ids: string[] = [];
      for await (const m of adapter.listSessions(
        includeForks === undefined ? {} : { includeForks },
      )) {
        ids.push(m.sessionId);
      }
      return ids.sort();
    };
    const all = [CHILD_ID, SESSION_ID].sort();
    expect(await collect()).toEqual(all);
    expect(await collect(false)).toEqual(all);
    expect(await collect(true)).toEqual(all);
  });

  it("forward link edge cases: single/swarm Agent results, unresolvable agent_id", async () => {
    const base = path.join(tmp, "forward-link");
    const uuid = "cccccccc-0000-4000-8000-000000000003";
    writeSession(
      base,
      "wd_fwd",
      uuid,
      {
        agents: {
          main: { type: "main", parentAgentId: null },
          "agent-0": { type: "sub", parentAgentId: "main" },
        },
      },
      {
        main: [
          // 1. AgentSwarm result with ONE resolvable subagent entry →
          //    single-element sessionIds (multi-value forward link).
          '{"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"call_s1","name":"AgentSwarm","args":{"items":["a","b"]}},"time":1784541601000}',
          '{"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"call_s1","result":{"output":"<agent_swarm_result>\\n<summary>completed: 1</summary>\\n<subagent agent_id=\\"agent-0\\" item=\\"a\\" outcome=\\"completed\\">done</subagent>\\n</agent_swarm_result>"}},"time":1784541602000}',
          // 2. Agent result without the agent_id header (failure shape) → no link.
          '{"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"call_s2","name":"Agent","args":{"prompt":"p"}},"time":1784541603000}',
          '{"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"call_s2","result":{"output":"Error: subagent crashed"},"is_error":true},"time":1784541604000}',
          // 3. agent_id naming an agent with NO wire in this session dir → no link.
          '{"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"call_s3","name":"Agent","args":{"prompt":"p"}},"time":1784541605000}',
          '{"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"call_s3","result":{"output":"agent_id: agent-9\\nstatus: completed\\n\\n[summary]\\nok"}},"time":1784541606000}',
          // 4. Well-formed Agent result naming agent-0 → forward link.
          '{"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"call_s4","name":"Agent","args":{"prompt":"p"}},"time":1784541607000}',
          '{"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"call_s4","result":{"output":"agent_id: agent-0\\nactual_subagent_type: general\\nstatus: completed\\n\\n[summary]\\nok"}},"time":1784541608000}',
          "",
        ].join("\n"),
        "agent-0":
          '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"子任务"}],"origin":{"kind":"system_trigger"}},"time":1784541601500}\n',
      },
    );
    const fwd = new KimiCodeAdapter(base);
    const sessions = await collectSessions(fwd);
    expect(validateSessions(sessions)).toEqual([]);
    const main = sessions.find((s) => s.manifest.sessionId === uuid)!;
    const byCallId = new Map(
      main.records.filter((r) => r.type === "tool_result").map((r) => [r.toolCallId, r]),
    );
    expect(byCallId.get("call_s1")).toMatchObject({ sessionIds: [`${uuid}/agent-0`] }); // swarm, 1 resolved
    expect(byCallId.get("call_s2")).not.toHaveProperty("sessionIds"); // no agent_id header
    expect(byCallId.get("call_s3")).not.toHaveProperty("sessionIds"); // unknown agent
    expect(byCallId.get("call_s4")).toMatchObject({ sessionIds: [`${uuid}/agent-0`] });
  });

  it("AgentSwarm with MULTIPLE children lists ALL resolved session ids in sessionIds (AC-0002-N-2)", async () => {
    const base = path.join(tmp, "swarm-multi");
    const uuid = "cccccccc-0000-4000-8000-000000000004";
    writeSession(
      base,
      "wd_swarm",
      uuid,
      {
        agents: {
          main: { type: "main", parentAgentId: null },
          "agent-0": { type: "sub", parentAgentId: "main" },
          "agent-1": { type: "sub", parentAgentId: "main" },
          "agent-2": { type: "sub", parentAgentId: "main" },
        },
      },
      {
        main: [
          // Three subagent entries, one of which (agent-9) has no wire in
          // this session dir → only the two resolved children are listed,
          // in output order.
          '{"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"call_sw","name":"AgentSwarm","args":{"items":["a","b","c"]}},"time":1784541601000}',
          '{"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"call_sw","result":{"output":"<agent_swarm_result>\\n<summary>completed: 2, failed: 1</summary>\\n<subagent agent_id=\\"agent-1\\" item=\\"b\\" outcome=\\"completed\\">done-b</subagent>\\n<subagent agent_id=\\"agent-9\\" item=\\"x\\" outcome=\\"failed\\">lost</subagent>\\n<subagent agent_id=\\"agent-0\\" item=\\"a\\" outcome=\\"completed\\">done-a</subagent>\\n</agent_swarm_result>"}},"time":1784541602000}',
          "",
        ].join("\n"),
        "agent-0":
          '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"任务A"}],"origin":{"kind":"system_trigger"}},"time":1784541601500}\n',
        "agent-1":
          '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"任务B"}],"origin":{"kind":"system_trigger"}},"time":1784541601501}\n',
        "agent-2":
          '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"任务C"}],"origin":{"kind":"system_trigger"}},"time":1784541601502}\n',
      },
    );
    const swarm = new KimiCodeAdapter(base);
    const sessions = await collectSessions(swarm);
    expect(validateSessions(sessions)).toEqual([]);
    const main = sessions.find((s) => s.manifest.sessionId === uuid)!;
    const result = main.records.find(
      (r) => r.type === "tool_result" && r.toolCallId === "call_sw",
    )!;
    expect(result).toMatchObject({
      sessionIds: [`${uuid}/agent-1`, `${uuid}/agent-0`], // output order, unresolved dropped
    });
  });

  it("AC-0002-B-2: a wire without usage.record yields no usage fields (nothing fabricated)", async () => {
    const base = path.join(tmp, "no-usage");
    const uuid = "aaaaaaaa-0000-4000-8000-000000000001";
    writeSession(
      base,
      "wd_noUsage",
      uuid,
      { title: "no usage", isCustomTitle: true, agents: { main: { type: "main", parentAgentId: null } } },
      {
        main: [
          '{"type":"metadata","protocol_version":"1.4","created_at":1784541600000}',
          '{"type":"config.update","modelAlias":"moonshot/kimi-k2","time":1784541600100}',
          '{"type":"turn.prompt","input":[{"type":"text","text":"hi"}],"origin":{"kind":"user"},"time":1784541601000}',
          '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"hi"}],"origin":{"kind":"user"}},"time":1784541601001}',
          '{"type":"context.append_loop_event","event":{"type":"content.part","uuid":"p-1","turnId":"0","step":1,"stepUuid":"s-1","part":{"type":"text","text":"hello"}},"time":1784541602000}',
          "",
        ].join("\n"),
      },
    );
    const noUsage = new KimiCodeAdapter(base);
    const sessions = await collectSessions(noUsage);
    expect(sessions).toHaveLength(1);
    const { manifest, records } = sessions[0]!;
    expect(manifest.titleOrigin).toBe("custom");
    expect(manifest.stats?.totalUsage).toBeUndefined();
    expect(records.every((r) => r.usage === undefined)).toBe(true);
    expect(validateSessions(sessions)).toEqual([]);
  });

  it("tolerates a truncated tail line (crash mid-write) and skips empty wires", async () => {
    const base = path.join(tmp, "truncated");
    const uuid = "bbbbbbbb-0000-4000-8000-000000000002";
    writeSession(
      base,
      "wd_trunc",
      uuid,
      { agents: { main: { type: "main", parentAgentId: null }, "agent-9": { type: "sub", parentAgentId: "main" } } },
      {
        main:
          '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"完整的一行"}],"origin":{"kind":"user"}},"time":1784541601001}\n' +
          '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"半截',
        // agent-9's wire is empty → not an AHS session, skipped.
        "agent-9": "",
      },
    );
    const trunc = new KimiCodeAdapter(base);
    const sessions = await collectSessions(trunc);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.records).toHaveLength(1);
    expect(sessions[0]!.records[0]).toMatchObject({
      type: "user_message",
      content: [{ type: "text", text: "完整的一行" }],
    });
    expect(validateSessions(sessions)).toEqual([]);
  });
});
