import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { cursor } from "../../src/cursor/index.ts";
import { bidiAppend, otherEvent, runRequest, userTurnEvent } from "./encode.ts";

const BLOB = "0123456789abcdef0123456789abcdef";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/proto",
    "x-blob-encryption-key": BLOB,
    "x-request-id": "http-request-1",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": "cli-2026.08.25",
    ...extra,
  };
}

function describeIt(path: string, body: Buffer, extra: Record<string, string> = {}) {
  const h = headers(extra);
  return cursor.describeRequest({
    body: undefined,
    bodyBuf: body,
    headers: h,
    path,
    isInference: cursor.isInferenceEndpoint(path),
  });
}

const APPEND = "/aiserver.v1.BidiService/BidiAppend";
const RUN = "/agent.v1.AgentService/RunSSE";

describe("cursor endpoint matching", () => {
  it("recognises the two endpoints that carry a conversation", () => {
    assert.equal(cursor.isInferenceEndpoint(APPEND), true);
    assert.equal(cursor.isInferenceEndpoint(RUN), true);
  });

  it("leaves plumbing alone", () => {
    for (const path of [
      "/aiserver.v1.DashboardService/GetMe",
      "/aiserver.v1.AnalyticsService/TrackEvents",
      "/aiserver.v1.AiService/AvailableModels",
      "/v1/traces",
    ]) {
      assert.equal(cursor.isInferenceEndpoint(path), false, path);
      assert.equal(describeIt(path, Buffer.alloc(0)), undefined, path);
    }
  });
});

describe("cursor session identity", () => {
  it("files both endpoints under one session, from the shared blob key", () => {
    const run = describeIt(RUN, runRequest(), { "content-type": "application/connect+proto" });
    const append = describeIt(APPEND, bidiAppend(userTurnEvent({ prompt: "hi" })));
    assert.ok(run);
    assert.ok(append);
    assert.equal(run.sessionId, append.sessionId);
  });

  it("never puts the encryption key itself in the session id", () => {
    const shape = describeIt(RUN, runRequest(), { "content-type": "application/connect+proto" });
    assert.ok(shape);
    assert.ok(!shape.sessionId.includes(BLOB));
    assert.match(shape.sessionId, /^cli-[0-9a-f]{12}$/);
  });

  it("falls back to the request id when the key is absent", () => {
    const h = headers();
    delete h["x-blob-encryption-key"];
    const shape = cursor.describeRequest({
      body: undefined,
      bodyBuf: bidiAppend(userTurnEvent({ prompt: "hi" })),
      headers: h,
      path: APPEND,
      isInference: true,
    });
    assert.equal(shape?.sessionId, "http-request-1");
  });
});

describe("cursor turn boundaries", () => {
  it("opens a turn on the user's prompt and labels it with their words", () => {
    const shape = describeIt(
      APPEND,
      bidiAppend(userTurnEvent({ prompt: "Fix the failing test", model: "composer-2" }), "conv-1", 2),
    );
    assert.equal(shape?.kind, "main");
    assert.equal(shape?.turnLabel, "Fix the failing test");
    assert.equal(shape?.userText, "Fix the failing test");
    assert.equal(shape?.model, "composer-2");
    assert.equal(shape?.messageCount, 2);
  });

  it("keeps every other client event out of the turn boundary", () => {
    for (const field of [2, 3, 5, 7]) {
      const shape = describeIt(APPEND, bidiAppend(otherEvent(field), "conv-1", 4));
      assert.equal(shape?.kind, "aux", `event field ${field}`);
      assert.equal(shape?.userText, "");
    }
  });

  it("never lets the long-lived run stream open a turn of its own", () => {
    const shape = describeIt(RUN, runRequest(), { "content-type": "application/connect+proto" });
    assert.equal(shape?.kind, "aux");
    assert.equal(shape?.stream, true);
  });

  it("separates the same prompt asked twice", () => {
    const first = describeIt(
      APPEND,
      bidiAppend(userTurnEvent({ prompt: "again", promptId: "id-a" }), "conv-1", 1),
    );
    const second = describeIt(
      APPEND,
      bidiAppend(userTurnEvent({ prompt: "again", promptId: "id-b" }), "conv-1", 9),
    );
    assert.notEqual(first?.turnKey, second?.turnKey);
  });

  it("holds one turn across the whole tool loop", () => {
    const prompt = describeIt(
      APPEND,
      bidiAppend(userTurnEvent({ prompt: "do it", promptId: "id-a" }), "conv-1", 1),
    );
    // Tool results and acks keep arriving; none of them may re-key the turn.
    for (let seq = 2; seq < 8; seq++) {
      const shape = describeIt(APPEND, bidiAppend(otherEvent(2), "conv-1", seq));
      assert.equal(shape?.kind, "aux");
    }
    const same = describeIt(
      APPEND,
      bidiAppend(userTurnEvent({ prompt: "do it", promptId: "id-a" }), "conv-1", 1),
    );
    assert.equal(same?.turnKey, prompt?.turnKey);
  });
});

describe("cursor body decoding", () => {
  it("reads a gzipped body, which is how a large prompt arrives", () => {
    const raw = bidiAppend(userTurnEvent({ prompt: "compressed prompt" }), "conv-1", 3);
    const shape = describeIt(APPEND, gzipSync(raw), { "content-encoding": "gzip" });
    assert.equal(shape?.turnLabel, "compressed prompt");
  });

  it("records the conversation and run ids without making them the session", () => {
    const shape = describeIt(
      APPEND,
      bidiAppend(userTurnEvent({ prompt: "hi", runId: "run-9", conversationId: "conv-9" }), "conv-9", 1),
    );
    assert.equal(shape?.detail?.conversationId, "conv-9");
    assert.equal(shape?.detail?.runId, "run-9");
    assert.equal(shape?.detail?.endpoint, "BidiAppend");
  });

  it("returns undefined rather than throwing on a body it cannot read", () => {
    assert.doesNotThrow(() => describeIt(APPEND, Buffer.from("not protobuf at all")));
    assert.doesNotThrow(() => describeIt(APPEND, Buffer.alloc(0)));
    assert.doesNotThrow(() => describeIt(RUN, Buffer.from([0xff, 0xff, 0xff])));
  });
});
