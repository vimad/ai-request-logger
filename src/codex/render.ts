/**
 * Rendering the OpenAI Responses wire format as Codex drives it: `input`
 * items instead of Anthropic `messages`, `response.output` items instead of
 * content blocks, and a token shape with nested `*_details` objects. Every
 * function here is a pure function of the JSON already on disk, so the same
 * code runs live inside the proxy and offline in `report.ts`.
 */
import { block, bytes, details, duration, json, num, table } from "../core/markdown.ts";
import type { ProviderRenderer, RenderRequestOptions, TokenBreakdown } from "../core/types.ts";

/* ------------------------------------------------------------- token math */

export interface Usage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
  [key: string]: unknown;
}

export function tokens(usage: unknown): TokenBreakdown {
  const u = (usage ?? {}) as Usage;
  // `input_tokens` already counts cached tokens; split it into fresh + cached
  // so the rollup adds up the same way Claude's cache split does.
  const totalInput = u.input_tokens ?? 0;
  const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.input_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, totalInput - cacheRead);
  const output = u.output_tokens ?? 0;
  const total = u.total_tokens ?? totalInput + output;
  return { input, output, cacheRead, cacheWrite, total };
}

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

/* --------------------------------------------------------------- items */

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c?.text === "string" ? c.text : typeof c === "string" ? c : JSON.stringify(c)))
    .join("\n");
}

/**
 * One `input` or `output` item. The two arrays share a type vocabulary
 * (`message`, `custom_tool_call[_output]`, `function_call[_output]`,
 * `reasoning`, `additional_tools`), so one renderer serves both sides.
 */
function renderItem(item: any, opts: { compact?: boolean } = {}): string {
  const compact = opts.compact === true;
  switch (item?.type) {
    case "additional_tools": {
      const names = (Array.isArray(item.tools) ? item.tools : [])
        .flatMap((t: any) => (t?.type === "namespace" ? (t.tools ?? []) : [t]))
        .map((t: any) => t?.name)
        .filter(Boolean);
      return `**🧰 Tools declared** — ${names.length}: ${names.map((n: string) => `\`${n}\``).join(" · ")}`;
    }
    case "message": {
      const text = textOfContent(item.content);
      return block(text, "text", compact);
    }
    case "custom_tool_call":
    case "function_call": {
      const input =
        typeof item.input === "string"
          ? item.input
          : typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? item.input ?? {}, null, 2);
      return (
        `**Tool call — \`${item.name ?? "?"}\`** &nbsp;<sub>\`${item.call_id ?? item.id ?? "?"}\`</sub>\n\n` +
        block(input, item.name === "exec" ? "javascript" : "json", compact)
      );
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      const body = textOfContent(item.output) || JSON.stringify(item.output ?? null, null, 2);
      const label = `Tool result &nbsp;<sub>\`${item.call_id ?? "?"}\`</sub> · ${bytes(body.length)}`;
      const rendered = block(body, "text", compact);
      return body.length > 400 ? details(label, rendered) : `**${label}**\n\n${rendered}`;
    }
    case "reasoning":
      // Reasoning content is normally shipped encrypted (`include:
      // ["reasoning.encrypted_content"]`) rather than as readable text; only
      // print what is actually legible.
      return item.encrypted_content
        ? "_[reasoning: encrypted]_"
        : details("Reasoning", block(textOfContent(item.summary ?? item.content), "text", compact));
    default:
      return json(item, compact);
  }
}

function itemIcon(item: any): string {
  if (item?.type === "message") return item.role === "assistant" ? "🤖" : item.role === "developer" ? "⚙️" : "👤";
  if (item?.type === "custom_tool_call" || item?.type === "function_call") return "🔧";
  if (item?.type === "custom_tool_call_output" || item?.type === "function_call_output") return "🔧";
  if (item?.type === "reasoning") return "💭";
  return "•";
}

function itemLabel(item: any): string {
  if (item?.type === "message") return item.role ?? "message";
  return String(item?.type ?? "item");
}

function renderItems(items: any[], from: number, to: number, compact: boolean): string {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    out.push(`##### ${itemIcon(items[i])} ${i + 1}. ${itemLabel(items[i])}`);
    out.push(renderItem(items[i], { compact }));
  }
  return out.join("\n\n");
}

/* ------------------------------------------------------------- the render */

export function renderRequest(req: any, res: any, opts: RenderRequestOptions = {}): string {
  const shape = req?.shape ?? {};
  const body = req?.body ?? {};
  const input: any[] = Array.isArray(body.input) ? body.input : [];
  const output: any[] = Array.isArray(res?.body?.output) ? res.body.output : [];
  const out: string[] = [];

  const title = [`Turn ${req?.turn ?? "?"}`, `Request ${req?.request ?? "?"}`, shape.model ?? req?.method ?? ""]
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
        `${num(input.length)} items · ${num(shape.toolCount)} tools · developer text ${bytes(shape.systemChars ?? 0)}`,
      ],
      ["Reasoning", [shape.reasoningEffort, shape.verbosity && `verbosity ${shape.verbosity}`].filter(Boolean).join(" · ") || "-"],
      ["Endpoint", `\`${req?.method ?? ""} ${req?.path ?? ""}\``],
    ]),
  );

  out.push("## Token usage");
  out.push(res?.usage ? usageTable(tokens(res.usage)) : usageTable(undefined));

  out.push("## Response");
  if (res?.error) out.push(`> ❌ ${res.error}`);
  if (output.length > 0) {
    out.push(renderItems(output, 0, output.length, false));
  } else if (res?.body && Object.keys(res.body).length > 0) {
    out.push(json(res.body));
  } else {
    out.push("_No response body captured._");
  }

  out.push("## Request");

  if (shape.toolResult) {
    out.push("### Fed back into this request");
    out.push(`- \`${shape.toolResult.callId ?? "?"}\` — ${shape.toolResult.preview ?? ""}`);
  }

  out.push("### Input");
  const prev = Math.min(opts.prevMessageCount ?? 0, input.length);
  if (input.length === 0) {
    out.push("_No input items in this request._");
  } else if (prev > 0) {
    out.push(
      details(
        `Earlier history — ${prev} item${prev === 1 ? "" : "s"} carried over from the previous request`,
        renderItems(input, 0, prev, true),
      ),
    );
    const added = input.length - prev;
    out.push(
      added > 0
        ? `#### New in this request (${added} item${added === 1 ? "" : "s"})`
        : "#### New in this request\n\n_Nothing new — the input was resent unchanged._",
    );
    if (added > 0) out.push(renderItems(input, prev, input.length, false));
  } else {
    out.push(renderItems(input, 0, input.length, false));
  }

  out.push("### Parameters");
  out.push(
    json({
      model: body.model,
      stream: body.stream,
      reasoning: body.reasoning,
      text: body.text,
      tool_choice: body.tool_choice,
      parallel_tool_calls: body.parallel_tool_calls,
      store: body.store,
      include: body.include,
      prompt_cache_key: body.prompt_cache_key,
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
        ? "background call (not a user turn)"
        : kind === "other"
          ? "non-inference call"
          : (kind ?? "-");
  return agentId ? `${base} · sub-agent \`${agentId}\`` : base;
}

export const renderer: ProviderRenderer = {
  tokens,
  usageTable,
  request: (req, res, opts) => renderRequest(req, res, opts),
};
