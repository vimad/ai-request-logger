import { Agent as HttpAgent, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { PassThrough, type Writable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Config } from "./config.ts";
import { LogStore, type RequestMeta } from "./logger.ts";
import { SseParser, reconstructMessage } from "./sse.ts";
import { describeRequest, type AnthropicRequestBody } from "./turns.ts";
import { since, tryParseJson } from "./util.ts";

/**
 * Hop-by-hop headers are meaningful only for a single connection and must not
 * be relayed (RFC 9110 7.6.1). Everything else - including every `anthropic-*`
 * and `x-claude-code-*` header and the credential - is forwarded verbatim,
 * because Claude Code ships new capabilities as new beta headers and an
 * allowlist would silently disable them.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

export interface ProxyDeps {
  cfg: Config;
  store: LogStore;
  onLine: (line: string) => void;
}

export function createHandler({ cfg, store, onLine }: ProxyDeps) {
  const secure = cfg.upstream.protocol === "https:";
  const agent = secure
    ? new HttpsAgent({ keepAlive: true, maxSockets: 64 })
    : new HttpAgent({ keepAlive: true, maxSockets: 64 });

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    req.socket.setNoDelay(true);

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => {});
    req.on("end", () => {
      forward(Buffer.concat(chunks)).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "proxy_error", message: String(err) } }));
      });
    });

    async function forward(bodyBuf: Buffer): Promise<void> {
      const started = process.hrtime.bigint();
      const url = req.url ?? "/";
      const headers = normalizeHeaders(req.headers);
      const isMessages = /\/v1\/messages(?:\?|$)/.test(url);
      const bodyText = bodyBuf.toString("utf8");
      const parsedBody = headers["content-type"]?.includes("json")
        ? tryParseJson(bodyText)
        : undefined;

      const shape =
        parsedBody && typeof parsedBody === "object"
          ? describeRequest(parsedBody as AnthropicRequestBody, headers, isMessages)
          : undefined;

      const basePath = cfg.upstream.pathname.replace(/\/$/, "");
      const targetPath = basePath + url;

      const meta: RequestMeta = {
        method: req.method ?? "GET",
        path: url,
        url: new URL(targetPath, cfg.upstream).toString(),
        remote: req.socket.remoteAddress ?? "?",
        headers,
        bodyText,
        body: parsedBody,
        shape,
      };

      const entry = store.begin(meta);
      await entry.writeRequest();

      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(k)) continue;
        outHeaders[k] = v;
      }
      outHeaders["host"] = cfg.upstream.host;
      if (bodyBuf.length > 0) outHeaders["content-length"] = String(bodyBuf.length);
      else delete outHeaders["content-length"];

      const doRequest = secure ? httpsRequest : httpRequest;
      const upstream = doRequest(
        {
          protocol: cfg.upstream.protocol,
          hostname: cfg.upstream.hostname,
          port: cfg.upstream.port || (secure ? 443 : 80),
          method: req.method,
          path: targetPath,
          headers: outHeaders,
          agent,
        },
        (up) => {
          up.socket.setNoDelay(true);

          const status = up.statusCode ?? 502;
          const resHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(up.headers)) {
            if (v === undefined || HOP_BY_HOP.has(k)) continue;
            resHeaders[k] = v;
          }
          res.writeHead(status, resHeaders);
          // Start the response on the wire now: Claude Code aborts a stream
          // that goes quiet, and it counts on upstream pings arriving live.
          res.flushHeaders();

          const contentType = String(up.headers["content-type"] ?? "");
          const isSse = contentType.includes("text/event-stream");
          const sink = decoderFor(String(up.headers["content-encoding"] ?? ""));
          const parser = new SseParser();
          let textBody = "";
          let ttfb: number | undefined;
          let firstByte = true;

          sink.on("data", (buf: Buffer) => {
            const text = buf.toString("utf8");
            entry.writeRaw(text);
            if (isSse) entry.writeEvents(parser.push(text, since(started)));
            else if (textBody.length < 8 * 1024 * 1024) textBody += text;
          });
          sink.on("error", () => {});

          up.on("data", (chunk: Buffer) => {
            if (firstByte) {
              firstByte = false;
              ttfb = since(started);
            }
            // Relay untouched and unbuffered; the log gets its own copy.
            res.write(chunk);
            sink.write(chunk);
          });

          up.on("end", () => {
            res.end();
            sink.end();
            sink.on("close", finish);
            // A PassThrough with no pending work may have closed already.
            if (sink.writableEnded && sink.readableEnded) finish();
          });

          up.on("error", (err) => {
            res.destroy();
            void entry.finish({ status, error: `upstream stream error: ${err.message}` });
          });

          let finished = false;
          function finish(): void {
            if (finished) return;
            finished = true;
            if (isSse) entry.writeEvents(parser.end(since(started)));
            const message = isSse ? reconstructMessage(parser.events) : undefined;
            const body = isSse ? undefined : (tryParseJson(textBody) ?? textBody);
            const durationMs = since(started);
            void entry
              .finish({
                status,
                headers: up.headers,
                body,
                message,
                eventCount: isSse ? parser.events.length : undefined,
                ttfbMs: ttfb,
                durationMs,
              })
              .then(() => {
                onLine(
                  summarize(entry.turnIndex, entry.n, meta, status, durationMs, ttfb, message, body),
                );
              });
          }
        },
      );

      upstream.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { type: "proxy_error", message: `upstream: ${err.message}` } }),
        );
        void entry.finish({ error: `upstream error: ${err.message}`, durationMs: since(started) });
        onLine(`  !! upstream error on ${meta.path}: ${err.message}`);
      });

      // The agent loop can think for minutes; let the upstream decide when a
      // request is over rather than cutting it short here.
      upstream.setTimeout(0);
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });

      if (bodyBuf.length > 0) upstream.write(bodyBuf);
      upstream.end();
    }
  };
}

function decoderFor(encoding: string): Writable & NodeJS.ReadableStream {
  const enc = encoding.toLowerCase();
  if (enc.includes("br")) return createBrotliDecompress();
  if (enc.includes("gzip")) return createGunzip();
  if (enc.includes("deflate")) return createInflate();
  return new PassThrough();
}

function normalizeHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function summarize(
  turn: number,
  n: number,
  meta: RequestMeta,
  status: number,
  durationMs: number,
  ttfb: number | undefined,
  message: Record<string, unknown> | undefined,
  body: unknown,
): string {
  const shape = meta.shape;
  const usage = (message?.usage ?? (body as any)?.usage) as Record<string, number> | undefined;
  const content = (message?.content ?? (body as any)?.content) as Array<any> | undefined;
  const tools = content
    ?.filter((b) => b?.type === "tool_use")
    .map((b) => b.name)
    .join(",");

  const bits = [
    `[turn ${turn} · req ${n}]`,
    shape?.kind ?? meta.method,
    shape?.model ?? meta.path,
    shape ? `msgs=${shape.messageCount}` : "",
    `-> ${status}`,
    `${Math.round(durationMs)}ms`,
    ttfb !== undefined ? `ttfb=${Math.round(ttfb)}ms` : "",
    usage ? `in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}` : "",
    usage?.cache_read_input_tokens ? `cached=${usage.cache_read_input_tokens}` : "",
    tools ? `tools=${tools}` : "",
  ];
  return bits.filter(Boolean).join(" ");
}
