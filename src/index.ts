#!/usr/bin/env node
import { relative } from "node:path";
import { loadConfig } from "./config.ts";
import { createProxyServer } from "./server.ts";

const cfg = loadConfig(process.argv.slice(2));

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (color ? `\u001b[2m${s}\u001b[0m` : s),
  bold: (s: string) => (color ? `\u001b[1m${s}\u001b[0m` : s),
  cyan: (s: string) => (color ? `\u001b[36m${s}\u001b[0m` : s),
  green: (s: string) => (color ? `\u001b[32m${s}\u001b[0m` : s),
};

const { server } = createProxyServer(cfg, (line) => {
  if (!cfg.quiet) console.log(c.dim(line));
});

server.listen(cfg.port, cfg.host, () => {
  const base = `http://${cfg.host}:${cfg.port}`;
  const rel = relative(process.cwd(), cfg.logDir) || cfg.logDir;

  console.log("");
  console.log(c.bold("  ai-request-logger") + c.dim("  ·  zero-dependency Claude Code proxy"));
  console.log("");
  console.log(`  listening   ${c.cyan(base)}`);
  console.log(`  forwarding  ${c.cyan(cfg.upstream.origin)}`);
  console.log(`  logging to  ${c.cyan(rel + "/")}`);
  console.log("");
  console.log(c.bold("  Point Claude Code at it"));
  console.log(c.dim("  ── one-off, in another terminal ────────────────────────────"));
  console.log(`    ${c.green(`ANTHROPIC_BASE_URL=${base} claude`)}`);
  console.log("");
  console.log(c.dim("  ── for the whole shell session ─────────────────────────────"));
  console.log(`    ${c.green(`export ANTHROPIC_BASE_URL=${base}`)}`);
  console.log(`    ${c.green("claude")}`);
  console.log("");
  console.log(c.dim("  ── persist for one project (.claude/settings.local.json) ───"));
  console.log(
    c.green(`    { "env": { "ANTHROPIC_BASE_URL": "${base}" } }`),
  );
  console.log("");
  console.log(c.dim("  Stop logging: unset ANTHROPIC_BASE_URL (or drop the env block)."));
  console.log(
    c.dim(
      "  Your existing login is untouched - credentials are forwarded verbatim,\n" +
        "  so /login, Pro/Max OAuth, API keys and Bedrock/Vertex all keep working.",
    ),
  );
  console.log("");
  console.log(c.bold("  Log layout"));
  console.log(
    c.dim(
      `    ${rel}/index.md                      start here - every session, linked\n` +
        `    ${rel}/<time>__session-<id>/\n` +
        "      session.md / .json                turns, totals, model time\n" +
        "      turn-001__<what-you-asked>/\n" +
        "        turn.md / .json                 what was asked + every request in it\n" +
        "        user-input.txt                  the prompt that opened the turn\n" +
        "        req-001__main__<model>/\n" +
        "          request.md                    readable view: summary, tokens,\n" +
        "                                        response, and what changed since\n" +
        "                                        the previous request\n" +
        "          request.json / response.json  the raw capture\n" +
        "          stream.jsonl                  one line per SSE event\n" +
        "      turn-000__background/             titles, topic detection, compaction\n" +
        `    ${rel}/index.jsonl                    one line per provider request`,
    ),
  );
  console.log("");
  console.log(c.dim("  Markdown is written as it goes; re-render any time with: npm run report"));
  console.log("");
  console.log(c.dim("  waiting for requests..."));
  console.log("");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${cfg.port} is already in use. Try: npm start -- --port 8788\n`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n  logs written to ${cfg.logDir}`);
    server.close(() => process.exit(0));
    // Long-lived keep-alive sockets would otherwise hold the process open.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
