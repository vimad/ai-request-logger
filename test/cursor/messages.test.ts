import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cursor } from "../../src/cursor/index.ts";
import { decodeStream, reconstructMessage } from "../../src/cursor/messages.ts";
import { endFrame, envelope, messageFrame, stateFrame } from "./encode.ts";

const HEADERS = {
  "content-type": "application/connect+proto",
  "connect-content-encoding": "gzip",
};

const ASSISTANT = {
  id: "1",
  role: "assistant",
  content: [
    { type: "reasoning", text: "", signature: "sig" },
    { type: "tool-call", toolCallId: "c1", toolName: "Read", args: { path: "/tmp/note.txt" } },
  ],
};

const ASSISTANT_TEXT = {
  id: "2",
  role: "assistant",
  content: [{ type: "text", text: "It says hello." }],
};

function stream(...frames: Buffer[]): Buffer {
  return Buffer.concat(frames);
}

describe("cursor stream framing", () => {
  it("chooses binary framing for the run stream, whatever it calls itself", () => {
    // The agent stream announces text/event-stream but carries envelopes.
    assert.equal(cursor.streamFraming?.({ "content-type": "text/event-stream" }), "binary");
    assert.equal(cursor.streamFraming?.({ "content-type": "application/connect+proto" }), "binary");
    assert.equal(cursor.streamFraming?.({ "content-type": "application/proto" }), "none");
  });

  it("decodes one event per envelope", () => {
    const events = decodeStream(
      stream(
        messageFrame(1, { role: "user", content: "hi" }),
        messageFrame(2, ASSISTANT),
        endFrame({}),
      ),
      HEADERS,
    );
    assert.equal(events.length, 3);
    assert.equal(events[0]?.event, "message");
    assert.equal(events[2]?.event, "end");
  });

  it("reads a frame whose payload was gzipped on its own", () => {
    const events = decodeStream(stream(messageFrame(1, ASSISTANT_TEXT, { gzip: true })), HEADERS);
    assert.equal((events[0]?.data as { role?: string }).role, "assistant");
  });

  it("reports a stream cut off mid-frame instead of dropping it", () => {
    const whole = messageFrame(1, ASSISTANT_TEXT);
    const events = decodeStream(whole.subarray(0, whole.length - 10), HEADERS);
    assert.equal(events.at(-1)?.event, "truncated");
  });

  it("survives bytes that are not envelopes at all", () => {
    assert.doesNotThrow(() => decodeStream(Buffer.from("nonsense"), HEADERS));
  });
});

describe("cursor stream reconstruction", () => {
  it("folds the transcript, the tool calls and the assistant text into one object", () => {
    const events = decodeStream(
      stream(
        messageFrame(1, { role: "system", content: "You are..." }),
        messageFrame(2, { role: "user", content: "read it" }),
        messageFrame(3, ASSISTANT),
        messageFrame(4, { role: "tool", content: "hello" }),
        messageFrame(5, ASSISTANT_TEXT),
        endFrame({}),
      ),
      HEADERS,
    );
    const message = reconstructMessage(events);
    assert.equal((message?.messages as unknown[]).length, 5);
    assert.deepEqual(message?.toolCalls, ["Read"]);
    assert.equal(message?.text, "It says hello.");
    assert.equal(message?.stopReason, "end_of_stream");
  });

  it("keeps the context breakdown that only the earlier frame carried", () => {
    // Cursor reports components once, then keeps sending running totals.
    const events = decodeStream(
      stream(
        stateFrame(1000, 256000, [
          { id: "system_prompt", label: "System prompt", tokens: 600, chars: 2400 },
          { id: "tools", label: "Tool definitions", tokens: 400, chars: 1600 },
        ]),
        stateFrame(1500, 256000),
      ),
      HEADERS,
    );
    const usage = reconstructMessage(events)?.usage as {
      usedTokens: number;
      components: unknown[];
    };
    assert.equal(usage.usedTokens, 1500, "the latest total wins");
    assert.equal(usage.components.length, 2, "the breakdown is not lost");
  });

  it("marks a cancelled run as truncated", () => {
    const whole = messageFrame(1, ASSISTANT_TEXT);
    const events = decodeStream(whole.subarray(0, whole.length - 5), HEADERS);
    assert.equal(reconstructMessage(events)?.stopReason, "truncated");
  });

  it("returns undefined when the stream carried nothing", () => {
    assert.equal(reconstructMessage([]), undefined);
  });
});

describe("cursor response facts", () => {
  it("surfaces usage, stop reason and tool names for the rollups", () => {
    const events = decodeStream(
      stream(messageFrame(1, ASSISTANT), stateFrame(900, 256000), endFrame({})),
      HEADERS,
    );
    const facts = cursor.responseFacts(reconstructMessage(events), undefined);
    assert.deepEqual(facts.toolCalls, ["Read"]);
    assert.equal(facts.stopReason, "end_of_stream");
    assert.equal((facts.usage as { usedTokens: number }).usedTokens, 900);
  });

  it("says nothing rather than inventing facts for a plumbing reply", () => {
    assert.deepEqual(cursor.responseFacts(undefined, undefined), {});
    assert.deepEqual(cursor.responseFacts(undefined, "not json"), {});
  });

  it("ignores an empty tool list instead of reporting one", () => {
    const events = decodeStream(stream(messageFrame(1, { role: "user", content: "hi" })), HEADERS);
    assert.equal(cursor.responseFacts(reconstructMessage(events), undefined).toolCalls, undefined);
  });

  it("does not treat a bare non-envelope frame as a message", () => {
    const events = decodeStream(envelope(Buffer.from([0x08, 0x01])), HEADERS);
    assert.ok(events.every((e) => e.event !== "message"));
  });
});
