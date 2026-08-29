import { tryParseJson } from "./util.ts";

export interface SseEvent {
  /** Milliseconds since the upstream request was sent. */
  at: number;
  event: string;
  data: unknown;
}

/**
 * Incremental SSE parser. Feed it decoded chunks; it emits one entry per
 * `event:`/`data:` pair. Anthropic sends exactly one JSON object per event.
 */
export class SseParser {
  #buffer = "";
  readonly events: SseEvent[] = [];

  push(chunk: string, at: number): SseEvent[] {
    this.#buffer += chunk;
    const out: SseEvent[] = [];
    let idx: number;
    // Events are separated by a blank line (\n\n, tolerating \r\n).
    while ((idx = this.#buffer.search(/\r?\n\r?\n/)) !== -1) {
      const match = /\r?\n\r?\n/.exec(this.#buffer.slice(idx))!;
      const block = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + match[0].length);
      const parsed = parseBlock(block, at);
      if (parsed) {
        out.push(parsed);
        this.events.push(parsed);
      }
    }
    return out;
  }

  /** Flush a trailing event that arrived without a terminating blank line. */
  end(at: number): SseEvent[] {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    if (!rest) return [];
    const parsed = parseBlock(rest, at);
    if (!parsed) return [];
    this.events.push(parsed);
    return [parsed];
  }
}

function parseBlock(block: string, at: number): SseEvent | undefined {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join("\n");
  return { at, event, data: tryParseJson(raw) ?? raw };
}

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
