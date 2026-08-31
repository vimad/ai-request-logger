/**
 * OpenAI Responses API stream semantics: how a sequence of
 * `response.*` SSE events becomes one `response` object.
 *
 * Codex's backend runs a "lite" streaming variant
 * (`x-openai-internal-codex-responses-lite: true`) that ships an *empty*
 * `output` array on the final `response.completed` event - the real content
 * only ever appears in the per-item `response.output_item.done` events along
 * the way. So the accumulated items, not the terminal event, are the source
 * of truth for `output`.
 */
import type { SseEvent } from "../core/sse.ts";
import type { ResponseFacts } from "../core/types.ts";

interface OutputItem {
  id?: string;
  type?: string;
  role?: string;
  name?: string;
  status?: string;
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Rebuild the final `response` object from a stream, so the log holds the
 * same shape a non-streaming call would have returned. Tolerates a stream cut
 * short mid-turn - the client disconnects as soon as it has what it needs,
 * which the proxy sees as an aborted upstream connection, not an error.
 */
export function reconstructMessage(events: SseEvent[]): Record<string, unknown> | undefined {
  let response: Record<string, unknown> | undefined;
  const items = new Map<number, OutputItem>();
  const order: number[] = [];

  const item = (index: number, next: unknown): OutputItem => {
    if (!items.has(index)) order.push(index);
    const cloned = structuredClone((next as OutputItem) ?? { type: "unknown" });
    items.set(index, cloned);
    return cloned;
  };

  for (const { event, data } of events) {
    if (typeof data !== "object" || data === null) continue;
    const d = data as Record<string, any>;
    switch (event) {
      case "response.created":
      case "response.in_progress":
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        response = { ...(response ?? {}), ...(d.response ?? {}) };
        break;
      case "response.output_item.added":
      case "response.output_item.done":
        item(d.output_index as number, d.item);
        break;
      case "response.output_text.delta": {
        const target = items.get(d.output_index as number);
        if (!target) break;
        const parts = Array.isArray(target.content) ? target.content : (target.content = []);
        const i = d.content_index as number;
        const part = parts[i] ?? (parts[i] = { type: "output_text", text: "" });
        part.text = (typeof part.text === "string" ? part.text : "") + String(d.delta ?? "");
        break;
      }
      default:
        break;
    }
  }

  if (!response && items.size === 0) return undefined;

  const accumulated = order.map((i) => items.get(i)).filter((x): x is OutputItem => Boolean(x));
  response ??= {};
  // The "lite" variant's `response.completed.response.output` is always `[]`;
  // prefer it only when it is genuinely non-empty (a non-lite backend, say).
  if (!Array.isArray(response.output) || response.output.length === 0) {
    response.output = accumulated;
  }
  return response;
}

/**
 * Streamed and non-streamed replies carry the same fields; the streamed one
 * is the object `reconstructMessage` rebuilt, so one reader serves both.
 */
export function responseFacts(
  message: Record<string, unknown> | undefined,
  body: unknown,
): ResponseFacts {
  const src = (message ?? (body as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;
  const output = Array.isArray(src.output) ? (src.output as OutputItem[]) : [];
  const toolCalls = output
    .filter((it) => it.type === "custom_tool_call" || it.type === "function_call")
    .map((it) => String(it.name ?? "?"));
  return {
    usage: src.usage,
    stopReason: typeof src.status === "string" ? src.status : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}
