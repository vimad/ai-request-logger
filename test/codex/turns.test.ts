import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRequest, type CodexRequestBody, type InputItem } from "../../src/codex/turns.ts";

const ADDITIONAL_TOOLS: InputItem = {
  type: "additional_tools",
  role: "developer",
  tools: [
    { type: "custom", name: "exec" },
    { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent" }] },
  ],
};

const DEV_MESSAGE: InputItem = { type: "message", role: "developer", content: [{ type: "input_text", text: "system prompt" }] };

function userMessage(text: string): InputItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

const TURN_HEADERS = (kind = "turn") => ({
  "x-codex-turn-metadata": JSON.stringify({ request_kind: kind, thread_source: "user", sandbox: "seatbelt" }),
});

const shape = (body: CodexRequestBody, headers: Record<string, string> = TURN_HEADERS()) =>
  describeRequest(body, headers, true);

describe("turn detection", () => {
  it("anchors the turn on the last user-role message, past the boilerplate one ahead of it", () => {
    const noise = userMessage("<recommended_plugins>...</recommended_plugins><environment_context>...</environment_context>");
    const s = shape({
      model: "gpt-5.6-terra",
      input: [ADDITIONAL_TOOLS, DEV_MESSAGE, noise, userMessage("hello")],
    });
    assert.equal(s.kind, "main");
    assert.equal(s.userText, "hello");
    assert.equal(s.turnLabel, "hello");
  });

  it("keeps the same turn key across a tool loop", () => {
    const opening = [ADDITIONAL_TOOLS, DEV_MESSAGE, userMessage("run echo hi")];
    const first = shape({ model: "m", input: opening });
    const second = shape({
      model: "m",
      input: [
        ...opening,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
        { type: "custom_tool_call", name: "exec", call_id: "call_1", input: "..." },
        { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "hi" }] },
      ],
    });
    assert.equal(first.turnKey, second.turnKey, "a tool hop must not open a new turn");
  });

  it("separates two identical prompts asked at different points", () => {
    const first = shape({ model: "m", input: [userMessage("again")] });
    const later = shape({
      model: "m",
      input: [
        userMessage("again"),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        userMessage("again"),
      ],
    });
    assert.notEqual(first.turnKey, later.turnKey);
  });

  it("classifies a request whose turn metadata is not a user turn as aux", () => {
    const s = shape({ model: "m", input: [userMessage("title this")] }, TURN_HEADERS("compaction"));
    assert.equal(s.kind, "aux");
  });

  it("treats a missing x-codex-turn-metadata header as aux, not main", () => {
    const s = describeRequest({ model: "m", input: [userMessage("hi")] }, {}, true);
    assert.equal(s.kind, "aux");
  });

  it("marks non-/responses endpoints as other", () => {
    const s = describeRequest({ model: "m", input: [] }, TURN_HEADERS(), false);
    assert.equal(s.kind, "other");
  });

  it("reads the session id from the session-id header, falling back to client_metadata", () => {
    const viaHeader = describeRequest({ input: [] }, { "session-id": "sess-abc" }, true);
    assert.equal(viaHeader.sessionId, "sess-abc");

    const viaMetadata = describeRequest(
      { input: [], client_metadata: { thread_id: "thread-xyz" } },
      {},
      true,
    );
    assert.equal(viaMetadata.sessionId, "thread-xyz");

    const viaCacheKey = describeRequest({ input: [], prompt_cache_key: "cache-key-1" }, {}, true);
    assert.equal(viaCacheKey.sessionId, "cache-key-1");

    assert.equal(describeRequest({ input: [] }, {}, true).sessionId, "anon-unknown");
  });

  it("marks a sub-agent request with its window id, and leaves the root window unmarked", () => {
    const sub = describeRequest(
      { input: [userMessage("go")] },
      { ...TURN_HEADERS(), "x-codex-window-id": "thread-1:2" },
      true,
    );
    assert.equal(sub.agentId, "thread-1:2");

    const root = describeRequest(
      { input: [userMessage("go")] },
      { ...TURN_HEADERS(), "x-codex-window-id": "thread-1:0" },
      true,
    );
    assert.equal(root.agentId, undefined);
  });

  it("collects tool names, including ones nested in a namespace", () => {
    const s = shape({ model: "m", input: [ADDITIONAL_TOOLS, userMessage("go")] });
    assert.deepEqual(s.detail?.toolNames, ["exec", "spawn_agent"]);
    assert.equal(s.detail?.toolCount, 2);
  });

  it("records the tool result being fed back, when the request ends with one", () => {
    const s = shape({
      model: "m",
      input: [
        userMessage("run it"),
        { type: "custom_tool_call", name: "exec", call_id: "call_9" },
        { type: "custom_tool_call_output", call_id: "call_9", output: [{ type: "input_text", text: "done" }] },
      ],
    });
    const toolResult = s.detail?.toolResult as { callId?: string; preview?: string } | undefined;
    assert.equal(toolResult?.callId, "call_9");
    assert.match(toolResult?.preview ?? "", /done/);
  });

  it("returns a shape with no user text rather than throwing when input has no user message", () => {
    const s = shape({ model: "m", input: [DEV_MESSAGE] });
    assert.equal(s.userText, "");
    assert.equal(s.turnLabel, "(no user text)");
  });
});
