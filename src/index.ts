#!/usr/bin/env node
/**
 * `npm start`: one proxy per provider, all logging into one tree, plus Agent
 * X-Ray reading that tree. Each provider gets a fixed port (base + its place
 * in the registry), so its client command never changes between runs.
 *
 *   --provider claude,codex   run only these proxies (default: all)
 *   --port 8787               base port: claude 8787, cursor 8788, codex 8789
 *   --viz-port 8790           Agent X-Ray
 *   --upstream <url>          only with a single --provider
 */
import { relative } from "node:path";
import { loadConfig, type Config } from "./core/config.ts";
import { connectInfo, type ConnectInfo } from "./core/connect.ts";
import { SharedIndex } from "./core/logger.ts";
import { createProxyServer } from "./core/server.ts";
import { getProvider, providers } from "./providers.ts";
import { createVizServer } from "./viz/server.ts";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
const c = { dim: paint("2"), bold: paint("1"), cyan: paint("36"), green: paint("32"), yellow: paint("33") };
const tint: Record<string, (s: string) => string> = { claude: paint("33"), cursor: paint("35"), codex: paint("34") };

/** Pulls `--name value` / `--name=value` out of argv, returning the rest. */
function take(argv: string[], name: string): [string | undefined, string[]] {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) value = argv[++i];
    else if (a.startsWith(`--${name}=`)) value = a.slice(name.length + 3);
    else rest.push(a);
  }
  return [value, rest];
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

let [only, argv] = take(process.argv.slice(2), "provider");
let vizPortFlag: string | undefined;
[vizPortFlag, argv] = take(argv, "viz-port");

let chosen = providers;
try {
  const ids = (only ?? process.env.LOGGER_PROVIDER)?.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids?.length) chosen = ids.map((id) => getProvider(id));
} catch (err) {
  fail((err as Error).message);
}
if (chosen.length > 1 && (argv.some((a) => a.startsWith("--upstream")) || process.env.LOGGER_UPSTREAM)) {
  fail("--upstream / LOGGER_UPSTREAM needs a single --provider: each provider has its own upstream.");
}

const base = loadConfig(argv);
const vizPort = Number(vizPortFlag ?? process.env.VIZ_PORT ?? 8790);
const index = new SharedIndex();

const configs: Config[] = chosen.map((p) =>
  loadConfig([...argv, "--provider", p.id, "--port", String(base.port + providers.indexOf(p))]),
);
const width = Math.max(...configs.map((cfg) => cfg.provider.id.length));
const connect: ConnectInfo[] = configs.map((cfg) =>
  connectInfo(cfg.provider, `http://${cfg.host}:${cfg.port}`, cfg.upstream.origin + cfg.upstream.pathname.replace(/\/$/, "")),
);

function listen(server: import("node:http").Server, port: number, what: string): Promise<void> {
  return new Promise((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        fail(`Port ${port} (${what}) is already in use. Try: npm start -- --port <base> --viz-port <port>`);
      }
      throw err;
    });
    server.listen(port, base.host, () => resolve());
  });
}

const servers = configs.map((cfg) => {
  const label = (tint[cfg.provider.id] ?? c.cyan)(cfg.provider.id.padEnd(width));
  const { server } = createProxyServer(
    cfg,
    (line) => {
      if (!cfg.quiet) console.log(`${label} ${c.dim(line.trimStart())}`);
    },
    index,
  );
  return server;
});
const viz = createVizServer(base.logDir, { connect });

await Promise.all([
  ...servers.map((server, i) => listen(server, configs[i]!.port, configs[i]!.provider.id)),
  listen(viz, vizPort, "Agent X-Ray"),
]);

const rel = relative(process.cwd(), base.logDir) || base.logDir;
const vizUrl = `http://${base.host}:${vizPort}`;

console.log("");
console.log(c.bold("  ai-request-logger") + c.dim("  ·  zero-dependency AI provider proxy"));
console.log("");
console.log(`  ${c.bold("Agent X-Ray")}  ${c.cyan(vizUrl)}   ${c.dim("open it: setup for every client is on the home page")}`);
console.log(`  ${"logging to".padEnd(11)}  ${c.cyan(rel + "/")}   ${c.dim("start at index.md; re-render with npm run report")}`);
console.log("");
for (const info of connect) {
  console.log(`  ${(tint[info.id] ?? c.cyan)(info.id.padEnd(width))}  ${c.cyan(info.base)}  ${c.dim(`→ ${info.upstream}`)}`);
}
console.log("");
console.log(c.bold("  Point your client at it"));
for (const info of connect) {
  console.log("");
  console.log(`  ${(tint[info.id] ?? c.cyan)(info.id)} ${c.dim(`(${info.label})`)}`);
  if (info.setup) console.log(c.yellow(`    first: ${info.setup}`));
  const step = info.steps[0]!;
  console.log(c.green(step.command.replace(/^/gm, "    ")));
}
console.log("");
console.log(c.dim("  waiting for requests..."));
console.log("");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n  logs written to ${base.logDir}`);
    let open = servers.length + 1;
    for (const server of [...servers, viz]) server.close(() => --open || process.exit(0));
    // Long-lived keep-alive sockets would otherwise hold the process open.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
