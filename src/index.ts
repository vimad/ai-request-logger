#!/usr/bin/env node
import { relative } from "node:path";
import { loadConfig } from "./core/config.ts";
import { createProxyServer } from "./core/server.ts";
import { providers } from "./providers.ts";

const cfg = loadConfig(process.argv.slice(2));
const provider = cfg.provider;

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
  const envVar = provider.baseUrlEnvVar;
  const client = provider.clientCommand;
  const notes = provider.banner ?? {};
  const others = providers.map((p) => p.id).filter((id) => id !== provider.id);

  console.log("");
  console.log(c.bold("  ai-request-logger") + c.dim("  ·  zero-dependency AI provider proxy"));
  console.log("");
  console.log(`  provider    ${c.cyan(provider.id)} ${c.dim(`(${provider.label})`)}`);
  console.log(`  listening   ${c.cyan(base)}`);
  console.log(`  forwarding  ${c.cyan(cfg.upstream.origin)}`);
  console.log(`  logging to  ${c.cyan(rel + "/")}`);
  if (others.length > 0) {
    console.log(c.dim(`  others      ${others.join(", ")}   (--provider <id>)`));
  }
  console.log("");
  if (notes.setup) {
    console.log(c.bold("  Before you start"));
    console.log(c.dim(`  ${notes.setup}`));
    console.log("");
  }
  console.log(c.bold("  Point your client at it"));
  if (notes.invocation) {
    console.log(c.dim("  ── every invocation, since there is no env var override ────"));
    console.log(`    ${c.green(notes.invocation(base))}`);
  } else {
    console.log(c.dim("  ── one-off, in another terminal ────────────────────────────"));
    console.log(`    ${c.green(`${envVar}=${base} ${client}`)}`);
    console.log("");
    console.log(c.dim("  ── for the whole shell session ─────────────────────────────"));
    console.log(`    ${c.green(`export ${envVar}=${base}`)}`);
    console.log(`    ${c.green(client)}`);
  }
  if (notes.projectConfig) {
    console.log("");
    console.log(c.dim(`  ── persist for one project (${notes.projectConfig}) ───`));
    console.log(c.green(`    { "env": { "${envVar}": "${base}" } }`));
  }
  console.log("");
  console.log(
    c.dim(
      notes.invocation
        ? "  Stop logging: stop passing the overrides above."
        : `  Stop logging: unset ${envVar} (or drop the env block).`,
    ),
  );
  if (notes.credentials) console.log(c.dim(`  ${notes.credentials}`));
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
        `      turn-000__background/             ${notes.backgroundTurn ?? "calls with no turn of their own"}\n` +
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
