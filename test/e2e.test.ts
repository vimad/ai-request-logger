import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { renderSessionDir } from "../src/report.ts";
import {
  ccHeaders,
  readJson,
  readText,
  requestDirs,
  sessionDir,
  settle,
  startHarness,
  turnDirs,
  TOOLS,
  type Harness,
} from "./helpers/harness.ts";

const SESSION = "e2e-session-0001";

/** Drives one user turn through the proxy, following the tool loop to the end. */
async function runTurn(h: Harness, history: any[], prompt: unknown): Promise<number> {
  history.push({ role: "user", content: prompt });
  let hops = 0;
  for (;;) {
    const res = await h.send(
      { model: "claude-opus-5", max_tokens: 4096, stream: true, system: "sys", tools: TOOLS, messages: history },
      ccHeaders(SESSION),
    );
    const text = await res.text();
    hops++;
    if (!text.includes('"type":"tool_use"')) break;
    history.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }],
    });
    history.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "total 0" },
        { type: "text", text: "<system-reminder>note</system-reminder>" },
      ],
    });
  }
  history.push({ role: "assistant", content: [{ type: "text", text: "Let me check that." }] });
  return hops;
}

describe("end to end: a Claude Code session becomes a log tree", () => {
  let h: Harness;
  let session: string;

  before(async () => {
    h = await startHarness();
    const history: any[] = [];

    // Turn 1, sent as a block array the way Claude Code opens a turn.
    await runTurn(h, history, [{ type: "text", text: "list the files in this repo" }]);

    // A background call: no tools, so it must fold into the turn in flight.
    await h
      .send({ model: "claude-haiku-4-5-20251001", max_tokens: 64, stream: true, messages: [{ role: "user", content: "title this" }] }, ccHeaders(SESSION))
      .then((r) => r.text());

    // A subagent request, which belongs to the turn that spawned it.
    await h
      .send(
        { model: "claude-opus-5", stream: true, tools: TOOLS, messages: [{ role: "user", content: "search for foo" }] },
        ccHeaders(SESSION, { "x-claude-code-agent-id": "agent-explore-77" }),
      )
      .then((r) => r.text());

    // Turn 2.
    await runTurn(h, history, "now explain what you found");

    // A non-Messages call that still belongs to the session.
    await h.send({ model: "claude-opus-5", messages: [] }, ccHeaders(SESSION), "/v1/messages/count_tokens").then((r) => r.text());

    await settle(400);
    session = sessionDir(h.logDir, SESSION);
  });

  after(async () => {
    await h.close();
  });

  it("groups provider requests under the turn that caused them", () => {
    const turns = turnDirs(session).map((d) => d.split("/").pop()!);
    assert.deepEqual(turns, [
      "turn-001__list-the-files-in-this-repo",
      "turn-002__now-explain-what-you-found",
    ]);
  });

  it("keeps the tool loop, the background call and the subagent in turn 1", () => {
    const turn1 = turnDirs(session)[0]!;
    const kinds = requestDirs(turn1).map((d) => readJson(join(d, "request.json")).shape.kind);
    // main (tool_use) + main (end_turn) + aux (title) + main (subagent)
    assert.equal(kinds.length, 4, "one turn, four provider requests");
    assert.equal(kinds.filter((k) => k === "aux").length, 1);

    const agentIds = requestDirs(turn1).map((d) => readJson(join(d, "request.json")).shape.agentId);
    assert.ok(agentIds.includes("agent-explore-77"), "the subagent request stays inside the turn");
  });

  it("writes the raw capture and the readable view side by side", () => {
    const first = requestDirs(turnDirs(session)[0]!)[0]!;
    for (const f of ["request.json", "response.json", "stream.jsonl", "request.md"]) {
      assert.ok(existsSync(join(first, f)), `${f} is missing`);
    }
    assert.ok(existsSync(join(session, "session.json")));
    assert.ok(existsSync(join(session, "session.md")));
    assert.ok(existsSync(join(turnDirs(session)[0]!, "turn.md")));
    assert.ok(existsSync(join(h.logDir, "index.md")));
    assert.ok(existsSync(join(h.logDir, "index.jsonl")));
  });

  it("rebuilds the streamed reply into a whole message", () => {
    const first = requestDirs(turnDirs(session)[0]!)[0]!;
    const res = readJson(join(first, "response.json"));
    assert.equal(res.status, 200);
    assert.equal(res.stopReason, "tool_use");
    assert.deepEqual(res.toolCalls, ["Bash"]);
    const tool = res.body.content.find((b: any) => b.type === "tool_use");
    assert.deepEqual(tool.input, { command: "ls -la" }, "split JSON deltas are reassembled");
    assert.equal(res.usage.output_tokens, 57);
  });

  it("decompresses a gzipped response for the log while relaying it untouched", () => {
    const turn2 = turnDirs(session)[1]!;
    const countTokens = requestDirs(turn2).map((d) => readJson(join(d, "response.json"))).find((r) => r.body?.input_tokens);
    assert.deepEqual(countTokens?.body, { input_tokens: 42 });
  });

  it("redacts credentials in the log but not on the wire", () => {
    const first = requestDirs(turnDirs(session)[0]!)[0]!;
    const logged = readJson(join(first, "request.json")).headers;
    assert.match(logged.authorization, /^<redacted len=\d+ sha1=[0-9a-f]{8}>$/);
    assert.equal(
      h.upstream.seen.at(0)!.headers["authorization"],
      "Bearer sk-ant-oat-FAKE-TOKEN",
      "the upstream must still receive the real credential",
    );
  });

  it("records one index line per provider request", () => {
    const lines = readText(join(h.logDir, "index.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 7);
    assert.ok(lines.every((l) => l.session === SESSION));
  });

  it("re-renders the same Markdown from the JSON alone", async () => {
    const before = readText(join(turnDirs(session)[0]!, "turn.md"));
    await renderSessionDir(session);
    const after = readText(join(turnDirs(session)[0]!, "turn.md"));
    assert.equal(after, before, "the offline report must match what the proxy wrote live");
  });

  it("keeps the user's prompt out of the reminder noise", () => {
    const turn1 = turnDirs(session)[0]!;
    assert.equal(readText(join(turn1, "user-input.txt")).trim(), "list the files in this repo");
    assert.match(readText(join(turn1, "turn.md")), /# Turn 1 — list the files in this repo/);
  });
});
