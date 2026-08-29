import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderer } from "../../src/cursor/render.ts";

const USAGE = {
  usedTokens: 14931,
  maxTokens: 256000,
  components: [
    { id: "system_prompt", label: "System prompt", tokens: 1060, chars: 4236 },
    { id: "tools", label: "Tool definitions", tokens: 8786, chars: 35114 },
  ],
};

const REQ = {
  path: "/agent.v1.AgentService/RunSSE",
  shape: {
    kind: "aux",
    endpoint: "RunSSE",
    runId: "run-1",
    clientVersion: "cli-2026.08.25",
    ghostMode: true,
  },
};

const RES = {
  status: 200,
  timing: { ttfbMs: 324, durationMs: 18248 },
  sseEvents: 187,
  usage: USAGE,
  stopReason: "end_of_stream",
  toolCalls: ["Read", "Write"],
  body: {
    messages: [
      { seq: 1, role: "user", content: { role: "user", content: "read note.txt" } },
      {
        seq: 2,
        role: "assistant",
        content: {
          role: "assistant",
          content: [
            { type: "text", text: "It says hello." },
            { type: "tool-call", toolName: "Read", args: { path: "/tmp/note.txt" } },
          ],
        },
      },
    ],
    text: "It says hello.",
    toolCalls: ["Read", "Write"],
  },
};

describe("cursor tokens", () => {
  it("counts the context as prompt and invents no output or cache number", () => {
    const t = renderer.tokens(USAGE);
    assert.equal(t.input, 14931);
    assert.equal(t.total, 14931);
    assert.equal(t.output, 0);
    assert.equal(t.cacheRead, 0);
    assert.equal(t.cacheWrite, 0);
  });

  it("tolerates undefined and shapes it has never seen", () => {
    for (const junk of [undefined, null, 42, "usage", {}, { usedTokens: "many" }]) {
      assert.equal(renderer.tokens(junk).total, 0, String(junk));
    }
  });

  it("says nothing rather than zero when no usage was reported", () => {
    assert.match(renderer.usageTable(undefined), /No usage reported/);
  });
});

describe("cursor request.md", () => {
  it("reads only its two arguments", () => {
    const md = renderer.request(REQ, RES, {});
    assert.match(md, /RunSSE/);
    assert.match(md, /run-1/);
    assert.match(md, /ghost mode/);
    assert.match(md, /187/);
    assert.match(md, /end_of_stream/);
  });

  it("shows the context breakdown Cursor reported", () => {
    const md = renderer.request(REQ, RES, {});
    assert.match(md, /Context window/);
    assert.match(md, /System prompt/);
    assert.match(md, /Tool definitions/);
    assert.match(md, /256,000/);
  });

  it("names the tools that were called", () => {
    const md = renderer.request(REQ, RES, {});
    assert.match(md, /`Read`/);
    assert.match(md, /`Write`/);
  });

  it("renders the transcript without truncating any of it", () => {
    const long = "x".repeat(50_000);
    const res = {
      ...RES,
      body: {
        messages: [{ seq: 1, role: "user", content: { role: "user", content: long } }],
      },
    };
    const md = renderer.request(REQ, res, {});
    assert.ok(md.includes(long), "the prompt body is the point of the log");
  });

  it("survives a capture written by an older version of itself", () => {
    for (const req of [undefined, {}, { shape: {} }, { shape: { endpoint: "RunSSE" } }]) {
      for (const res of [undefined, {}, { body: {} }, { body: { messages: [] } }]) {
        assert.doesNotThrow(() => renderer.request(req, res, {}), `${JSON.stringify({ req, res })}`);
      }
    }
  });

  it("reports an error row rather than pretending the request succeeded", () => {
    const md = renderer.request(REQ, { error: "upstream error: socket hang up" }, {});
    assert.match(md, /socket hang up/);
  });

  it("is a pure function - the same input renders the same Markdown", () => {
    assert.equal(renderer.request(REQ, RES, {}), renderer.request(REQ, RES, {}));
  });
});
