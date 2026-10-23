/**
 * Agent X-Ray: an animated, clickable view of a captured turn.
 *
 * Started by `npm start` (src/index.ts) next to the proxies. Serves a static
 * single-page app from `public/` and a small JSON API that digests the log
 * tree on demand. It never writes to the log directory; the one thing it
 * changes there is deleting a whole session on request
 * (`DELETE /api/session`). It re-reads the tree on every request, so turns captured
 * while it runs show up without a restart.
 */
import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { ConnectInfo } from "../core/connect.ts";
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

export interface VizOptions {
  /** The proxies running alongside, for the "connect a harness" panel. */
  connect?: ConnectInfo[];
}

export function createVizServer(logDir: string, opts: VizOptions = {}) {
  const root = resolve(logDir);

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/sessions") {
        sendJson(req, res, 200, { logDir: root, sessions: listSessions(root) });
        return;
      }

      // DELETE only: a cross-origin page cannot send one without a CORS
      // preflight, which this server never answers.
      if (url.pathname === "/api/session") {
        if (req.method !== "DELETE") {
          res.writeHead(405, { allow: "DELETE", "content-type": "text/plain" });
          res.end("Method not allowed");
          return;
        }
        const session = safeName(url.searchParams.get("session"));
        const dir = session ? inside(root, session) : undefined;
        if (!dir || dir === root || !existsSync(join(dir, "session.json"))) {
          sendJson(req, res, 404, { error: "No such session" });
          return;
        }
        rmSync(dir, { recursive: true, force: true });
        sendJson(req, res, 200, { deleted: session });
        return;
      }

      if (url.pathname === "/api/connect") {
        sendJson(req, res, 200, { proxies: opts.connect ?? [] });
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
