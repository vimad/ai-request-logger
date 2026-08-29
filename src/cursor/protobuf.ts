/**
 * A schema-free protobuf wire-format reader.
 *
 * Cursor's agent protocol is protobuf, and the `.proto` files are not
 * published. That is survivable: the wire format is self-describing enough to
 * walk without a schema - every field carries its number and one of six wire
 * types - so this decodes into a field list and the rest of the provider names
 * the fields it has identified from captured traffic.
 *
 * Nothing here throws on bad input. A truncated frame is normal traffic (the
 * user pressed Ctrl-C), so every reader returns `undefined` and lets the caller
 * log what it did manage to read.
 */

export interface PbField {
  field: number;
  wire: number;
  /** Wire type 0 (varint) and, for convenience, 1 and 5 read as integers. */
  varint?: bigint;
  /** Wire type 2, always kept verbatim so a caller can re-interpret it. */
  bytes?: Buffer;
  /** Set when the bytes are valid UTF-8 with no control characters. */
  text?: string;
  /** Set when the bytes also parse as a nested message. Both may be set. */
  message?: PbField[];
}

const MAX_DEPTH = 24;

function readVarint(buf: Buffer, at: number): [bigint, number] | undefined {
  let result = 0n;
  let shift = 0n;
  let i = at;
  while (i < buf.length) {
    const byte = buf[i]!;
    result |= BigInt(byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 63n) return undefined;
  }
  return undefined;
}

/**
 * True when a length-delimited payload reads as text. This is a hint, not a
 * verdict: a short submessage like `{1: "auto-smart"}` is indistinguishable
 * from a string, so a field keeps *both* readings and each accessor takes the
 * one it needs.
 */
function looksTextual(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) return false;
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
}

/** Walk a protobuf message. Returns undefined if the bytes are not protobuf. */
export function decodeMessage(buf: Buffer, depth = 0): PbField[] | undefined {
  const out: PbField[] = [];
  let at = 0;
  while (at < buf.length) {
    const key = readVarint(buf, at);
    if (!key) return undefined;
    const [tag, afterKey] = key;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) return undefined;

    if (wire === 0) {
      const v = readVarint(buf, afterKey);
      if (!v) return undefined;
      out.push({ field, wire, varint: v[0] });
      at = v[1];
    } else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4;
      if (afterKey + width > buf.length) return undefined;
      out.push({ field, wire, bytes: buf.subarray(afterKey, afterKey + width) });
      at = afterKey + width;
    } else if (wire === 2) {
      const len = readVarint(buf, afterKey);
      if (!len) return undefined;
      const [rawLen, afterLen] = len;
      const size = Number(rawLen);
      if (!Number.isSafeInteger(size) || afterLen + size > buf.length) return undefined;
      const bytes = buf.subarray(afterLen, afterLen + size);
      const nested = depth >= MAX_DEPTH ? undefined : decodeMessage(bytes, depth + 1);
      out.push({
        field,
        wire,
        bytes,
        text: looksTextual(bytes) ? bytes.toString("utf8") : undefined,
        message: nested && nested.length > 0 ? nested : undefined,
      });
      at = afterLen + size;
    } else {
      // Wire types 3 and 4 are the deprecated groups; Cursor does not use them.
      return undefined;
    }
  }
  return out;
}

/* ------------------------------------------------------------ accessors */

/** Every occurrence of a field number, in wire order. Protobuf repeats freely. */
export function all(fields: PbField[] | undefined, num: number): PbField[] {
  return fields?.filter((f) => f.field === num) ?? [];
}

/** The first occurrence of a field number. */
export function one(fields: PbField[] | undefined, num: number): PbField | undefined {
  return fields?.find((f) => f.field === num);
}

/** Follow a path of field numbers down nested messages. */
export function at(fields: PbField[] | undefined, ...path: number[]): PbField | undefined {
  let here = fields;
  let hit: PbField | undefined;
  for (const num of path) {
    hit = one(here, num);
    if (!hit) return undefined;
    here = hit.message;
  }
  return hit;
}

/** A string field, following a path. */
export function str(fields: PbField[] | undefined, ...path: number[]): string | undefined {
  return at(fields, ...path)?.text;
}

/** A nested message, following a path. */
export function msg(fields: PbField[] | undefined, ...path: number[]): PbField[] | undefined {
  return at(fields, ...path)?.message;
}

/**
 * A number that Cursor encodes as a decimal string rather than a varint - it
 * does this for every count and timestamp in the agent protocol.
 */
export function numeric(fields: PbField[] | undefined, ...path: number[]): number | undefined {
  const hit = at(fields, ...path);
  if (hit?.varint !== undefined) return Number(hit.varint);
  const text = hit?.text;
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  return Number(text);
}

/**
 * Some payloads are carried as a *hex string* rather than nested bytes - the
 * event blob inside a BidiAppend is the one that matters. Decode through it.
 */
export function hexMessage(field: PbField | undefined): PbField[] | undefined {
  const text = field?.text;
  if (!text || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) return undefined;
  return decodeMessage(Buffer.from(text, "hex"));
}

/**
 * A plain-JSON view of a decoded message, for the capture. Repeated fields
 * become arrays; everything else keeps the shape the wire had. This is what
 * lands in `request.json`, so it has to be stable and self-explanatory.
 */
export function toPlain(fields: PbField[] | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = `f${f.field}`;
    const value =
      f.varint !== undefined
        ? Number(f.varint)
        : f.text !== undefined
          ? f.text
          : f.message
            ? toPlain(f.message)
            : { bytes: f.bytes?.length ?? 0, hex: f.bytes?.subarray(0, 32).toString("hex") };
    if (key in out) {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(value);
      else out[key] = [prev, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}
