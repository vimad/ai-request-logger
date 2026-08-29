import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cursor } from "../../src/cursor/index.ts";
import { renderSessionDir } from "../../src/core/report.ts";
import {
  readJson,
  readText,
  requestDirs,
  sessionDirs,
  settle,
  startHarness,
  turnDirs,
  type Harness,
} from "../helpers/harness.ts";
import { bidiAppend, otherEvent, runRequest, userTurnEvent } from "./encode.ts";
import { startMockUpstream } from "./upstream.ts";

const APPEND = "/aiserver.v1.BidiService/BidiAppend";
const RUN = "/agent.v1.AgentService/RunSSE";
const PROMPT = "Read note.txt and write a poem";
const TOKEN = "Bearer crsr-FAKE-TOKEN-VALUE";
const BLOB = "ccfaa09591f2dfa290b231d1218d997c";

function cursorHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: TOKEN,
    "x-blob-encryption-key": BLOB,
    "x-request-id": "http-1",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": "cli-2026.08.25",
    "x-ghost-mode": "true",
    ...extra,
  };
}

describe("a Cursor CLI session end to end", () => {
  let h: Harness;
  let session: string;

  before(async () => {
    h = await startHarness({ provider: cursor, startUpstream: startMockUpstream });

    // A plumbing call, before anything conversational happens.
    await h.sendRaw("/aiserver.v1.DashboardService/GetMe", Buffer.alloc(4), cursorHeaders());

    // The run stream opens first - before the prompt is ever sent.
    await h.sendRaw(RUN, runRequest("http-1"), {
      ...cursorHeaders(),
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
    });

    // Then the user's prompt, then the tool loop's events.
    await h.sendRaw(
      APPEND,
      bidiAppend(userTurnEvent({ prompt: PROMPT, promptId: "p1", runId: "run-1" }), "conv-1", 1),
      cursorHeaders(),
    );
    for (let seq = 2; seq <= 4; seq++) {
      await h.sendRaw(APPEND, bidiAppend(otherEvent(2), "conv-1", seq), cursorHeaders());
    }

    await settle(400);
    const conversational = sessionDirs(h.logDir).filter((d) => d.includes("session-cli-"));
    assert.equal(conversational.length, 1, "both endpoints must share one session");
    session = conversational[0]!;
  });

  after(async () => h.close());

  it("keeps plumbing out of the conversation", () => {
    const unstructured = sessionDirs(h.logDir).filter((d) => d.includes("non-messages-traffic"));
    assert.equal(unstructured.length, 1);
  });

  it("names the turn with what the user actually asked", () => {
    const turns = turnDirs(session);
    const named = turns.find((t) => t.includes("Read-note.txt"));
    assert.ok(named, `no turn named for the prompt in ${turns.join(", ")}`);
    assert.equal(readText(join(named, "user-input.txt")).trim(), PROMPT);
  });

  it("folds the tool-loop events into that one turn", () => {
    const named = turnDirs(session).find((t) => t.includes("Read-note.txt"))!;
    // The prompt plus the three events that followed it.
    assert.equal(requestDirs(named).length, 4);
  });

  it("rebuilds the run stream that never was SSE", () => {
    const background = turnDirs(session).find((t) => t.includes("turn-000"))!;
    const run = requestDirs(background)[0]!;
    const res = readJson(join(run, "response.json"));

    assert.equal(res.status, 200);
    assert.equal(res.sseEvents, 8, "one event per Connect envelope");
    assert.deepEqual(res.toolCalls, ["Read"]);
    assert.equal(res.stopReason, "end_of_stream");
    assert.equal(res.usage.usedTokens, 1800, "the latest context reading");
    assert.equal(res.usage.components.length, 2, "the breakdown from the earlier frame");
    assert.equal(res.body.messages.length, 5);
    assert.equal(res.body.text, "It says hello.");
  });

  it("writes one stream.jsonl line per frame", () => {
    const background = turnDirs(session).find((t) => t.includes("turn-000"))!;
    const run = requestDirs(background)[0]!;
    const lines = readText(join(run, "stream.jsonl")).trim().split("\n");
    assert.equal(lines.length, 8);
    assert.equal(JSON.parse(lines.at(-1)!).event, "end");
  });

  it("keeps a protobuf body byte-exact rather than mangling it into UTF-8", () => {
    const named = turnDirs(session).find((t) => t.includes("Read-note.txt"))!;
    const req = readJson(join(requestDirs(named)[0]!, "request.json"));
    assert.equal(req.body.__binary, true, "a protobuf body is stored as base64");
    const restored = Buffer.from(req.body.data, "base64");
    assert.ok(restored.includes(Buffer.from(PROMPT, "utf8").toString("hex")));
  });

  it("redacts the credential in the log but forwards it untouched", () => {
    const named = turnDirs(session).find((t) => t.includes("Read-note.txt"))!;
    const req = readJson(join(requestDirs(named)[0]!, "request.json"));
    assert.match(req.headers.authorization, /^<redacted/);
    assert.ok(!JSON.stringify(req.headers).includes("FAKE-TOKEN-VALUE"));

    const forwarded = h.upstream.seen.find((s) => s.url.includes("BidiAppend"));
    assert.equal(forwarded?.headers.authorization, TOKEN);
  });

  it("does not put the encryption key in any path it writes", () => {
    assert.ok(!session.includes(BLOB));
  });

  it("re-renders offline to exactly what the proxy wrote live", async () => {
    const background = turnDirs(session).find((t) => t.includes("turn-000"))!;
    const before = {
      turn: readText(join(background, "turn.md")),
      request: readText(join(requestDirs(background)[0]!, "request.md")),
    };
    await renderSessionDir(session);
    assert.equal(readText(join(background, "turn.md")), before.turn);
    assert.equal(readText(join(requestDirs(background)[0]!, "request.md")), before.request);
  });
});
