/**
 * Markdown atoms shared by every provider's renderer.
 *
 * Nothing here knows what a message or a token is - these are the primitives
 * (code fences, scroll boxes, tables, bars) that provider renderers compose.
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

export function json(value: unknown, compact = false): string {
  return block(JSON.stringify(value, null, 2), "json", compact);
}

export function details(summary: string, body: string, open = false): string {
  return `<details${open ? " open" : ""}>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

export function table(rows: Array<[string, string]>): string {
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
