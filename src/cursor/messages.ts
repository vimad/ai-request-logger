/**
 * Reading the `RunSSE` reply.
 *
 * `RunSSE` is the whole conversation on one long-lived response: Cursor pushes
 * the assembled context down it as JSON messages (`system`, `user`,
 * `assistant`, `tool`), interleaved with protobuf status frames. Each envelope
 * becomes one event; `reconstructMessage` folds them back into the single
 * object a non-streaming call would have returned.
 */
import type { SseEvent } from "../core/sse.ts";
import type { ResponseFacts } from "../core/types.ts";
import { readEnvelopes } from "./connect.ts";
import { all, decodeMessage, msg, numeric, one, str, toPlain } from "./protobuf.ts";
import type { PbField } from "./protobuf.ts";

/** What the top-level field number of a frame means, learned from captures. */
const FRAME_KINDS: Record<number, string> = {
  1: "run.control",
  2: "run.start",
  3: "run.state",
  4: "message",
};

export interface CursorMessage {
  seq?: number;
  role?: string;
  /** The message as Cursor sent it, parsed when it was JSON. */
  content?: unknown;
}

/** Cursor reports how full the context window is, not a billing split. */
export interface CursorUsage {
  usedTokens?: number;
  maxTokens?: number;
  /** Per-component breakdown: system prompt, tools, files, and so on. */
  components?: Array<{ id?: string; label?: string; tokens?: number; chars?: number }>;
}

function parseJsonish(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/**
 * The context-usage frame. The totals sit at field 5, and the per-component
 * breakdown one level further in - field 5 repeats its own totals alongside
 * the components, which is why this reads `5.3.3` and not `5.3`.
 */
function readUsage(fields: PbField[] | undefined): CursorUsage | undefined {
  const usage = msg(fields, 5);
  if (!usage) return undefined;
  const breakdown = msg(usage, 3) ?? usage;
  const components = all(breakdown, 3)
    .map((c) => ({
      id: str(c.message, 1),
      label: str(c.message, 2),
      tokens: numeric(c.message, 3),
      chars: numeric(c.message, 4),
    }))
    .filter((c) => c.id !== undefined);
  const out: CursorUsage = {
    usedTokens: numeric(usage, 1) ?? numeric(breakdown, 1),
    maxTokens: numeric(usage, 2) ?? numeric(breakdown, 2),
    components,
  };
  return out.usedTokens === undefined && components.length === 0 ? undefined : out;
}

/**
 * Split the response body into events, one per Connect envelope.
 *
 * The core hands over the whole body rather than streaming it, so there is no
 * per-frame arrival time to record; `at` is 0 on every event and the ordering
 * lives in `seq` and in the line order of `stream.jsonl`.
 */
export function decodeStream(body: Buffer, headers: Record<string, string>): SseEvent[] {
  const encoding = headers["connect-content-encoding"] ?? "gzip";
  const frames = readEnvelopes(body, encoding);

  const out: SseEvent[] = [];
  for (const frame of frames) {
    if (frame.truncated) {
      out.push({ at: 0, event: "truncated", data: { note: "stream ended mid-frame" } });
      continue;
    }
    if (frame.end) {
      out.push({ at: 0, event: "end", data: parseJsonish(frame.payload?.toString("utf8")) });
      continue;
    }
    const fields = frame.payload && decodeMessage(frame.payload);
    if (!fields || fields.length === 0) continue;

    const top = fields[0]!;
    const event = FRAME_KINDS[top.field] ?? `frame.${top.field}`;
    const inner = top.message;

    if (top.field === 4) {
      // A message append: `{ seq, { hash, JSON-or-message } }`.
      const payload = msg(inner, 3);
      const carried = one(payload, 2);
      const content = carried?.text !== undefined ? parseJsonish(carried.text) : toPlain(carried?.message);
      out.push({
        at: 0,
        event,
        data: {
          seq: numeric(inner, 1),
          role: (content as { role?: string } | undefined)?.role,
          content,
        } satisfies CursorMessage & Record<string, unknown>,
      });
      continue;
    }

    if (top.field === 3) {
      // A state snapshot: the assistant message so far, plus context usage.
      out.push({
        at: 0,
        event,
        data: {
          seq: numeric(inner, 10),
          content: parseJsonish(str(inner, 4)),
          usage: readUsage(inner),
        },
      });
      continue;
    }

    out.push({ at: 0, event, data: toPlain(inner) ?? toPlain(fields) });
  }
  return out;
}

/**
 * Fold the event stream back into one object: the transcript, the last context
 * usage Cursor reported, and the tools the assistant called.
 */
export function reconstructMessage(events: SseEvent[]): Record<string, unknown> | undefined {
  if (events.length === 0) return undefined;

  const messages: CursorMessage[] = [];
  let usage: CursorUsage | undefined;
  let truncated = false;
  let trailer: unknown;

  for (const e of events) {
    const data = e.data as Record<string, unknown> | undefined;
    if (e.event === "truncated") truncated = true;
    if (e.event === "end") trailer = data;
    if (!data) continue;
    if (data.usage) {
      // Later frames report the running total but drop the per-component
      // breakdown, so keep the last breakdown that actually had one.
      const next = data.usage as CursorUsage;
      usage = {
        ...next,
        components: next.components?.length ? next.components : usage?.components,
      };
    }
    if (e.event === "message" && data.content !== undefined) {
      messages.push({
        seq: data.seq as number | undefined,
        role: data.role as string | undefined,
        content: data.content,
      });
    }
  }

  const toolCalls = collectToolCalls(messages);
  const text = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => textOf(m.content))
    .join("\n\n");

  return {
    messages,
    text,
    toolCalls,
    usage,
    stopReason: truncated ? "truncated" : trailer !== undefined ? "end_of_stream" : undefined,
    trailer,
  };
}

/** Assistant content is an array of typed parts, the same shape Vercel AI uses. */
function parts(content: unknown): Array<Record<string, unknown>> {
  const inner = (content as { content?: unknown } | undefined)?.content;
  return Array.isArray(inner) ? (inner as Array<Record<string, unknown>>) : [];
}

function textOf(content: unknown): string[] {
  const list = parts(content);
  if (list.length === 0) {
    const flat = (content as { content?: unknown } | undefined)?.content;
    return typeof flat === "string" ? [flat] : [];
  }
  return list.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string);
}

function collectToolCalls(messages: CursorMessage[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    for (const p of parts(m.content)) {
      if (p.type === "tool-call" && typeof p.toolName === "string") names.push(p.toolName);
    }
  }
  return names;
}

/**
 * The three facts the core rolls up. Handles both the reconstructed stream and
 * a plain body, because a plumbing call is answered without a stream at all.
 */
export function responseFacts(
  message: Record<string, unknown> | undefined,
  body: unknown,
): ResponseFacts {
  const source = message ?? (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined);
  if (!source) return {};
  const toolCalls = Array.isArray(source.toolCalls) ? (source.toolCalls as string[]) : undefined;
  return {
    usage: source.usage,
    stopReason: typeof source.stopReason === "string" ? source.stopReason : undefined,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
  };
}

/** Exposed for the renderer and the tests. */
export { readUsage, parseJsonish };
