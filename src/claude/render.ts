/**
 * Rendering the Anthropic wire format: content blocks, the token table, and
 * the whole of `request.md`. Everything here is a pure function of the JSON
 * already on disk, so the same code runs live inside the proxy and offline in
 * `report.ts`.
 */
import { block, bytes, details, duration, json, num, table, toolDetails } from "../core/markdown.ts";
import type {
  ProviderRenderer,
  RenderRequestOptions,
  TokenBreakdown,
} from "../core/types.ts";

/* ------------------------------------------------------------- token math */

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

export function tokens(usage: unknown): TokenBreakdown {
  const u = (usage ?? {}) as Usage;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Anthropic bills fresh, cache-write and cache-read prompt tokens differently,
 * so the table shows the split and the resulting cache hit rate rather than a
 * single input number.
 */
export function usageTable(t: TokenBreakdown | undefined): string {
  if (!t) return "_No usage reported._";
  const promptTotal = t.cacheRead + t.cacheWrite + t.input;
  const hit = promptTotal > 0 ? Math.round((t.cacheRead / promptTotal) * 100) : 0;

  const rows = [
    ["Input (fresh)", num(t.input)],
    t.cacheWrite ? ["Cache write", num(t.cacheWrite)] : undefined,
    t.cacheRead ? ["Cache read", `${num(t.cacheRead)}  ·  ${hit}% of prompt`] : undefined,
    ["Output", num(t.output)],
    ["**Total**", `**${num(t.total)}**`],
  ].filter(Boolean) as Array<[string, string]>;

  return ["| Tokens | |", "|---|---:|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
}

/* --------------------------------------------------------- content blocks */

function textOfBlock(b: any): string {
  if (typeof b === "string") return b;
  if (typeof b?.text === "string") return b.text;
  return JSON.stringify(b ?? null);
}

export function renderContent(content: unknown, opts: { compact?: boolean } = {}): string {
  const compact = opts.compact === true;
  if (typeof content === "string") return block(content, "text", compact);
  if (!Array.isArray(content)) return json(content ?? null, compact);

  const out: string[] = [];
  for (const b of content) {
    switch (b?.type) {
      case "text":
        out.push(block(String(b.text ?? ""), "text", compact));
        break;
      case "thinking":
        out.push(details("Thinking", block(String(b.thinking ?? ""), "text", compact), false));
        break;
      case "redacted_thinking":
        out.push("_[redacted thinking]_");
        break;
      case "tool_use": {
        const input = JSON.stringify(b.input ?? {}, null, 2);
        out.push(`**Tool call — \`${b.name}\`** &nbsp;<sub>\`${b.id ?? "?"}\`</sub>`);
        out.push(block(input, "json", compact));
        break;
      }
      case "tool_result": {
        const body =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map(textOfBlock).join("\n")
              : JSON.stringify(b.content ?? null, null, 2);
        const label = `${b.is_error ? "⚠️ Tool error" : "Tool result"} &nbsp;<sub>\`${b.tool_use_id ?? "?"}\`</sub> · ${bytes(body.length)}`;
        const rendered = block(body, "text", compact);
        out.push(body.length > 400 ? details(label, rendered) : `**${label}**\n\n${rendered}`);
        break;
      }
      case "image":
        out.push(`_[image: ${b.source?.media_type ?? "unknown"}]_`);
        break;
      case "document":
        out.push(`_[document: ${b.source?.media_type ?? "unknown"}]_`);
        break;
      default:
        out.push(json(b, compact));
    }
  }
  return out.join("\n\n");
}

function messageHeading(i: number, msg: any): string {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const kinds = new Set<string>(blocks.map((b: any) => String(b?.type)));
  const icon = msg.role === "assistant" ? "🤖" : kinds.has("tool_result") ? "🔧" : "👤";
  const tags: string[] = [];
  if (kinds.has("tool_use")) tags.push("tool call");
  if (kinds.has("tool_result")) tags.push("tool result");
  if (kinds.has("thinking")) tags.push("thinking");
  const suffix = tags.length ? ` — _${tags.join(", ")}_` : "";
  return `##### ${icon} ${i}. ${msg.role}${suffix}`;
}

function renderMessages(messages: any[], from: number, to: number, compact: boolean): string {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    out.push(messageHeading(i + 1, messages[i]));
    out.push(renderContent(messages[i].content, { compact }));
  }
  return out.join("\n\n");
}

function systemChars(system: unknown): number {
  if (typeof system === "string") return system.length;
  if (Array.isArray(system)) return system.reduce((n, b) => n + (b?.text?.length ?? 0), 0);
  return 0;
}

function renderSystem(system: unknown): string {
  if (typeof system === "string") return block(system);
  if (!Array.isArray(system)) return "_none_";
  return system
    .map((b, i) => {
      const cached = b?.cache_control ? " · `cache_control`" : "";
      return `**System block ${i + 1}** · ${bytes(b?.text?.length ?? 0)}${cached}\n\n${block(String(b?.text ?? ""))}`;
    })
    .join("\n\n");
}

/* ------------------------------------------------------------- the render */

export function renderRequest(req: any, res: any, opts: RenderRequestOptions = {}): string {
  const shape = req?.shape ?? {};
  const body = req?.body ?? {};
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const out: string[] = [];

  const title = [
    `Turn ${req?.turn ?? "?"}`,
    `Request ${req?.request ?? "?"}`,
    shape.model ?? req?.method ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  out.push(`# ${title}`);

  const ok = typeof res?.status === "number" && res.status < 400;
  const statusIcon = res?.error ? "❌" : ok ? "✅" : "⚠️";
  out.push(
    `\`${req?.at ?? ""}\` · session \`${req?.session ?? "?"}\` · [request.json](./request.json) · [response.json](./response.json)`,
  );

  out.push("## Summary");
  out.push(
    table([
      ["Status", `${statusIcon} ${res?.status ?? "-"}${res?.error ? ` — ${res.error}` : ""}`],
      ["Kind", describeKind(shape.kind, shape.agentId)],
      ["Model", shape.model ? `\`${shape.model}\`` : "-"],
      [
        "Latency",
        `${duration(res?.timing?.durationMs)}${
          res?.timing?.ttfbMs !== undefined ? ` · first byte ${duration(res.timing.ttfbMs)}` : ""
        }`,
      ],
      ["Stop reason", res?.stopReason ? `\`${res.stopReason}\`` : "-"],
      [
        "Transport",
        shape.stream
          ? `SSE stream · ${num(res?.sseEvents)} events · [stream.jsonl](./stream.jsonl)`
          : "single JSON response",
      ],
      [
        "Context sent",
        `${num(messages.length)} messages · ${num(shape.toolCount)} tools · system ${bytes(systemChars(body.system) || shape.systemChars || 0)}`,
      ],
      ["Thinking", shape.thinking ? "enabled" : ""],
      ["Endpoint", `\`${req?.method ?? ""} ${req?.path ?? ""}\``],
    ]),
  );

  out.push("## Token usage");
  out.push(res?.usage ? usageTable(tokens(res.usage)) : usageTable(undefined));

  const answer = res?.body ?? {};
  out.push("## Response");
  if (res?.error) {
    out.push(`> ❌ ${res.error}`);
  }
  if (!ok && answer && typeof answer === "object" && (answer as any).error) {
    out.push(json(answer));
  } else if (Array.isArray((answer as any)?.content)) {
    out.push(renderContent((answer as any).content));
  } else if (answer && Object.keys(answer as object).length > 0) {
    out.push(json(answer));
  } else {
    out.push("_No response body captured._");
  }

  out.push("## Request");

  if (shape.toolResults?.length) {
    out.push("### Fed back into this request");
    out.push(
      shape.toolResults
        .map((t: any) => `- ${t.is_error ? "⚠️" : "•"} \`${t.tool_use_id ?? "?"}\` — ${t.preview ?? ""}`)
        .join("\n"),
    );
  }

  out.push("### Conversation");
  const prev = Math.min(opts.prevMessageCount ?? 0, messages.length);
  if (messages.length === 0) {
    out.push("_No messages in this request._");
  } else {
    if (prev > 0) {
      out.push(
        details(
          `Earlier history — ${prev} message${prev === 1 ? "" : "s"} carried over from the previous request`,
          renderMessages(messages, 0, prev, true),
        ),
      );
      const added = messages.length - prev;
      out.push(
        added > 0
          ? `#### New in this request (${added} message${added === 1 ? "" : "s"})`
          : "#### New in this request\n\n_Nothing new — the conversation was resent unchanged._",
      );
      if (added > 0) out.push(renderMessages(messages, prev, messages.length, false));
    } else {
      out.push(renderMessages(messages, 0, messages.length, false));
    }
  }

  out.push("### System prompt");
  out.push(details(`System prompt · ${bytes(systemChars(body.system))}`, renderSystem(body.system)));

  if (shape.toolNames?.length) {
    out.push("### Tools offered");
    out.push(
      details(
        `${shape.toolNames.length} tools`,
        shape.toolNames.map((n: string) => `\`${n}\``).join(" · "),
      ),
    );
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      out.push(toolDetails(body.tools));
    }
  }

  out.push("### Parameters");
  out.push(
    json({
      model: body.model,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: body.stream,
      thinking: body.thinking,
      tool_choice: body.tool_choice,
      metadata: body.metadata,
    }),
  );

  out.push("### Headers");
  out.push(details("Request headers", json(req?.headers ?? {})));
  if (res?.headers) out.push(details("Response headers", json(res.headers)));

  return out.join("\n\n") + "\n";
}

function describeKind(kind: string | undefined, agentId: string | undefined): string {
  const base =
    kind === "main"
      ? "main agent loop"
      : kind === "aux"
        ? "background call (title / topic / compaction)"
        : kind === "other"
          ? "non-inference call"
          : (kind ?? "-");
  return agentId ? `${base} · subagent \`${agentId}\`` : base;
}

export const renderer: ProviderRenderer = {
  tokens,
  usageTable,
  request: (req, res, opts) => renderRequest(req, res, opts),
};
