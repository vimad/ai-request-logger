import assert from "node:assert/strict";
import { basename } from "node:path";
import { after, before, describe, it } from "node:test";
import { codex } from "../../src/codex/index.ts";
import { digestTurn, listSessions, type VizTurn } from "../../src/viz/digest.ts";
import { startMockUpstream } from "../codex/upstream.ts";
import { sessionDir, settle, startHarness, turnDirs, type Harness } from "../helpers/harness.ts";

const SESSION = "viz-codex-thread-0001";
const TOOLS = {
  type: "additional_tools",
  role: "developer",
  tools: [
    { type: "custom", name: "exec", description: "Run a script that drives the tools." },
    { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", description: "Start a sub-agent.", parameters: { type: "object" } }] },
  ],
};
const DEV = { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex, a coding agent." }] };
const ENV = { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>" }] };
const PROMPT = { type: "message", role: "user", content: [{ type: "input_text", text: "run echo hi" }] };

function headers(extra: Record<string, string> = {}) {
  return {
    "session-id": SESSION,
    "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
    authorization: "Bearer FAKE-CHATGPT-TOKEN",
    ...extra,
  };
}

/**
 * One Codex turn: a lap that asks for `exec`, a lap that answers, then a
 * compaction call and a sub-agent request folded into the same turn. The
 * second lap replays the tool call exactly as Codex does: the streamed item
 * without its `id` and `status`.
 */
async function capture(h: Harness): Promise<void> {
  const send = (input: unknown[], extra?: Record<string, string>) =>
    h.send({ model: "gpt-5.6-terra", stream: true, store: false, input }, headers(extra), "/responses").then((r) => r.text());

  await send([TOOLS, DEV, ENV, PROMPT]);
  await send([
    TOOLS, DEV, ENV, PROMPT,
    { type: "custom_tool_call", call_id: "call_1", name: "exec", input: 'const r = await tools.exec_command({cmd:"echo hi"})' },
    { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "hi" }] },
  ]);
  await send([{ type: "message", role: "user", content: [{ type: "input_text", text: "Summarise the conversation." }] }], {
    "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
  });
  await send([TOOLS, { type: "message", role: "user", content: [{ type: "input_text", text: "search for foo" }] }], {
    "x-codex-window-id": `${SESSION}:1`,
  });
  await settle(400);
}

describe("viz digest: a Codex turn becomes the same model", () => {
  let h: Harness;
  let turn: VizTurn;

  before(async () => {
    h = await startHarness({ provider: codex, startUpstream: startMockUpstream });
    await capture(h);
    const session = sessionDir(h.logDir, SESSION);
    turn = digestTurn(h.logDir, basename(session), basename(turnDirs(session)[0]!));
  });
  after(() => h.close());

  it("lists the session as one the visualizer understands", () => {
    const s = listSessions(h.logDir).find((x) => x.id === SESSION)!;
    assert.equal(s.supported, true);
    assert.equal(s.harness, "Codex CLI");
    assert.equal(s.turns[0]!.main, 2);
    assert.equal(s.turns[0]!.background, 2);
    assert.ok(s.turns[0]!.tokens > 0);
    assert.equal(turn.harness.name, "Codex CLI");
    assert.deepEqual(turn.warnings, []);
  });

  it("names each request's purpose", () => {
    assert.deepEqual(turn.requests.map((r) => r.purpose.id), ["loop", "loop", "compact", "subagent"]);
    assert.equal(turn.requests[1]!.prevKey, "r1");
  });

  it("splits the flat input into system, tools and conversation", () => {
    const r1 = turn.requests[0]!;
    assert.deepEqual(r1.system.map((x) => turn.blobs[x.b]!.text), ["You are Codex, a coding agent."]);
    const tools = r1.tools.map((x) => turn.blobs[x.b]!);
    assert.deepEqual(tools.map((t) => t.name), ["exec", "spawn_agent"]);
    assert.equal(tools[1]!.group, "Namespace · collaboration");
    assert.deepEqual(r1.messages.map((m) => m.label), ["input[2]", "input[3]"]);
    assert.deepEqual(r1.messages.map((m) => turn.blobs[m.refs[0]!.b]!.cat), ["reminder", "prompt"]);
    assert.equal(r1.params.store, false);
    assert.equal(r1.params.input, undefined);
  });

  it("recognises the tool call when it comes back as input", () => {
    const [r1, r2] = turn.requests;
    const call = turn.blobs[r1!.response[0]!.b]!;
    assert.equal(call.cat, "tool_use");
    assert.equal(call.label, "exec: echo hi");
    assert.equal(call.toolUseId, "call_1");
    assert.equal(r2!.messages[2]!.refs[0]!.b, r1!.response[0]!.b);
    const out = turn.blobs[r2!.messages[3]!.refs[0]!.b]!;
    assert.equal(out.cat, "tool_result");
    assert.equal(out.text, "hi");
    assert.equal(r2!.messages[3]!.role, "tool");
  });

  it("normalises how each reply ended, and keeps the wire value", () => {
    const [r1, r2] = turn.requests;
    assert.equal(r1!.stop, "tool_use");
    assert.equal(r2!.stop, "end_turn");
    assert.equal(r2!.stopReason, "completed");
    assert.equal(turn.blobs[r2!.response[0]!.b]!.text, "Let me check that.");
  });

  it("colours a background call's own prompt as the harness's", () => {
    const compact = turn.requests[2]!;
    assert.equal(turn.blobs[compact.messages[0]!.refs[0]!.b]!.cat, "synthetic");
  });

  it("carries tokens and a stream summary per output item", () => {
    const [r1, r2] = turn.requests;
    assert.deepEqual(r1!.tokens, { input: 100, output: 40, cacheRead: 20, cacheWrite: 0, total: 160 });
    assert.deepEqual(r1!.stream_?.blocks.map((b) => b.type), ["tool_use"]);
    assert.deepEqual(r2!.stream_?.blocks.map((b) => b.type), ["text"]);
    assert.ok(r2!.stream_!.blocks[0]!.deltas >= 3);
    assert.ok(r1!.sentChars > 0);
  });
});
