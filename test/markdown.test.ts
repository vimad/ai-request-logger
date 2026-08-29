import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { block, renderRequest, renderTurn } from "../src/markdown.ts";

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

describe("content blocks are never truncated", () => {
  it("keeps the whole of a long block, head and tail", () => {
    const huge = "HEAD\n" + "x".repeat(200_000) + "\nTAIL";
    const out = block(huge);
    assert.ok(out.includes("HEAD"));
    assert.ok(out.includes("TAIL"));
    assert.ok(out.length > huge.length, "content must be present in full");
    assert.ok(!out.includes("truncated"));
  });

  it("puts long content in a fixed-height scroll box", () => {
    const out = block("line\n".repeat(500));
    assert.match(out, /max-height:/);
    assert.match(out, /overflow: auto/);
    assert.match(out, /scroll inside the box/);
  });

  it("leaves short content as an ordinary fenced block", () => {
    const out = block("just a line");
    assert.equal(out, "```text\njust a line\n```");
  });

  it("escapes markup inside a scroll box so it is not swallowed", () => {
    const out = block("<b>bold & bigger</b>\n".repeat(100));
    assert.match(out, /&lt;b&gt;bold &amp; bigger&lt;\/b&gt;/);
    assert.ok(!out.includes("<b>bold"), "raw markup would be rendered instead of shown");
  });

  it("sizes the fence past any backtick run in short content", () => {
    const out = block("```\ninner\n```");
    assert.match(out, /^````text\n/, "a 3-backtick fence would be broken by the content");
    assert.ok(out.includes("```\ninner\n```"));
  });
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

describe("turn.md", () => {
  const turn = {
    turn: 2,
    session: "s1",
    label: "do the thing",
    startedAt: "2026-08-29T00:00:00.000Z",
    requests: [
      { n: 1, dir: "req-001__main", kind: "main", model: "m", status: 200, stopReason: "tool_use", durationMs: 100, messageCount: 1, toolCalls: ["Bash"], usage: { input_tokens: 10, output_tokens: 5 } },
      { n: 2, dir: "req-002__main", kind: "main", model: "m", status: 200, stopReason: "end_turn", durationMs: 50, messageCount: 3, toolCalls: [], usage: { input_tokens: 20, output_tokens: 7 } },
    ],
  };

  it("totals the turn and lists every provider request", () => {
    const md = renderTurn(turn, "do the thing");
    assert.match(md, /# Turn 2 — do the thing/);
    assert.match(md, /\*\*2 provider requests\*\*/);
    assert.match(md, /\| \*\*Total\*\* \| \*\*42\*\* \|/, "10+5+20+7");
    assert.match(md, /\[001\]\(\.\/req-001__main\/request\.md\)/);
  });

  it("narrates what each request did", () => {
    const md = renderTurn(turn, "do the thing");
    assert.match(md, /1 message in · 100 ms → called Bash/);
    assert.match(md, /3 messages in · 50 ms → answered the user/);
  });

  it("does not claim a background call answered the user", () => {
    const md = renderTurn(
      { ...turn, requests: [{ n: 1, dir: "d", kind: "aux", status: 200, stopReason: "end_turn", durationMs: 10, messageCount: 1, toolCalls: [] }] },
      "x",
    );
    assert.match(md, /returned its result/);
  });
});
