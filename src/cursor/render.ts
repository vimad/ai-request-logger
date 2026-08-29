/**
 * `request.md` for the Cursor CLI, plus the token tables.
 *
 * Every function here is a pure function of the two JSON files beside it, so
 * `npm run report` regenerates byte-identical Markdown months later. It will
 * meet captures written by older versions of itself, so every read is guarded.
 */
import { block, bytes, details, duration, json, num, table } from "../core/markdown.ts";
import { NO_TOKENS, type ProviderRenderer, type RenderRequestOptions, type TokenBreakdown } from "../core/types.ts";
import type { CursorMessage, CursorUsage } from "./messages.ts";

interface CapturedRequest {
  at?: string;
  path?: string;
  shape?: {
    kind?: string;
    model?: string;
    endpoint?: string;
    conversationId?: string;
    runId?: string;
    seq?: number;
    eventFields?: number[];
    promptChars?: number;
    availableModels?: number;
    clientVersion?: string;
    ghostMode?: boolean;
    messageCount?: number;
  };
  body?: unknown;
}

interface CapturedResponse {
  status?: number;
  error?: string;
  timing?: { ttfbMs?: number; durationMs?: number };
  sseEvents?: number;
  usage?: CursorUsage;
  stopReason?: string;
  toolCalls?: string[];
  body?: {
    messages?: CursorMessage[];
    text?: string;
    toolCalls?: string[];
    trailer?: unknown;
  };
}

/**
 * Cursor reports how full the context window is, not what was billed. The
 * whole context is prompt, so it lands in `input`; there is no output or cache
 * number on this channel and zero-filling them would invent a fact.
 */
export function tokens(usage: unknown): TokenBreakdown {
  const u = usage as CursorUsage | undefined;
  const used = typeof u?.usedTokens === "number" ? u.usedTokens : 0;
  return { ...NO_TOKENS, input: used, total: used };
}

export function usageTable(t: TokenBreakdown | undefined): string {
  if (!t) return "_No usage reported._";
  return table([["Context tokens", num(t.input)]]);
}

/** The per-component context breakdown, which only a single request carries. */
function contextTable(usage: CursorUsage | undefined): string {
  const components = usage?.components ?? [];
  if (components.length === 0) return "";
  const rows: Array<[string, string]> = components.map((c) => [
    c.label ?? c.id ?? "?",
    `${num(c.tokens)} tokens${c.chars !== undefined ? ` · ${bytes(c.chars)}` : ""}`,
  ]);
  if (usage?.usedTokens !== undefined) {
    rows.push([
      "**Total**",
      `**${num(usage.usedTokens)}**${usage.maxTokens ? ` of ${num(usage.maxTokens)}` : ""}`,
    ]);
  }
  return `\n### Context window\n\n${table(rows)}\n`;
}

function roleLabel(m: CursorMessage): string {
  const seq = m.seq !== undefined ? ` · #${m.seq}` : "";
  return `${m.role ?? "message"}${seq}`;
}

/** One message, rendered by the shape Cursor sent it in. */
function renderMessage(m: CursorMessage): string {
  const content = (m.content as { content?: unknown } | undefined)?.content;

  if (typeof content === "string") {
    return details(`${roleLabel(m)} · ${bytes(content.length)}`, block(content, "markdown"));
  }

  if (Array.isArray(content)) {
    const parts = (content as Array<Record<string, unknown>>).map((p) => {
      const type = String(p.type ?? "part");
      if (type === "text" && typeof p.text === "string") return block(p.text, "markdown");
      if (type === "reasoning") {
        const text = typeof p.text === "string" && p.text !== "" ? p.text : "_(signature only)_";
        return details("reasoning", block(text, "markdown"));
      }
      if (type === "tool-call") {
        return details(`tool-call · \`${String(p.toolName ?? "?")}\``, json(p.args));
      }
      if (type === "tool-result") {
        return details(`tool-result · \`${String(p.toolName ?? "?")}\``, json(p.result ?? p.output));
      }
      return details(type, json(p));
    });
    return details(`${roleLabel(m)} · ${parts.length} part(s)`, parts.join("\n\n"));
  }

  return details(roleLabel(m), json(m.content));
}

export function request(req: unknown, res: unknown, _opts: RenderRequestOptions): string {
  const q = (req ?? {}) as CapturedRequest;
  const r = (res ?? {}) as CapturedResponse;
  const shape = q.shape ?? {};
  const out: string[] = [];

  const endpoint = shape.endpoint ?? "request";
  out.push(`# ${endpoint}${shape.model ? ` · ${shape.model}` : ""}`);
  out.push("");

  const summary: Array<[string, string]> = [
    ["Path", `\`${q.path ?? "?"}\``],
    ["Kind", shape.kind ?? "raw"],
    ["Status", r.error ? `error - ${r.error}` : String(r.status ?? "?")],
    ["Duration", duration(r.timing?.durationMs)],
  ];
  if (r.timing?.ttfbMs !== undefined) summary.push(["Time to first byte", duration(r.timing.ttfbMs)]);
  if (shape.runId) summary.push(["Run", `\`${shape.runId}\``]);
  if (shape.conversationId) summary.push(["Conversation", `\`${shape.conversationId}\``]);
  if (shape.seq !== undefined) summary.push(["Event sequence", String(shape.seq)]);
  if (shape.clientVersion) summary.push(["Client", shape.clientVersion]);
  if (shape.ghostMode) summary.push(["Privacy", "ghost mode"]);
  if (shape.availableModels) summary.push(["Models offered", String(shape.availableModels)]);
  if (r.sseEvents !== undefined) summary.push(["Stream frames", num(r.sseEvents)]);
  if (r.stopReason) summary.push(["Stop reason", r.stopReason]);
  out.push(table(summary));

  const toolCalls = r.toolCalls ?? r.body?.toolCalls ?? [];
  if (toolCalls.length > 0) {
    out.push("");
    out.push(`**Tools called:** ${toolCalls.map((t) => `\`${t}\``).join(", ")}`);
  }

  out.push(contextTable(r.usage));

  const messages = r.body?.messages ?? [];
  if (messages.length > 0) {
    out.push(`\n## Transcript · ${messages.length} message(s)\n`);
    for (const m of messages) out.push(renderMessage(m));
  }

  if (r.body?.text) {
    out.push("\n## Assistant text\n");
    out.push(block(r.body.text, "markdown"));
  }

  // The request body is protobuf, so show what was read out of it rather than
  // a base64 blob the reader cannot do anything with.
  if (shape.eventFields?.length) {
    out.push("\n## Client event\n");
    out.push(table([["Event fields", shape.eventFields.map((f) => `\`${f}\``).join(", ")]]));
  }

  // Keep the blank lines that separate blocks, but never emit a run of them.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export const renderer: ProviderRenderer = { tokens, usageTable, request };
