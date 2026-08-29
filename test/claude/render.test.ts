import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderRequest, tokens, usageTable } from "../../src/claude/render.ts";

const req = (overrides: any = {}) => ({
  at: "2026-08-29T00:00:00.000Z",
  session: "s1",
  turn: 1,
  request: 1,
  method: "POST",
  path: "/v1/messages",
  shape: { kind: "main", model: "claude-opus-5", stream: true, messageCount: 1, toolCount: 2, toolNames: ["Bash"], systemChars: 10, thinking: false, toolResults: [] },
  headers: { "anthropic-version": "2023-06-01" },
  body: { model: "claude-opus-5", max_tokens: 100, stream: true, system: "sys", messages: [{ role: "user", content: "hello" }] },
  ...overrides,
});

const res = (overrides: any = {}) => ({
  status: 200,
  timing: { ttfbMs: 12, durationMs: 340 },
  sseEvents: 9,
  usage: { input_tokens: 100, output_tokens: 57, cache_read_input_tokens: 20 },
  stopReason: "end_turn",
  body: { content: [{ type: "text", text: "hi there" }] },
  ...overrides,
});

describe("request.md", () => {
  it("summarises status, latency, tokens and stop reason", () => {
    const md = renderRequest(req(), res());
    assert.match(md, /# Turn 1 · Request 1 · claude-opus-5/);
    assert.match(md, /\| Status \| ✅ 200 \|/);
    assert.match(md, /first byte 12 ms/);
    assert.match(md, /\| Output \| 57 \|/);
    assert.match(md, /\*\*177\*\*/, "total tokens");
    assert.match(md, /17% of prompt/, "cache hit rate");
    assert.match(md, /`end_turn`/);
  });

  it("shows only the new messages when a turn continues", () => {
    const md = renderRequest(
      req({
        body: {
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }] },
          ],
        },
      }),
      res(),
      { prevMessageCount: 1 },
    );
    assert.match(md, /Earlier history — 1 message carried over/);
    assert.match(md, /#### New in this request \(2 messages\)/);

    // The collapsed history must stop at the boundary, not repeat the new ones.
    const history = md.slice(md.indexOf("Earlier history"), md.indexOf("#### New in this request"));
    assert.ok(history.includes("first"));
    assert.ok(!history.includes("Bash"), "history must not repeat the new messages");
  });

  it("renders tool calls with their reassembled input", () => {
    const md = renderRequest(
      req(),
      res({ body: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] } }),
    );
    assert.match(md, /\*\*Tool call — `Bash`\*\*/);
    assert.match(md, /"command": "ls -la"/);
  });

  it("shows an error response as an error", () => {
    const md = renderRequest(req(), res({ status: 401, stopReason: undefined, body: { error: { type: "authentication_error" } } }));
    assert.match(md, /\| Status \| ⚠️ 401 \|/);
    assert.match(md, /authentication_error/);
  });

  it("labels a subagent request", () => {
    const md = renderRequest(req({ shape: { ...req().shape, agentId: "agent-77" } }), res());
    assert.match(md, /subagent `agent-77`/);
  });
});

describe("Anthropic token accounting", () => {
  it("splits prompt tokens into fresh, cache-write and cache-read", () => {
    const t = tokens({
      input_tokens: 100,
      output_tokens: 57,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    });
    assert.deepEqual(t, { input: 100, output: 57, cacheRead: 20, cacheWrite: 30, total: 207 });
    const md = usageTable(t);
    assert.match(md, /\| Cache write \| 30 \|/);
    assert.match(md, /\| Cache read \| 20\s+·\s+13% of prompt \|/);
  });

  it("hides the cache rows when nothing was cached", () => {
    const md = usageTable(tokens({ input_tokens: 5, output_tokens: 1 }));
    assert.ok(!md.includes("Cache read"));
    assert.ok(!md.includes("Cache write"));
    assert.match(md, /\| \*\*Total\*\* \| \*\*6\*\* \|/);
  });

  it("says so when there is no usage at all", () => {
    assert.equal(usageTable(undefined), "_No usage reported._");
  });
});
