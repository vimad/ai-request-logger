/**
 * Turns the JSON a request directory holds into Markdown a human can skim.
 * Everything here is a pure function of already-parsed JSON, so the same code
 * runs live inside the proxy and offline in `report.ts`.
 */

/**
 * Nothing is ever truncated - the prompt bodies are the whole point of the log.
 * Anything past these thresholds goes into a fixed-height box that scrolls
 * instead, so a 200k-token prompt does not bury the rest of the page.
 */
const SCROLL_AFTER_CHARS = 1200;
const SCROLL_AFTER_LINES = 24;
const BOX_HEIGHT = "26em";
const BOX_HEIGHT_COMPACT = "14em";

/* ------------------------------------------------------------------ atoms */

export function num(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "-";
}

export function duration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} chars`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k chars`;
  return `${(n / 1024 / 1024).toFixed(1)}M chars`;
}

/** A fence long enough to survive whatever backticks the content contains. */
function fence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function code(text: string, lang = "text"): string {
  const f = fence(text);
  return `${f}${lang}\n${text}\n${f}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A scrollable, fixed-height <pre>. Raw HTML rather than a fenced block,
 * because no Markdown fence can be given a height - and because the escaping
 * is exact, so content that looks like markup or contains its own backtick
 * runs survives verbatim. `white-space: pre` lets long lines scroll sideways
 * instead of wrapping into soup.
 */
function scrollBox(text: string, height: string): string {
  const lines = text.split("\n").length;
  const caption = `<sub>${num(lines)} line${lines === 1 ? "" : "s"} · ${bytes(text.length)} · scroll inside the box</sub>`;
  return (
    `${caption}\n\n<div style="max-height: ${height}; overflow: auto; border: 1px solid rgba(128,128,128,0.35); border-radius: 6px; padding: 0.5em 0.75em;">\n` +
    `<pre style="margin: 0; white-space: pre;"><code>${escapeHtml(text)}</code></pre>\n</div>`
  );
}

/**
 * Full content, always. Short blocks stay ordinary fenced code so the raw .md
 * file is still pleasant to read; long ones become scroll boxes.
 */
export function block(text: string, lang = "text", compact = false): string {
  const long = text.length > SCROLL_AFTER_CHARS || text.split("\n").length > SCROLL_AFTER_LINES;
  return long ? scrollBox(text, compact ? BOX_HEIGHT_COMPACT : BOX_HEIGHT) : code(text, lang);
}

function json(value: unknown, compact = false): string {
  return block(JSON.stringify(value, null, 2), "json", compact);
}

function details(summary: string, body: string, open = false): string {
  return `<details${open ? " open" : ""}>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function table(rows: Array<[string, string]>): string {
  return [
    "| | |",
    "|---|---|",
    ...rows.filter(([, v]) => v !== "").map(([k, v]) => `| ${k} | ${v} |`),
  ].join("\n");
}

/** A proportional bar, for eyeballing where the time or tokens went. */
export function bar(value: number, max: number, width = 18): string {
  if (!(max > 0)) return "";
  const filled = Math.max(1, Math.round((value / max) * width));
  return "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - filled));
}

/* ------------------------------------------------------------- token math */

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

export function totalTokens(u: Usage | undefined): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

function usageTable(u: Usage | undefined): string {
  if (!u) return "_No usage reported._";
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const fresh = u.input_tokens ?? 0;
  const promptTotal = read + write + fresh;
  const hit = promptTotal > 0 ? Math.round((read / promptTotal) * 100) : 0;

  const rows = [
    ["Input (fresh)", num(fresh)],
    write ? ["Cache write", num(write)] : undefined,
    read ? ["Cache read", `${num(read)}  ·  ${hit}% of prompt`] : undefined,
    ["Output", num(u.output_tokens)],
    ["**Total**", `**${num(totalTokens(u))}**`],
  ].filter(Boolean) as Array<[string, string]>;

  return ["| Tokens | |", "|---|---:|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
}

/* --------------------------------------------------------- content blocks */

function textOfBlock(b: any): string {
  if (typeof b === "string") return b;
  if (typeof b?.text === "string") return b.text;
  return JSON.stringify(b ?? null);
}

function renderContent(content: unknown, opts: { compact?: boolean } = {}): string {
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
  const icon =
    msg.role === "assistant" ? "🤖" : kinds.has("tool_result") ? "🔧" : "👤";
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

export interface RenderRequestOptions {
  /** Messages already present in the previous request of this turn. */
  prevMessageCount?: number;
}

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
  out.push(usageTable(res?.usage));

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
        .map(
          (t: any) =>
            `- ${t.is_error ? "⚠️" : "•"} \`${t.tool_use_id ?? "?"}\` — ${t.preview ?? ""}`,
        )
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

/* ------------------------------------------------------------ turn rollup */

export function renderTurn(turn: any, userInput: string): string {
  const requests: any[] = Array.isArray(turn?.requests) ? turn.requests : [];
  const out: string[] = [];

  out.push(`# Turn ${turn?.turn ?? "?"} — ${turn?.label ?? ""}`);
  out.push(
    `session \`${turn?.session ?? "?"}\` · started \`${turn?.startedAt ?? ""}\` · **${requests.length} provider request${requests.length === 1 ? "" : "s"}**`,
  );

  if (userInput.trim()) {
    out.push("## What was asked");
    out.push(block(userInput.trim()));
  }

  const totals = requests.reduce(
    (acc, r) => {
      const u: Usage = r.usage ?? {};
      acc.input += u.input_tokens ?? 0;
      acc.output += u.output_tokens ?? 0;
      acc.cacheRead += u.cache_read_input_tokens ?? 0;
      acc.cacheWrite += u.cache_creation_input_tokens ?? 0;
      acc.ms += r.durationMs ?? 0;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ms: 0 },
  );

  out.push("## Cost of this turn");
  out.push(
    usageTable({
      input_tokens: totals.input,
      output_tokens: totals.output,
      cache_read_input_tokens: totals.cacheRead,
      cache_creation_input_tokens: totals.cacheWrite,
    }),
  );
  out.push(`_Model time across the turn: **${duration(totals.ms)}**._`);

  out.push("## Provider requests");
  const slowest = Math.max(1, ...requests.map((r) => r.durationMs ?? 0));
  out.push(
    [
      "| # | kind | model | status | time | | in | cached | out | stop | tool calls |",
      "|---:|---|---|---|---:|---|---:|---:|---:|---|---|",
      ...requests.map((r) => {
        const u: Usage = r.usage ?? {};
        const link = `[${String(r.n).padStart(3, "0")}](./${r.dir}/request.md)`;
        const kind = r.agentId ? `${r.kind} · sub` : r.kind;
        return `| ${link} | ${kind} | \`${r.model ?? "-"}\` | ${r.error ? "❌" : (r.status ?? "-")} | ${duration(r.durationMs)} | \`${bar(r.durationMs ?? 0, slowest, 10)}\` | ${num(u.input_tokens)} | ${num(u.cache_read_input_tokens)} | ${num(u.output_tokens)} | ${r.stopReason ? `\`${r.stopReason}\`` : "-"} | ${(r.toolCalls ?? []).map((t: string) => `\`${t}\``).join(" ") || "-"} |`;
      }),
    ].join("\n"),
  );

  out.push("## How the turn unfolded");
  out.push(
    requests
      .map((r) => {
        const tools = (r.toolCalls ?? []).join(", ");
        const what = r.error
          ? `failed — ${r.error}`
          : tools
            ? `called ${tools}`
            : r.stopReason === "end_turn"
              ? r.kind === "main"
                ? "answered the user"
                : "returned its result"
              : `stopped on \`${r.stopReason ?? "?"}\``;
        const msgs = `${r.messageCount} message${r.messageCount === 1 ? "" : "s"} in`;
        return `${r.n}. **${r.kind}**${r.agentId ? " (subagent)" : ""} · ${msgs} · ${duration(r.durationMs)} → ${what}`;
      })
      .join("\n"),
  );

  out.push(`\n[← session overview](../session.md)`);
  return out.join("\n\n") + "\n";
}

/* --------------------------------------------------------- session rollup */

export function renderSession(session: any, turns: Array<{ meta: any; dir: string }>): string {
  const out: string[] = [];
  out.push(`# Session \`${session?.session ?? "?"}\``);
  out.push(
    `started \`${session?.startedAt ?? ""}\` · updated \`${session?.updatedAt ?? ""}\` · **${session?.turns ?? 0} turns** · **${session?.providerRequests ?? 0} provider requests**`,
  );

  let gi = 0,
    go = 0,
    gc = 0,
    gms = 0;
  for (const t of turns) {
    for (const r of t.meta?.requests ?? []) {
      const u: Usage = r.usage ?? {};
      gi += u.input_tokens ?? 0;
      go += u.output_tokens ?? 0;
      gc += u.cache_read_input_tokens ?? 0;
      gms += r.durationMs ?? 0;
    }
  }

  out.push("## Totals");
  out.push(
    usageTable({ input_tokens: gi, output_tokens: go, cache_read_input_tokens: gc }),
  );
  out.push(`_Model time across the session: **${duration(gms)}**._`);

  out.push("## Turns");
  const rows = turns
    .slice()
    .sort((a, b) => (a.meta?.turn ?? 0) - (b.meta?.turn ?? 0))
    .map((t) => {
      const reqs: any[] = t.meta?.requests ?? [];
      const tok = reqs.reduce((n, r) => n + totalTokens(r.usage), 0);
      const ms = reqs.reduce((n, r) => n + (r.durationMs ?? 0), 0);
      const dir = t.dir;
      const name = t.meta?.turn === 0 ? "background" : (t.meta?.label ?? "");
      return `| [${t.meta?.turn ?? "?"}](./${dir}/turn.md) | ${name} | ${reqs.length} | ${duration(ms)} | ${num(tok)} |`;
    });
  out.push(
    ["| Turn | what was asked | requests | time | tokens |", "|---:|---|---:|---:|---:|", ...rows].join(
      "\n",
    ),
  );

  return out.join("\n\n") + "\n";
}

/* ------------------------------------------------------------ log rollup */

export interface IndexRow {
  dir: string;
  turns: number;
  requests: number;
  ms: number;
  tokens: number;
}

/** The `log/index.md` landing page listing every captured session. */
export function renderIndex(rows: IndexRow[], logDir: string): string {
  const body = rows
    .slice()
    .sort((a, b) => b.dir.localeCompare(a.dir))
    .map(
      (r) =>
        `| [${r.dir}](./${r.dir}/session.md) | ${r.turns} | ${r.requests} | ${duration(r.ms)} | ${num(r.tokens)} |`,
    );

  return (
    [
      "# Captured sessions",
      "",
      `_${rows.length} session${rows.length === 1 ? "" : "s"} in \`${logDir}\`._`,
      "",
      "| Session | turns | requests | model time | tokens |",
      "|---|---:|---:|---:|---:|",
      ...body,
    ].join("\n") + "\n"
  );
}
