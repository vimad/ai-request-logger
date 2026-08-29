/**
 * Connect protocol framing, as the Cursor CLI speaks it.
 *
 * Two shapes reach the proxy:
 *
 * - **Unary** (`application/proto`): the body is one protobuf message, gzipped
 *   whole when `content-encoding: gzip` is set. Every plumbing call is this.
 * - **Streaming** (`application/connect+proto`): the body is a series of
 *   envelopes, each `[1 byte flags][4 byte big-endian length][payload]`. Bit 0
 *   of the flags means the payload is compressed with whatever
 *   `connect-content-encoding` names; bit 1 marks the final frame, whose
 *   payload is a JSON trailer rather than a message.
 *
 * The CLI reaches the streaming shape only with `network.useHttp1ForAgent`
 * set - on HTTP/2 it uses a bidirectional stream the proxy never sees. See
 * docs/adding-a-provider.md.
 */
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** Bit 1 of an envelope's flags: the last frame, carrying a JSON trailer. */
const END_STREAM = 0x02;
/** Bit 0: the payload is compressed. */
const COMPRESSED = 0x01;

export interface Envelope {
  flags: number;
  /** Decompressed payload, or undefined when the frame was cut short. */
  payload?: Buffer;
  /** True for the trailer frame that closes a Connect stream. */
  end: boolean;
  /** Set when the frame was truncated - a cancelled request, not an error. */
  truncated?: boolean;
}

function decompress(buf: Buffer, encoding: string): Buffer {
  try {
    if (encoding.includes("br")) return brotliDecompressSync(buf);
    if (encoding.includes("deflate")) return inflateSync(buf);
    return gunzipSync(buf);
  } catch {
    // An unknown or broken codec still leaves the bytes worth keeping.
    return buf;
  }
}

/** Undo a whole-body `content-encoding`, leaving anything else untouched. */
export function decodeBodyEncoding(buf: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return buf;
  return decompress(buf, encoding.toLowerCase());
}

/** Split a Connect stream into its envelopes. Never throws. */
export function readEnvelopes(buf: Buffer, encoding = "gzip"): Envelope[] {
  const out: Envelope[] = [];
  let at = 0;
  while (at + 5 <= buf.length) {
    const flags = buf[at]!;
    const length = buf.readUInt32BE(at + 1);
    const end = (flags & END_STREAM) !== 0;
    if (at + 5 + length > buf.length) {
      out.push({ flags, end, truncated: true });
      return out;
    }
    const raw = buf.subarray(at + 5, at + 5 + length);
    out.push({
      flags,
      end,
      payload: (flags & COMPRESSED) !== 0 ? decompress(raw, encoding) : raw,
    });
    at += 5 + length;
  }
  if (at < buf.length) out.push({ flags: 0, end: false, truncated: true });
  return out;
}

/** True for a body carrying Connect envelopes rather than a bare message. */
export function isEnveloped(contentType: string | undefined): boolean {
  return (contentType ?? "").includes("connect+");
}
