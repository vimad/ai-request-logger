import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { digestTurn, listSessions, type VizTurn } from "../../src/viz/digest.ts";

/*
 * A Cursor session written straight to disk, in the shapes the Cursor provider
 * logs, arranged the way real captures are:
 *
 * - the first run stream lands in turn-000 (it opens before the prompt), drops
 *   after two model calls, and reconnects under turn-001, replaying the last
 *   assistant message with extra providerOptions;
 * - the second prompt's run stream lands in turn-001 too, and re-sends none of
 *   the earlier conversation.
 *
 * Synthetic rather than captured, so no real prompt, path or key is committed.
 */

const T0 = Date.parse("2026-01-01T10:00:00.000Z");
const SESSION = "2026-01-01T10-00-00__session-cli-test";
const Q1 = "fix the bug in calc.py";
const Q2 = "now add subtract()";

const SYSTEM = { role: "system", content: "You are an AI coding assistant, powered by Cursor." };
const USER_INFO = {
  role: "user",
  content: "<user_info>\nOS Version: test\n</user_info>\n\n<rules>\nAlways be brief.\n</rules>\n\n<agent_skills>\nUse a skill by reading it.\n<available_skills>\n<agent_skill fullPath=\"/home/u/.cursor/skills/create-rule/SKILL.md\">Create Cursor rules.</agent_skill>\n</available_skills>\n</agent_skills>",
};
const query = (q: string) => ({ role: "user", content: [{ type: "text", text: `<timestamp>Thursday</timestamp>\n<user_query>\n${q}\n</user_query>` }] });
const call = (id: string, toolName: string, args: unknown) => ({ type: "tool-call", toolCallId: id, toolName, args });
const reasoning = (sig: string) => ({ type: "reasoning", text: "", signature: sig, providerOptions: { cursor: { modelName: "cursor-test-model" } } });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const tool = (id: string, toolName: string, result: string) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, result }] });

const A1 = assistant(reasoning("s1"), { type: "text", text: "Reading it." }, call("c1", "Read", { path: "calc.py" }));
const A2 = assistant(reasoning("s2"), call("c2", "StrReplace", { path: "calc.py", old_string: "-", new_string: "+" }));
const A3 = assistant(reasoning("s3"), { type: "text", text: "Fixed." });
const A4 = assistant(reasoning("s4"), call("c4", "Shell", { command: "grep def calc.py" }));
const A5 = assistant(reasoning("s5"), { type: "text", text: "Added subtract." });

type Ev = { event: string; data: unknown };
const msg = (content: unknown, seq?: number): Ev => ({ event: "message", data: { seq, role: (content as any).role, content } });
const think = (at: number, text: string): Ev[] => [
  { event: "run.control", data: { f4: { f1: text, f2: 1 }, f25: at } },
  { event: "message", data: { content: { f3: { f1: text, f2: 1, f3: at, f4: at + 1 } } } },
];
const toolRun = (id: string, start: number, end: number): Ev[] => [
  { event: "run.control", data: { f7: { f1: id, f2: { f57: id, f59: start } }, f25: start } },
  { event: "run.control", data: { f3: { f1: id, f2: { f57: id, f59: start, f60: end } }, f25: start } },
];
const usage = (used: number): Ev => ({
  event: "run.state",
  data: { usage: { usedTokens: used, maxTokens: 200000, components: [{ id: "tools", label: "Tool definitions", tokens: 900, chars: 3000 }] } },
});

let root: string;

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function turn(dir: string, n: number, label: string, startedAt: number, input?: string): void {
  const base = join(root, SESSION, dir);
  write(join(base, "turn.json"), { turn: n, label, startedAt: new Date(startedAt).toISOString(), requests: [] });
  if (input) write(join(base, "user-input.txt"), input);
}

function run(dir: string, req: string, at: number, events: Ev[]): void {
  const base = join(root, SESSION, dir, req);
  write(join(base, "request.json"), {
    at: new Date(at).toISOString(),
    path: "/agent.v1.AgentService/RunSSE",
    shape: { kind: "aux", endpoint: "RunSSE", stream: true },
    headers: { "x-cursor-client-type": "cli" },
  });
  write(join(base, "response.json"), { status: 200, headers: {}, body: {} });
  write(join(base, "stream.jsonl"), events.map((e) => JSON.stringify({ at: 0, ...e })).join("\n") + "\n");
}

