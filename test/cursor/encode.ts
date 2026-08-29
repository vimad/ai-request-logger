/**
 * Protobuf and Connect encoders, so the Cursor tests can build wire-shaped
 * bodies by hand.
 *
 * These deliberately reproduce the quirks the real CLI has - the event blob
 * carried as a *hex string*, counts sent as decimal strings, envelopes whose
 * payload is gzipped individually - because those are what the provider has to
 * get right. Synthetic rather than captured, so no real prompt, path or key
 * ends up committed.
 */
import { gzipSync } from "node:zlib";

export function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Buffer.from(out);
}

/** A length-delimited (wire type 2) field. */
export function bytesField(field: number, value: Buffer | string): Buffer {
  const buf = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf]);
}

/** A varint (wire type 0) field. */
export function varintField(field: number, value: number): Buffer {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

export function message(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

/** One Connect envelope: `[flags][uint32 length][payload]`. */
export function envelope(payload: Buffer, opts: { gzip?: boolean; end?: boolean } = {}): Buffer {
  const body = opts.gzip ? gzipSync(payload) : payload;
  const header = Buffer.alloc(5);
  header[0] = (opts.gzip ? 0x01 : 0) | (opts.end ? 0x02 : 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/* --------------------------------------------------- request-side shapes */

export interface UserTurnOptions {
  prompt: string;
  promptId?: string;
  runId?: string;
  model?: string;
  conversationId?: string;
  /** How many models the catalogue offered, repeated as field 14. */
  models?: string[];
}

/** The event blob a BidiAppend carries when the user submits a prompt. */
export function userTurnEvent(o: UserTurnOptions): Buffer {
  const turn = message(
    bytesField(2, message(bytesField(1, message(bytesField(1, message(
      bytesField(1, o.prompt),
      bytesField(2, o.promptId ?? "prompt-id"),
    )))))),
    bytesField(5, o.runId ?? "run-1"),
    bytesField(9, message(bytesField(1, o.model ?? "auto-smart"))),
    ...(o.models ?? []).map((m) => bytesField(14, message(bytesField(1, m)))),
    bytesField(25, o.conversationId ?? "conv-1"),
  );
  return message(bytesField(1, turn));
}

/** An event that is not a user prompt - a tool result, an ack, a cancel. */
export function otherEvent(field = 3): Buffer {
  return message(bytesField(field, message(varintField(1, 1))));
}

/**
 * A BidiAppend body. Field 1 is the event as a hex *string*, which is the
 * quirk that matters: read it as bytes and it decodes to nothing.
 */
export function bidiAppend(event: Buffer, conversationId = "conv-1", seq?: number): Buffer {
  return message(
    bytesField(1, event.toString("hex")),
    bytesField(2, message(bytesField(1, conversationId))),
    ...(seq === undefined ? [] : [bytesField(3, String(seq))]),
  );
}

/** The RunSSE request body: one envelope naming the HTTP request. */
export function runRequest(requestId = "req-1"): Buffer {
  return envelope(message(bytesField(1, requestId)));
}

/* -------------------------------------------------- response-side shapes */

/** A frame appending one message to the transcript. */
export function messageFrame(seq: number, msg: unknown, opts: { gzip?: boolean } = {}): Buffer {
  const payload = message(
    bytesField(
      4,
      message(
        bytesField(1, String(seq)),
        bytesField(
          3,
          message(bytesField(1, Buffer.alloc(32, 7)), bytesField(2, JSON.stringify(msg))),
        ),
      ),
    ),
  );
  return envelope(payload, opts);
}

export interface UsageComponent {
  id: string;
  label: string;
  tokens: number;
  chars: number;
}

/** A state frame carrying the context-window reading. */
export function stateFrame(
  used: number,
  max: number,
  components: UsageComponent[] = [],
): Buffer {
  // The real service repeats the totals inside field 3 and hangs the
  // components off *that*, so the fixtures have to nest the same way.
  const breakdown = message(
    bytesField(1, String(used)),
    bytesField(2, String(max)),
    ...components.map((c) =>
      bytesField(
        3,
        message(
          bytesField(1, c.id),
          bytesField(2, c.label),
          bytesField(3, String(c.tokens)),
          bytesField(4, String(c.chars)),
        ),
      ),
    ),
  );
  const usage = message(
    bytesField(1, String(used)),
    bytesField(2, String(max)),
    bytesField(3, breakdown),
  );
  return envelope(message(bytesField(3, message(bytesField(5, usage)))));
}

/** The trailer frame that closes a Connect stream. */
export function endFrame(trailer: unknown = {}): Buffer {
  return envelope(Buffer.from(JSON.stringify(trailer), "utf8"), { end: true });
}
