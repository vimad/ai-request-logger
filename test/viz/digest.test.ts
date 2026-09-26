import assert from "node:assert/strict";
import { basename } from "node:path";
import { after, before, describe, it } from "node:test";
import { digestTurn, listSessions, type VizTurn } from "../../src/viz/digest.ts";
import { ccHeaders, sessionDir, settle, startHarness, turnDirs, TOOLS, type Harness } from "../helpers/harness.ts";

const SESSION = "viz-session-0001";
const SYSTEM = [
  { type: "text", text: "x-anthropic-billing-header: cc_version=test;" },
  { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
];
const REMINDER = { type: "text", text: "<system-reminder>\n# Environment\ncwd: /repo\n</system-reminder>" };
const PROMPT = { type: "text", text: "list the files" };

/**
 * One realistic turn: a title call before it, two laps of the agent loop,
 * and the next-prompt suggestion after it. Built through the real proxy, so
 * the digest reads exactly what the logger writes.
 */
async function capture(h: Harness): Promise<void> {
  const send = (body: Record<string, unknown>) =>
    h.send({ model: "claude-opus-5", max_tokens: 1024, stream: true, ...body }, ccHeaders(SESSION)).then((r) => r.text());

  await send({
    system: [{ type: "text", text: "You are naming a coding session so the user can pick it out of a list." }],
    messages: [{ role: "user", content: "<session>list the files</session>" }],
  });

  const history: any[] = [{ role: "user", content: [REMINDER, { ...PROMPT, cache_control: { type: "ephemeral" } }] }];
  await send({ system: SYSTEM, tools: TOOLS, messages: history });

  // Lap 2: the mock's reply comes back verbatim, but with the breakpoint
  // moved onto it - exactly what Claude Code does between requests.
  history[0] = { role: "user", content: [REMINDER, PROMPT] };
  history.push({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check that." },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" }, cache_control: { type: "ephemeral" } },
    ],
  });
  history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" }] });
  await send({ system: SYSTEM, tools: TOOLS, messages: history });

  history.push({ role: "assistant", content: [{ type: "text", text: "Let me check that." }] });
  await send({
    system: SYSTEM,
    tools: TOOLS,
    messages: [...history, { role: "user", content: "[SUGGESTION MODE: Suggest what the user might type next.]" }],
  });
  await settle(400);
}

describe("viz digest: a captured turn becomes the visualizer's model", () => {
  let h: Harness;
  let turn: VizTurn;

  before(async () => {
    h = await startHarness();
    await capture(h);
    const session = sessionDir(h.logDir, SESSION);
    const turnDir = turnDirs(session).find((d) => basename(d).startsWith("turn-001"))!;
    turn = digestTurn(h.logDir, basename(session), basename(turnDir));
  });
  after(() => h.close());

  it("lists the turn without the background bucket", () => {
    const sessions = listSessions(h.logDir);
    const s = sessions.find((x) => x.id === SESSION)!;
    assert.equal(s.supported, true);
    assert.equal(s.turns.length, 1);
    assert.equal(s.turns[0]!.main, 2);
    assert.equal(s.turns[0]!.background, 1);
  });

  it("pulls in the pre-turn background call and orders everything by time", () => {
    assert.deepEqual(turn.requests.map((r) => r.key), ["bg1", "r1", "r2", "r3"]);
    assert.deepEqual(turn.requests.map((r) => r.purpose.id), ["title", "loop", "loop", "suggestion"]);
    assert.equal(turn.requests[0]!.fromBackground, true);
    assert.ok(turn.backgroundDir?.startsWith("turn-000"));
  });

  it("stores identical content once, so re-sends are visible as shared references", () => {
    const [, r1, r2, r3] = turn.requests;
    assert.deepEqual(r2!.system.map((x) => x.b), r1!.system.map((x) => x.b));
    assert.deepEqual(r3!.tools.map((x) => x.b), r1!.tools.map((x) => x.b));
    // The prompt carried a cache_control in lap 1 and not in lap 2: same blob.
    assert.equal(r2!.messages[0]!.refs[1]!.b, r1!.messages[0]!.refs[1]!.b);
    assert.equal(r1!.messages[0]!.refs[1]!.cache, true);
    assert.equal(r2!.messages[0]!.refs[1]!.cache, undefined);
  });

  it("recognises the model's reply when it comes back as input", () => {
    const [, r1, r2] = turn.requests;
    assert.deepEqual(r2!.messages[1]!.refs.map((x) => x.b), r1!.response.map((x) => x.b));
    assert.equal(r2!.prevKey, "r1");
    assert.equal(turn.requests[3]!.prevKey, "r2");
  });

  it("colours each block by who wrote it", () => {
    const cat = (id: string) => turn.blobs[id]!.cat;
    const [bg1, r1, r2, r3] = turn.requests;
    assert.deepEqual(r1!.messages[0]!.refs.map((x) => cat(x.b)), ["reminder", "prompt"]);
    assert.deepEqual(r2!.messages.map((m) => m.refs.map((x) => cat(x.b)).join("+")), ["reminder+prompt", "assistant+tool_use", "tool_result"]);
    assert.equal(cat(r3!.messages.at(-1)!.refs[0]!.b), "synthetic");
    // The title call's prompt wraps your words, but the harness wrote it.
    assert.equal(cat(bg1!.messages[0]!.refs[0]!.b), "synthetic");
    assert.equal(turn.blobs[r1!.tools[0]!.b]!.name, "Bash");
    assert.equal(turn.blobs[r2!.messages[1]!.refs[1]!.b]!.label, "Bash: ls -la");
  });

  it("carries tokens, timing and a stream summary", () => {
    const r1 = turn.requests[1]!;
    assert.equal(r1.stopReason, "tool_use");
    assert.ok(r1.tokens && r1.tokens.input > 0);
    assert.ok(r1.durationMs !== undefined && r1.ttfbMs !== undefined);
    assert.deepEqual(r1.stream_?.blocks.map((b) => b.type), ["text", "tool_use"]);
    assert.ok(r1.sentChars > 0);
    assert.equal(r1.params.max_tokens, 1024);
    assert.equal(r1.headers.authorization?.startsWith("<redacted"), true);
  });
});