function append(dir: string, req: string, eventFields: number[], extra: Record<string, unknown> = {}): void {
  write(join(root, SESSION, dir, req, "request.json"), {
    at: new Date(T0).toISOString(),
    path: "/aiserver.v1.BidiService/BidiAppend",
    shape: { kind: eventFields[0] === 1 ? "main" : "aux", endpoint: "BidiAppend", eventFields, ...extra },
    headers: {},
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "viz-cursor-"));
  write(join(root, SESSION, "session.json"), { session: "cli-test", provider: "cursor", startedAt: new Date(T0).toISOString() });
  turn("turn-000__background", 0, "background", T0);
  turn("turn-001__fix-the-bug", 1, Q1, T0 + 10, Q1);
  turn("turn-002__now-add-subtract", 2, Q2, T0 + 60_000, Q2);

  // Run 1, filed under turn-000: two model calls, then the stream drops.
  run("turn-000__background", "req-001__aux", T0, [
    msg(SYSTEM), msg(USER_INFO, 1), msg(query(Q1), 4),
    ...think(T0 + 1000, "Reading calc.py first."),
    ...toolRun("c1", T0 + 1010, T0 + 2000),
    msg(A1, 8), msg(tool("c1", "Read", "def add(a, b): return a - b"), 9),
    usage(5000),
    ...think(T0 + 3000, "Found the bug."),
    ...toolRun("c2", T0 + 3010, T0 + 4000),
    msg(A2, 17),
  ]);
  // The reconnect, filed under turn-001: A2 comes back with extra fields.
  run("turn-001__fix-the-bug", "req-038__aux", T0 + 5000, [
    msg({ ...A2, id: "msg_2", providerOptions: { cursor: { pendingToolCallStartedAtMs: 1 } } }),
    msg(tool("c2", "StrReplace", "updated"), 1),
    usage(5200),
    ...think(T0 + 6000, "Done."),
    { event: "message", data: { content: { f1: { f1: "Fixed.", f2: T0 + 6100 } } } },
    msg(A3, 8),
  ]);
  // Run 2 also lands in turn-001, and sends only what is new.
  run("turn-001__fix-the-bug", "req-071__aux", T0 + 60_000, [
    msg(query(Q2), 2),
    usage(5400),
    ...think(T0 + 61_000, "Checking with grep."),
    ...toolRun("c4", T0 + 61_010, T0 + 62_000),
    msg(A4, 5), msg(tool("c4", "Shell", "def add\ndef subtract"), 6),
    usage(5600),
    ...think(T0 + 63_000, "Both exist."),
    msg(A5, 9),
  ]);
  // The client events: the prompt, a tool result, a heartbeat, an ack.
  append("turn-001__fix-the-bug", "req-001__main__m", [1], { conversationId: "conv-1", runId: "run-1", model: "test-model" });
  append("turn-001__fix-the-bug", "req-002__aux", [2]);
  append("turn-001__fix-the-bug", "req-003__aux", [7]);
  append("turn-001__fix-the-bug", "req-004__aux", [3]);
  append("turn-002__now-add-subtract", "req-001__main__m", [1]);
});

after(() => rmSync(root, { recursive: true, force: true }));

const blobsOf = (t: VizTurn, refs: Array<{ b: string }>) => refs.map((r) => t.blobs[r.b]!);

