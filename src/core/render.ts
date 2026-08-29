/**
 * The turn, session and log rollups. These are the same for every provider -
 * a turn is a list of requests with timings and token counts - so the only
 * thing delegated is how to read a usage object and how to print it.
 */
import { bar, block, duration, num } from "./markdown.ts";
import {
  addTokens,
  NO_TOKENS,
  type IndexRow,
  type ProviderRenderer,
  type SessionRecord,
  type TokenBreakdown,
  type TurnRecord,
  type TurnRequestSummary,
} from "./types.ts";

function sum(
  requests: TurnRequestSummary[],
  renderer: ProviderRenderer,
): { tokens: TokenBreakdown; ms: number } {
  let tokens = NO_TOKENS;
  let ms = 0;
  for (const r of requests) {
    tokens = addTokens(tokens, renderer.tokens(r.usage));
    ms += r.durationMs ?? 0;
  }
  return { tokens, ms };
}

/* ------------------------------------------------------------ turn rollup */

export function renderTurn(
  turn: TurnRecord,
  userInput: string,
  renderer: ProviderRenderer,
): string {
  const requests = Array.isArray(turn?.requests) ? turn.requests : [];
  const out: string[] = [];

  out.push(`# Turn ${turn?.turn ?? "?"} — ${turn?.label ?? ""}`);
  out.push(
    `session \`${turn?.session ?? "?"}\` · started \`${turn?.startedAt ?? ""}\` · **${requests.length} provider request${requests.length === 1 ? "" : "s"}**`,
  );

  if (userInput.trim()) {
    out.push("## What was asked");
    out.push(block(userInput.trim()));
  }

  const totals = sum(requests, renderer);
  out.push("## Cost of this turn");
  out.push(renderer.usageTable(totals.tokens));
  out.push(`_Model time across the turn: **${duration(totals.ms)}**._`);

  out.push("## Provider requests");
  const slowest = Math.max(1, ...requests.map((r) => r.durationMs ?? 0));
  out.push(
    [
      "| # | kind | model | status | time | | in | cached | out | stop | tool calls |",
      "|---:|---|---|---|---:|---|---:|---:|---:|---|---|",
      ...requests.map((r) => {
        const t = renderer.tokens(r.usage);
        const link = `[${String(r.n).padStart(3, "0")}](./${r.dir}/request.md)`;
        const kind = r.agentId ? `${r.kind} · sub` : r.kind;
        return `| ${link} | ${kind} | \`${r.model ?? "-"}\` | ${r.error ? "❌" : (r.status ?? "-")} | ${duration(r.durationMs)} | \`${bar(r.durationMs ?? 0, slowest, 10)}\` | ${num(t.input)} | ${num(t.cacheRead)} | ${num(t.output)} | ${r.stopReason ? `\`${r.stopReason}\`` : "-"} | ${(r.toolCalls ?? []).map((x) => `\`${x}\``).join(" ") || "-"} |`;
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

export function renderSession(
  session: SessionRecord,
  turns: Array<{ meta: TurnRecord; dir: string }>,
  renderer: ProviderRenderer,
): string {
  const out: string[] = [];
  out.push(`# Session \`${session?.session ?? "?"}\``);
  out.push(
    `started \`${session?.startedAt ?? ""}\` · updated \`${session?.updatedAt ?? ""}\` · **${session?.turns ?? 0} turns** · **${session?.providerRequests ?? 0} provider requests**`,
  );

  const all = turns.flatMap((t) => t.meta?.requests ?? []);
  const totals = sum(all, renderer);

  out.push("## Totals");
  out.push(renderer.usageTable(totals.tokens));
  out.push(`_Model time across the session: **${duration(totals.ms)}**._`);

  out.push("## Turns");
  const rows = turns
    .slice()
    .sort((a, b) => (a.meta?.turn ?? 0) - (b.meta?.turn ?? 0))
    .map((t) => {
      const reqs = t.meta?.requests ?? [];
      const { tokens, ms } = sum(reqs, renderer);
      const name = t.meta?.turn === 0 ? "background" : (t.meta?.label ?? "");
      return `| [${t.meta?.turn ?? "?"}](./${t.dir}/turn.md) | ${name} | ${reqs.length} | ${duration(ms)} | ${num(tokens.total)} |`;
    });
  out.push(
    [
      "| Turn | what was asked | requests | time | tokens |",
      "|---:|---|---:|---:|---:|",
      ...rows,
    ].join("\n"),
  );

  return out.join("\n\n") + "\n";
}

/* ------------------------------------------------------------- log rollup */

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
