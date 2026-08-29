/**
 * Server-Sent Events transport parsing. Frame-level only: this knows about
 * `event:`/`data:` lines and blank-line separators, and nothing at all about
 * what any provider puts inside a frame.
 */
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
