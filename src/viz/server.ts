#!/usr/bin/env node
/**
 * Agent X-Ray: an animated, clickable view of a captured turn.
 *
 *   node src/viz/server.ts [--log-dir log] [--port 8790] [--host 127.0.0.1]
 *
 * Serves a static single-page app from `public/` and a small JSON API that
 * digests the log tree on demand. Read-only: nothing here ever writes to the
 * log directory. It re-reads the tree on every request, so turns captured
 * while it runs show up without a restart.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { digestTurn, listSessions } from "./digest.ts";

const PUBLIC = resolve(import.meta.dirname, "public");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
};

/** The only files `/api/raw` hands out, so it cannot be walked elsewhere. */
const RAW_FILES = new Set(["request.json", "response.json", "stream.jsonl", "request.md"]);

/** One directory name from the log tree: no separators, no `..`. */
function safeName(value: string | null): string | undefined {
  if (!value || value === "." || value === ".." || !/^[\w.:@-]+$/.test(value)) return undefined;
  return value;
}

/** Joins names under root and refuses anything that resolves outside it. */
function inside(root: string, ...names: string[]): string | undefined {
  const target = resolve(root, ...names);
  return target === root || target.startsWith(root + sep) ? target : undefined;
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && body.length > 4096;
  res.writeHead(status, {
    "content-type": TYPES[".json"]!,
    "cache-control": "no-store",
    ...(gzip ? { "content-encoding": "gzip" } : {}),
  });
  res.end(gzip ? gzipSync(body) : body);
}

function sendFile(res: ServerResponse, path: string, type?: string): void {
  res.writeHead(200, {
    "content-type": type ?? TYPES[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(res);
}

export function createVizServer(logDir: string) {
  const root = resolve(logDir);

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/sessions") {
        sendJson(req, res, 200, { logDir: root, sessions: listSessions(root) });
        return;
      }

      if (url.pathname === "/api/turn") {
        const session = safeName(url.searchParams.get("session"));
        const turn = safeName(url.searchParams.get("turn"));
        const dir = session && turn ? inside(root, session, turn) : undefined;
        if (!dir || !existsSync(join(dir, "turn.json"))) {
          sendJson(req, res, 404, { error: "No such turn" });
          return;
        }
        sendJson(req, res, 200, digestTurn(root, session!, turn!));
        return;
      }

      if (url.pathname === "/api/raw") {
        const parts = ["session", "turn", "req"].map((k) => safeName(url.searchParams.get(k)));
        const file = url.searchParams.get("file") ?? "";
        const path = parts.every(Boolean) && RAW_FILES.has(file) ? inside(root, ...(parts as string[]), file) : undefined;
        if (!path || !existsSync(path)) {
          sendJson(req, res, 404, { error: "No such file" });
          return;
        }
        sendFile(res, path, TYPES[extname(path)]);
        return;
      }

      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const path = inside(PUBLIC, rel);
      if (path && existsSync(path) && statSync(path).isFile()) {
        sendFile(res, path);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      sendJson(req, res, 500, { error: (err as Error).message });
    }
  });
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}

if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  const logDir = resolve(flag(argv, "log-dir") ?? process.env.LOGGER_LOG_DIR ?? "log");
  const port = Number(flag(argv, "port") ?? process.env.VIZ_PORT ?? 8790);
  const host = flag(argv, "host") ?? "127.0.0.1";
  const server = createVizServer(logDir);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  Port ${port} is already in use. Try: npm run viz -- --port ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, host, () => {
    console.log("");
    console.log(`  Agent X-Ray  ·  http://${host}:${port}`);
    console.log(`  reading      ${logDir}`);
    console.log("");
    console.log("  Capture a turn with `npm start` + Claude Code, `npm run start:codex` + Codex,");
    console.log("  or `npm run start:cursor` + the Cursor CLI, then pick it in the browser.");
    console.log("");
  });
}
