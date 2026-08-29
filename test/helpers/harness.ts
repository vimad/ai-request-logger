import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/core/config.ts";
import { createProxyServer } from "../../src/core/server.ts";
import type { Provider } from "../../src/core/types.ts";
import { claude } from "../../src/claude/index.ts";
// The proxy needs *some* upstream to talk to. The Claude mock is the only one
// there is today; a second provider would bring its own and pass it in here.
import { startMockUpstream, type MockOptions, type MockUpstream } from "../claude/upstream.ts";

export interface Harness {
  base: string;
  logDir: string;
  upstream: MockUpstream;
  /** POST a Messages API request through the proxy. */
  send: (body: unknown, headers?: Record<string, string>, path?: string) => Promise<Response>;
  close: () => Promise<void>;
}

/** Proxy + mock upstream + a throwaway log directory, all on ephemeral ports. */
export async function startHarness(
  opts: MockOptions & { provider?: Provider } = {},
): Promise<Harness> {
  const upstream = await startMockUpstream(opts);
  const logDir = mkdtempSync(join(tmpdir(), "arl-test-"));

  const cfg: Config = {
    provider: opts.provider ?? claude,
    port: 0,
    host: "127.0.0.1",
    upstream: new URL(upstream.origin),
    logDir,
    redact: true,
    rawSse: false,
    quiet: true,
  };

  const { server } = createProxyServer(cfg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no address");
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    logDir,
    upstream,
    send: (body, headers = {}, path = "/v1/messages") =>
      fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await upstream.close();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

/* ----------------------------------------------------------- log browsing */

export function dirs(path: string, prefix = ""): string[] {
  return readdirSync(path)
    .filter((n) => n.startsWith(prefix) && statSync(join(path, n)).isDirectory())
    .sort();
}

export function sessionDirs(logDir: string): string[] {
  return dirs(logDir).map((n) => join(logDir, n));
}

/** The session directory whose id contains `idPart`. */
export function sessionDir(logDir: string, idPart: string): string {
  const hit = dirs(logDir).find((n) => n.includes(idPart));
  if (!hit) throw new Error(`no session dir matching ${idPart} in ${readdirSync(logDir).join(", ")}`);
  return join(logDir, hit);
}

export function turnDirs(session: string): string[] {
  return dirs(session, "turn-").map((n) => join(session, n));
}

export function requestDirs(turn: string): string[] {
  return dirs(turn, "req-").map((n) => join(turn, n));
}

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/** The proxy writes its logs after responding, so give them a moment to land. */
export async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Standard Claude Code headers for a request that belongs to `session`. */
export function ccHeaders(session: string, extra: Record<string, string> = {}) {
  return {
    "x-claude-code-session-id": session,
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,context-1m-2025-08-07",
    authorization: "Bearer sk-ant-oat-FAKE-TOKEN",
    "user-agent": "claude-cli/2.0.0 (external, cli)",
    ...extra,
  };
}

export const TOOLS = [
  { name: "Bash", description: "run", input_schema: { type: "object" } },
  { name: "Read", description: "read", input_schema: { type: "object" } },
];
