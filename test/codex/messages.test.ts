import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconstructMessage, responseFacts } from "../../src/codex/messages.ts";

const ev = (event: string, data: unknown, at = 0) => ({ at, event, data });

describe("stream reconstruction", () => {
  it("returns undefined for a stream that carried nothing", () => {
    assert.equal(reconstructMessage([]), undefined);
  });

  it("builds the final text message from output_item.done events", () => {
    const events = [
      ev("response.created", { response: { id: "resp_1", status: "in_progress" } }),
      ev("response.output_item.added", { output_index: 0, item: { type: "message", role: "assistant", content: [] } }),
      ev("response.output_text.delta", { output_index: 0, content_index: 0, delta: "hel" }),
      ev("response.output_text.delta", { output_index: 0, content_index: 0, delta: "lo" }),
      ev("response.output_item.done", {
        output_index: 0,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      }),
      // The "lite" backend ships an empty `output` here on purpose.
      ev("response.completed", { response: { id: "resp_1", status: "completed", output: [], usage: { output_tokens: 3 } } }),
    ];
    const message = reconstructMessage(events)!;
    assert.equal(message.status, "completed");
    assert.deepEqual(message.output, [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }]);
  });

  it("falls back to accumulating delta text when a stream is cut off before output_item.done", () => {
    const events = [
      ev("response.output_item.added", { output_index: 0, item: { type: "message", role: "assistant", content: [] } }),
      ev("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }),
      ev("response.output_text.delta", { output_index: 0, content_index: 0, delta: "partial" }),
      // stream aborts here - no output_item.done, no response.completed
    ];
    const message = reconstructMessage(events)!;
    const item = (message.output as any[])[0];
    assert.equal(item.content[0].text, "partial");
  });

  it("keeps a non-lite backend's populated response.completed.output as-is", () => {
    const events = [
      ev("response.output_item.done", { output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "stale" }] } }),
      ev("response.completed", {
        response: {
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "final" }] }],
        },
      }),
    ];
    const message = reconstructMessage(events)!;
    assert.equal((message.output as any[])[0].content[0].text, "final");
  });

  it("keeps tool call items in output order", () => {
    const events = [
      ev("response.output_item.done", { output_index: 0, item: { type: "custom_tool_call", name: "exec", call_id: "call_1" } }),
      ev("response.completed", { response: { status: "completed", output: [] } }),
    ];
    const message = reconstructMessage(events)!;
    assert.equal((message.output as any[])[0].name, "exec");
  });
});

describe("responseFacts", () => {
  it("reads usage, status and tool call names from the reconstructed message", () => {
    const message = {
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5 },
      output: [{ type: "custom_tool_call", name: "exec" }, { type: "message", role: "assistant", content: [] }],
    };
    const facts = responseFacts(message, undefined);
    assert.deepEqual(facts.usage, { input_tokens: 10, output_tokens: 5 });
    assert.equal(facts.stopReason, "completed");
    assert.deepEqual(facts.toolCalls, ["exec"]);
  });

  it("falls back to the raw body for a non-streamed reply", () => {
    const facts = responseFacts(undefined, { status: "completed", output: [] });
    assert.equal(facts.stopReason, "completed");
    assert.equal(facts.toolCalls, undefined);
  });

  it("tolerates a reply with neither a message nor a usable body", () => {
    const facts = responseFacts(undefined, undefined);
    assert.deepEqual(facts, { usage: undefined, stopReason: undefined, toolCalls: undefined });
  });
});