describe("viz digest: a Cursor session is rebuilt into model calls", () => {
  it("makes one request per assistant message, assigned to the turn whose prompt it answers", () => {
    const t1 = digestTurn(root, SESSION, "turn-001__fix-the-bug");
    const t2 = digestTurn(root, SESSION, "turn-002__now-add-subtract");
    assert.equal(t1.harness.id, "cursor");
    assert.deepEqual(t1.requests.map((r) => r.stop), ["tool_use", "tool_use", "end_turn"]);
    assert.deepEqual(t2.requests.map((r) => r.stop), ["tool_use", "end_turn"]);
    assert.ok(t1.requests.every((r) => r.kind === "main" && !r.fromBackground));
    // Each request points at the stream it came from, wherever that was filed.
    assert.deepEqual(t1.requests.map((r) => `${r.rawTurn}/${r.dir}`), [
      "turn-000__background/req-001__aux",
      "turn-000__background/req-001__aux",
      "turn-001__fix-the-bug/req-038__aux",
    ]);
    assert.equal(t2.requests[0]!.rawTurn, "turn-001__fix-the-bug");
  });

  it("counts a message replayed after a reconnect once", () => {
    const t1 = digestTurn(root, SESSION, "turn-001__fix-the-bug");
    const last = t1.requests.at(-1)!;
    const toolCalls = last.messages.flatMap((m) => blobsOf(t1, m.refs)).filter((b) => b.cat === "tool_use");
    assert.deepEqual(toolCalls.map((b) => b.name), ["Read", "StrReplace"]);
    // The replayed A2 hashes the same as the original, so it reads as the echo.
    assert.equal(t1.requests[1]!.response[1]!.b, last.messages.find((m) => m.role === "assistant" && m.refs.length === 2)!.refs[1]!.b);
  });

  it("carries the earlier conversation into a later turn's context", () => {
    const t2 = digestTurn(root, SESSION, "turn-002__now-add-subtract");
    const first = t2.requests[0]!;
    assert.equal(blobsOf(t2, first.system)[0]!.text, SYSTEM.content);
    const prompts = first.messages.flatMap((m) => blobsOf(t2, m.refs)).filter((b) => b.cat === "prompt").map((b) => b.label);
    assert.deepEqual(prompts, [Q1, Q2]);
    assert.equal(first.prevKey, undefined);
    assert.equal(t2.requests[1]!.prevKey, first.key);
  });

  it("splits Cursor's injected context into its sections, and reads summaries as thinking", () => {
    const t1 = digestTurn(root, SESSION, "turn-001__fix-the-bug");
    const r = t1.requests[0]!;
    const injected = blobsOf(t1, r.messages[0]!.refs);
    assert.ok(injected.every((b) => b.cat === "reminder"));
    assert.deepEqual(injected.map((b) => b.label.split(" · ")[0]), ["Your environment <user_info>", "Rules <rules>", "Skills <agent_skills>"]);
    assert.equal(injected.map((b) => b.text).join(""), USER_INFO.content, "nothing lost in the split");
    assert.deepEqual(injected[2]!.skills, [
      { name: "create-rule", description: "Create Cursor rules.", path: "/home/u/.cursor/skills/create-rule/SKILL.md", chars: 102 },
    ]);
    const [thinking] = blobsOf(t1, r.response);
    assert.equal(thinking!.cat, "thinking");
    assert.match(thinking!.text, /Reading calc\.py first\./);
  });

  it("times each call from the server's clock: tool gaps sit between laps", () => {
    const t1 = digestTurn(root, SESSION, "turn-001__fix-the-bug");
    const [a, b, c] = t1.requests;
    assert.equal(a!.at, T0 + 10, "the first call starts with the prompt");
    assert.equal(a!.ttfbMs, 990);
    assert.equal(b!.at, T0 + 2000, "the next starts when the tool result is in");
    assert.equal(c!.at, T0 + 4000);
    assert.equal(c!.durationMs, 2100);
    assert.equal(b!.tokens?.input, 5000);
    assert.equal(b!.params.contextWindow, "5,000 of 200,000 tokens");
  });

  it("stands in for the tool schemas it cannot see, at the size Cursor reports", () => {
    const t1 = digestTurn(root, SESSION, "turn-001__fix-the-bug");
    const tools = blobsOf(t1, t1.requests[0]!.tools);
    assert.ok(["Read", "Shell", "StrReplace"].every((n) => tools.some((b) => b.name === n)));
    const total = tools.reduce((n, b) => n + b.chars, 0);
    assert.equal(total, 3000);
  });

  it("explains itself in notes, and counts the client events it leaves out", () => {
    const t1 = digestTurn(root, SESSION, "turn-001__fix-the-bug");
    assert.deepEqual(t1.warnings, []);
    const notes = t1.notes.join("\n");
    assert.match(notes, /4 BidiAppend calls .* 1 tool results .* 1 heartbeats and 1 acknowledgements/);
    assert.match(notes, /opened 2 times/);
    assert.match(notes, /turn-000__background\/req-001__aux/);
  });

  it("lists model calls per turn on the home page, not HTTP requests", () => {
    const s = listSessions(root).find((x) => x.dir === SESSION)!;
    assert.equal(s.supported, true);
    assert.equal(s.harness, "Cursor");
    assert.deepEqual(s.turns.map((t) => [t.requests, t.main, t.background]), [[3, 3, 0], [2, 2, 0]]);
  });
});
