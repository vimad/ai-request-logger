import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { codex } from "../../src/codex/index.ts";
import { renderSessionDir } from "../../src/core/report.ts";
import {
  readJson,
  readText,
  requestDirs,
  sessionDir,
  settle,
  startHarness,
  turnDirs,
  type Harness,
} from "../helpers/harness.ts";
import { startMockUpstream } from "./upstream.ts";

const SESSION = "e2e-thread-0001";
const ADDITIONAL_TOOLS = { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec" }] };
const DEV = { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] };

function turnHeaders(extra: Record<string, string> = {}) {
  return {
    "session-id": SESSION,
    "thread-id": SESSION,
    "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user", sandbox: "seatbelt" }),
    authorization: "Bearer FAKE-CHATGPT-TOKEN",
    ...extra,
  };
}

/** Drives one user turn through the proxy, following the tool loop to the end. */
async function runTurn(h: Harness, history: any[], prompt: string): Promise<number> {
  history.push({ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
  let hops = 0;
  for (;;) {
    const res = await h.send(
      { model: "gpt-5.6-terra", stream: true, input: [ADDITIONAL_TOOLS, DEV, ...history] },
      turnHeaders(),
      "/responses",
    );
    const text = await res.text();
    hops++;
    if (!text.includes("custom_tool_call")) break;
    history.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] });
    history.push({ type: "custom_tool_call", name: "exec", call_id: "call_1" });
    history.push({ type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "hi" }] });
  }
  return hops;
}

describe("end to end: a Codex CLI session becomes a log tree", () => {
  let h: Harness;
  let session: string;

  before(async () => {
    h = await startHarness({ provider: codex, startUpstream: startMockUpstream });
    const history: any[] = [];

    // Turn 1: opens with a tool call, so it takes two provider requests.
    await runTurn(h, history, "run echo hi");

    // A background call: turn metadata says this is not a user turn, so it
    // must fold into the turn in flight rather than opening its own.
    await h
      .send(
        { model: "gpt-5.6-terra", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact" }] }] },
        turnHeaders({ "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) }),
        "/responses",
      )
      .then((r) => r.text());

    // A sub-agent request, marked by a non-zero window id; belongs to the turn that spawned it.
    await h
      .send(
        { model: "gpt-5.6-terra", stream: true, input: [ADDITIONAL_TOOLS, { type: "message", role: "user", content: [{ type: "input_text", text: "search for foo" }] }] },
        turnHeaders({ "x-codex-window-id": `${SESSION}:1` }),
        "/responses",
      )
      .then((r) => r.text());

    // Turn 2.
    await runTurn(h, history, "now explain what you found");

    // A plumbing call that carries no turn at all.
    await h.send("", { authorization: "Bearer FAKE-CHATGPT-TOKEN" }, "/models?client_version=1").then((r) => r.text());

    await settle(400);
    session = sessionDir(h.logDir, SESSION);
  });

  after(async () => {
    await h.close();
  });

  it("groups provider requests under the turn that caused them", () => {
    const turns = turnDirs(session).map((d) => d.split("/").pop()!);
    assert.deepEqual(turns, ["turn-001__run-echo-hi", "turn-002__now-explain-what-you-found"]);
  });

  it("keeps the tool loop, the background call and the sub-agent in turn 1", () => {
    const turn1 = turnDirs(session)[0]!;
    const shapes = requestDirs(turn1).map((d) => readJson(join(d, "request.json")).shape);
    // main (tool call) + main (final answer) + aux (compaction) + main (sub-agent)
    assert.equal(shapes.length, 4, "one turn, four provider requests");
    assert.equal(shapes.filter((s) => s.kind === "aux").length, 1);
    assert.ok(shapes.some((s) => s.agentId === `${SESSION}:1`), "the sub-agent request stays inside the turn");
  });

  it("writes the raw capture and the readable view side by side", () => {
    const first = requestDirs(turnDirs(session)[0]!)[0]!;
    for (const f of ["request.json", "response.json", "stream.jsonl", "request.md"]) {
      assert.ok(existsSync(join(first, f)), `${f} is missing`);
    }
    assert.ok(existsSync(join(session, "session.json")));
    assert.ok(existsSync(join(turnDirs(session)[0]!, "turn.md")));
    assert.ok(existsSync(join(h.logDir, "index.md")));
  });

  it("rebuilds a stream with no content-type header into a whole message", () => {
    const first = requestDirs(turnDirs(session)[0]!)[0]!;
    const res = readJson(join(first, "response.json"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.toolCalls, ["exec"]);
    assert.equal(res.usage.total_tokens, 160);
  });

  it("keeps a plumbing call out of any turn, and marks it as raw", () => {
    const raw = sessionDir(h.logDir, "non-messages-traffic");
    const dirs = requestDirs(turnDirs(raw)[0]!);
    assert.ok(dirs.some((d) => readJson(join(d, "request.json")).shape === undefined));
  });

  it("redacts credentials in the log but not on the wire", () => {
    const first = requestDirs(turnDirs(session)[0]!)[0]!;
    const logged = readJson(join(first, "request.json")).headers;
    assert.match(logged.authorization, /^<redacted len=\d+ sha1=[0-9a-f]{8}>$/);
    assert.equal(h.upstream.seen.at(0)!.headers["authorization"], "Bearer FAKE-CHATGPT-TOKEN");
  });

  it("re-renders the same Markdown from the JSON alone", async () => {
    const before = readText(join(turnDirs(session)[0]!, "turn.md"));
    await renderSessionDir(session);
    const after = readText(join(turnDirs(session)[0]!, "turn.md"));
    assert.equal(after, before, "the offline report must match what the proxy wrote live");
  });

  it("labels the turn from the user's own words, past the tool loop", () => {
    const turn1 = turnDirs(session)[0]!;
    assert.equal(readText(join(turn1, "user-input.txt")).trim(), "run echo hi");
    assert.match(readText(join(turn1, "turn.md")), /# Turn 1 — run echo hi/);
  });
});
