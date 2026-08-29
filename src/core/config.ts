import { resolve } from "node:path";
import { getProvider } from "../providers.ts";
import type { Provider } from "./types.ts";

export interface Config {
  /** Which provider's wire format the traffic is expected to speak. */
  provider: Provider;
  /** Port the proxy listens on. */
  port: number;
  /** Host/interface the proxy binds to. */
  host: string;
  /** Upstream API origin every request is forwarded to. */
  upstream: URL;
  /** Absolute path of the log directory. */
  logDir: string;
  /** Redact credential headers in the logs. */
  redact: boolean;
  /** Also store the raw (unparsed) SSE stream for every request. */
  rawSse: boolean;
  /** Console verbosity. */
  quiet: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(raw);
}

export function loadConfig(argv: string[]): Config {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else flags.set(arg.slice(2), argv[i + 1]?.startsWith("--") === false ? argv[++i]! : "true");
  }

  const provider = getProvider(flags.get("provider") ?? process.env.LOGGER_PROVIDER);

  // The provider decides where traffic goes by default, so `--provider` alone
  // is enough to point the proxy at a different API.
  const upstream = new URL(
    flags.get("upstream") ?? process.env.LOGGER_UPSTREAM ?? provider.defaultUpstream,
  );

  return {
    provider,
    port: flags.has("port") ? Number.parseInt(flags.get("port")!, 10) : envInt("LOGGER_PORT", 8787),
    host: flags.get("host") ?? process.env.LOGGER_HOST ?? "127.0.0.1",
    upstream,
    logDir: resolve(flags.get("log-dir") ?? process.env.LOGGER_LOG_DIR ?? "log"),
    redact: flags.get("redact") !== "false" && envBool("LOGGER_REDACT", true),
    rawSse: flags.get("raw-sse") === "true" || envBool("LOGGER_RAW_SSE", false),
    quiet: flags.get("quiet") === "true" || envBool("LOGGER_QUIET", false),
  };
}
