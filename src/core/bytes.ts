/**
 * Byte-exact body capture.
 *
 * A body only becomes a JSON string when it survives the round trip. Anything
 * else - protobuf, gzip, an image - is stored as base64 instead, because
 * `Buffer.toString("utf8")` silently replaces every invalid sequence with
 * U+FFFD and there is no way back. Providers that speak a binary wire format
 * read the bytes back with `decodeBody`.
 */

/** A body that is not valid UTF-8, stored losslessly. */
export interface BinaryBody {
  __binary: true;
  encoding: "base64";
  bytes: number;
  data: string;
}

export function isBinaryBody(value: unknown): value is BinaryBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as BinaryBody).__binary === true &&
    typeof (value as BinaryBody).data === "string"
  );
}

/** Text when the bytes are valid UTF-8, base64 otherwise. */
export function encodeBody(buf: Buffer): string | BinaryBody {
  const text = buf.toString("utf8");
  if (Buffer.from(text, "utf8").equals(buf)) return text;
  return { __binary: true, encoding: "base64", bytes: buf.length, data: buf.toString("base64") };
}

/** The inverse of `encodeBody`, for renderers reading a capture back. */
export function decodeBody(value: unknown): Buffer | undefined {
  if (isBinaryBody(value)) return Buffer.from(value.data, "base64");
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return undefined;
}
