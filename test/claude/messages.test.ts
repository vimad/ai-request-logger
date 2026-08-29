import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SseParser } from "../../src/core/sse.ts";
import { reconstructMessage, responseFacts } from "../../src/claude/messages.ts";

/** Feed chunks through the transport parser to get a realistic event list. */
function feed(chunks: string[]) {
  const p = new SseParser();
  chunks.forEach((c, i) => p.push(c, i));
  p.end(chunks.length);
  return p;
}

describe("message reconstruction", () => {
  const stream = (extra: string[] = []) =>
    feed([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant","model":"m","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
      ...extra,
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);

  it("joins text deltas into one block", () => {
    const msg = reconstructMessage(stream().events)!;
    assert.equal((msg.content as any[])[0].text, "Hello");
  });

  it("reassembles tool input split across input_json_delta fragments", () => {
    const msg = reconstructMessage(
      stream([
        'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"comm"}}\n\n',
        'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"and\\":\\"ls -la\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"index":1}\n\n',
      ]).events,
    )!;
    const tool = (msg.content as any[])[1];
    assert.equal(tool.name, "Bash");
    assert.deepEqual(tool.input, { command: "ls -la" });
  });

  it("keeps unparseable partial JSON instead of losing it", () => {
    const msg = reconstructMessage(
      stream([
        'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"broke"}}\n\n',
        'event: content_block_stop\ndata: {"index":1}\n\n',
      ]).events,
    )!;
    assert.equal((msg.content as any[])[1].input.__unparsed_partial_json, '{"broke');
  });

  it("merges stop_reason and usage from message_delta", () => {
    const msg = reconstructMessage(stream().events)!;
    assert.equal(msg.stop_reason, "end_turn");
    assert.equal((msg.usage as any).output_tokens, 57);
    assert.equal((msg.usage as any).input_tokens, 10, "message_start usage is preserved");
  });

  it("accumulates thinking blocks and their signature", () => {
    const msg = reconstructMessage(
      feed([
        'event: message_start\ndata: {"message":{"id":"m","content":[]}}\n\n',
        'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"step "}}\n\n',
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"two"}}\n\n',
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"signature_delta","signature":"sig123"}}\n\n',
        'event: content_block_stop\ndata: {"index":0}\n\n',
      ]).events,
    )!;
    assert.equal((msg.content as any[])[0].thinking, "step two");
    assert.equal((msg.content as any[])[0].signature, "sig123");
  });

  it("returns undefined when there was no message_start", () => {
    assert.equal(reconstructMessage(feed(['event: ping\ndata: {}\n\n']).events), undefined);
  });
});

describe("response facts", () => {
  it("reads usage, stop reason and tool calls from a streamed reply", () => {
    const msg = reconstructMessage(
      feed([
        'event: message_start\ndata: {"message":{"id":"m","content":[],"usage":{"input_tokens":10}}}\n\n',
        'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
        'event: content_block_stop\ndata: {"index":0}\n\n',
        'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
      ]).events,
    );
    const facts = responseFacts(msg, undefined);
    assert.equal(facts.stopReason, "tool_use");
    assert.deepEqual(facts.toolCalls, ["Bash"]);
    assert.equal((facts.usage as any).output_tokens, 7);
  });

  it("reads the same facts from a non-streamed body", () => {
    const facts = responseFacts(undefined, {
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    assert.equal(facts.stopReason, "end_turn");
    assert.deepEqual(facts.toolCalls, []);
    assert.equal((facts.usage as any).input_tokens, 3);
  });
});
