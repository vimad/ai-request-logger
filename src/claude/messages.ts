/**
 * Anthropic stream semantics: how a sequence of SSE frames becomes one
 * `message` object, and where the facts the log rolls up live inside it.
 */
import type { SseEvent } from "../core/sse.ts";
import type { ResponseFacts } from "../core/types.ts";
import { tryParseJson } from "../core/util.ts";

interface Block {
  type: string;
  [key: string]: unknown;
}

/**
 * Rebuild the final `message` object from a stream, so the log holds the same
 * shape a non-streaming response would have had.
 */
export function reconstructMessage(events: SseEvent[]): Record<string, unknown> | undefined {
  let message: Record<string, unknown> | undefined;
  const blocks: Block[] = [];
  const partials = new Map<number, { text: string; json: string; thinking: string }>();

  for (const { event, data } of events) {
    if (typeof data !== "object" || data === null) continue;
    const d = data as Record<string, any>;
    switch (event) {
      case "message_start":
        message = structuredClone(d.message ?? {});
        break;
      case "content_block_start": {
        const i = d.index as number;
        blocks[i] = structuredClone(d.content_block ?? { type: "unknown" });
        partials.set(i, { text: "", json: "", thinking: "" });
        break;
      }
      case "content_block_delta": {
        const i = d.index as number;
        const p = partials.get(i) ?? { text: "", json: "", thinking: "" };
        partials.set(i, p);
        const delta = d.delta ?? {};
        if (typeof delta.text === "string") p.text += delta.text;
        if (typeof delta.partial_json === "string") p.json += delta.partial_json;
        if (typeof delta.thinking === "string") p.thinking += delta.thinking;
        if (typeof delta.signature === "string" && blocks[i]) blocks[i]!.signature = delta.signature;
        break;
      }
      case "content_block_stop": {
        const i = d.index as number;
        const p = partials.get(i);
        const b = blocks[i];
        if (!b || !p) break;
        if (p.text) b.text = (typeof b.text === "string" ? b.text : "") + p.text;
        if (p.thinking) b.thinking = (typeof b.thinking === "string" ? b.thinking : "") + p.thinking;
        if (p.json) {
          const parsed = tryParseJson(p.json);
          b.input = parsed ?? { __unparsed_partial_json: p.json };
        }
        break;
      }
      case "message_delta": {
        if (!message) break;
        Object.assign(message, d.delta ?? {});
        if (d.usage) message.usage = { ...(message.usage as object), ...d.usage };
        break;
      }
      default:
        break;
    }
  }

  if (!message) return undefined;
  message.content = blocks.filter(Boolean);
  return message;
}

/**
 * Streamed and non-streamed replies carry the same fields; the streamed one is
 * the object `reconstructMessage` rebuilt, so one reader serves both.
 */
export function responseFacts(
  message: Record<string, unknown> | undefined,
  body: unknown,
): ResponseFacts {
  const src = (message ?? (body as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;
  const content = Array.isArray(src.content) ? (src.content as Array<Record<string, unknown>>) : undefined;
  return {
    usage: src.usage,
    stopReason: typeof src.stop_reason === "string" ? src.stop_reason : undefined,
    toolCalls: content?.filter((b) => b?.type === "tool_use").map((b) => String(b.name)),
  };
}
