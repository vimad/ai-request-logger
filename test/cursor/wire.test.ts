import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { readEnvelopes, decodeBodyEncoding } from "../../src/cursor/connect.ts";
import { all, decodeMessage, hexMessage, numeric, one, str, toPlain } from "../../src/cursor/protobuf.ts";
import { bytesField, endFrame, envelope, message, varintField } from "./encode.ts";

describe("protobuf wire reading", () => {
  it("reads varints, strings and nested messages", () => {
    const buf = message(
      varintField(1, 300),
      bytesField(2, "hello"),
      bytesField(3, message(bytesField(1, "nested"))),
    );
    const fields = decodeMessage(buf);
    assert.equal(one(fields, 1)?.varint, 300n);
    assert.equal(str(fields, 2), "hello");
    assert.equal(str(fields, 3, 1), "nested");
  });

  it("keeps every occurrence of a repeated field", () => {
    const buf = message(bytesField(14, "a"), bytesField(14, "b"), bytesField(14, "c"));
    assert.equal(all(decodeMessage(buf), 14).length, 3);
  });

  it("reads a count Cursor sent as a decimal string", () => {
    assert.equal(numeric(decodeMessage(bytesField(1, "14664")), 1), 14664);
    assert.equal(numeric(decodeMessage(varintField(1, 12)), 1), 12);
    assert.equal(numeric(decodeMessage(bytesField(1, "not a number")), 1), undefined);
  });

  it("decodes a payload carried as a hex string", () => {
    const inner = message(bytesField(1, "payload"));
    const outer = decodeMessage(bytesField(1, inner.toString("hex")));
    assert.equal(str(hexMessage(one(outer, 1)), 1), "payload");
  });

  it("does not mistake ordinary text for a hex payload", () => {
    assert.equal(hexMessage(one(decodeMessage(bytesField(1, "hello there")), 1)), undefined);
  });

  it("returns undefined for bytes that are not protobuf, rather than throwing", () => {
    for (const junk of [Buffer.from([0xff]), Buffer.from([0x08]), Buffer.from("\x00\x01\x02")]) {
      assert.doesNotThrow(() => decodeMessage(junk));
    }
  });

  it("keeps a short submessage readable both ways", () => {
    // `{1: "auto-smart"}` is indistinguishable from a string on the wire, so
    // the field must carry both readings or the model name goes missing.
    const buf = message(bytesField(9, message(bytesField(1, "auto-smart"))));
    assert.equal(str(decodeMessage(buf), 9, 1), "auto-smart");
  });

  it("turns a decoded message into plain JSON, arraying repeats", () => {
    const plain = toPlain(decodeMessage(message(bytesField(1, "a"), bytesField(1, "b"))));
    assert.deepEqual(plain, { f1: ["a", "b"] });
  });
});

describe("connect envelope framing", () => {
  it("splits a stream into frames", () => {
    const buf = Buffer.concat([
      envelope(bytesField(1, "one")),
      envelope(bytesField(1, "two")),
    ]);
    const frames = readEnvelopes(buf);
    assert.equal(frames.length, 2);
    assert.equal(str(decodeMessage(frames[1]!.payload!), 1), "two");
  });

  it("decompresses a frame flagged as compressed", () => {
    const frames = readEnvelopes(envelope(bytesField(1, "squeezed"), { gzip: true }));
    assert.equal(str(decodeMessage(frames[0]!.payload!), 1), "squeezed");
  });

  it("marks the trailer frame that closes the stream", () => {
    const frames = readEnvelopes(endFrame({ error: null }));
    assert.equal(frames[0]?.end, true);
  });

  it("reports a truncated tail instead of losing the frames before it", () => {
    const whole = Buffer.concat([envelope(bytesField(1, "kept")), envelope(bytesField(1, "cut"))]);
    const frames = readEnvelopes(whole.subarray(0, whole.length - 2));
    assert.equal(frames.length, 2);
    assert.equal(str(decodeMessage(frames[0]!.payload!), 1), "kept");
    assert.equal(frames[1]?.truncated, true);
  });

  it("leaves a broken payload as bytes rather than failing the frame", () => {
    const header = Buffer.alloc(5);
    header[0] = 0x01;
    header.writeUInt32BE(4, 1);
    const frames = readEnvelopes(Buffer.concat([header, Buffer.from([1, 2, 3, 4])]));
    assert.equal(frames[0]?.payload?.length, 4);
  });
});

describe("whole-body encodings", () => {
  it("gunzips a body and passes an unencoded one through untouched", () => {
    const raw = Buffer.from("some protobuf");
    assert.deepEqual(decodeBodyEncoding(gzipSync(raw), "gzip"), raw);
    assert.deepEqual(decodeBodyEncoding(raw, undefined), raw);
  });

  it("keeps the bytes when the codec is wrong, rather than throwing them away", () => {
    const raw = Buffer.from("not actually gzipped");
    assert.deepEqual(decodeBodyEncoding(raw, "gzip"), raw);
  });
});
