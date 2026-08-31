import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderRequest, tokens, usageTable } from "../../src/codex/render.ts";

describe("token normalisation", () => {
  it("splits input_tokens into fresh vs cached, mirroring Claude's cache split", () => {
    const t = tokens({
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
      output_tokens: 10,
      total_tokens: 130,
    });
    assert.deepEqual(t, { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, total: 130 });
  });

  it("tolerates undefined and an unrecognised usage shape", () => {
    assert.deepEqual(tokens(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.deepEqual(tokens({ weird: true }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });

  it("falls back to input+output when total_tokens is absent", () => {
    assert.equal(tokens({ input_tokens: 10, output_tokens: 5 }).total, 15);
  });
});

describe("usageTable", () => {
  it("reports no usage rather than zeroing it out", () => {
    assert.match(usageTable(undefined), /No usage reported/);
  });

  it("hides the cache rows when nothing was cached", () => {
    const table = usageTable(tokens({ input_tokens: 10, output_tokens: 5 }));
    assert.doesNotMatch(table, /Cache/);
  });
});

describe("renderRequest", () => {
  const req = {
    turn: 1,
    request: 1,
    session: "sess-1",
    method: "POST",
    path: "/responses",
    at: "2026-01-01T00:00:00Z",
    headers: { authorization: "<redacted>" },
    shape: {
      kind: "main",
      model: "gpt-5.6-terra",
      stream: true,
      toolCount: 1,
      toolNames: ["exec"],
      systemChars: 40,
      reasoningEffort: "medium",
      verbosity: "low",
    },
    body: {
      model: "gpt-5.6-terra",
      stream: true,
      input: [
        { type: "additional_tools", tools: [{ type: "custom", name: "exec" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "system prompt" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello there" }] },
      ],
    },
  };
  const res = {
    status: 200,
    timing: { durationMs: 500, ttfbMs: 100 },
    stopReason: "completed",
    sseEvents: 6,
    usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
    headers: {},
    body: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }] },
  };

  it("is a pure function that includes the user's words and the model's reply", () => {
    const md = renderRequest(req, res, {});
    assert.match(md, /hello there/);
    assert.match(md, /hi/);
    assert.match(md, /gpt-5\.6-terra/);
  });

  it("collapses earlier history behind a details block, showing only what is new", () => {
    const md = renderRequest(req, res, { prevMessageCount: 2 });
    assert.match(md, /Earlier history — 2 items/);
    assert.match(md, /New in this request \(1 item\)/);
  });

  it("does not crash on a response with no body captured", () => {
    const md = renderRequest(req, { status: 200, headers: {} }, {});
    assert.match(md, /No response body captured/);
  });
});
