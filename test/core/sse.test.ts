import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SseParser } from "../../src/core/sse.ts";

function feed(chunks: string[]) {
  const p = new SseParser();
  chunks.forEach((c, i) => p.push(c, i));
  p.end(chunks.length);
  return p;
}

describe("SSE parsing", () => {
  it("parses events split across arbitrary chunk boundaries", () => {
    const whole = 'event: ping\ndata: {"type":"ping"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    for (const size of [1, 3, 7, 20, whole.length]) {
      const chunks: string[] = [];
      for (let i = 0; i < whole.length; i += size) chunks.push(whole.slice(i, i + size));
      const p = feed(chunks);
      assert.equal(p.events.length, 2, `chunk size ${size}`);
      assert.equal(p.events[0]!.event, "ping");
      assert.equal(p.events[1]!.event, "message_stop");
    }
  });

  it("ignores comment keep-alives but keeps ping events", () => {
    const p = feed([": ping\n\n", 'event: ping\ndata: {"type":"ping"}\n\n']);
    assert.equal(p.events.length, 1);
    assert.equal(p.events[0]!.event, "ping");
  });

  it("flushes a trailing event with no terminating blank line", () => {
    const p = new SseParser();
    p.push('event: message_stop\ndata: {"type":"message_stop"}', 0);
    assert.equal(p.events.length, 0);
    p.end(1);
    assert.equal(p.events.length, 1);
  });

  it("tolerates CRLF line endings", () => {
    const p = feed(['event: ping\r\ndata: {"type":"ping"}\r\n\r\n']);
    assert.equal(p.events.length, 1);
    assert.deepEqual(p.events[0]!.data, { type: "ping" });
  });
});
