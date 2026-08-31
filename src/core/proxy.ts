/**
 * The transparent forwarder. It relays bytes in both directions untouched and
 * keeps its own decoded copy for the log. Everything it knows about the payload
 * it asks the configured provider for.
 */
import { Agent as HttpAgent, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { encodeBody } from "./bytes.ts";
import type { Config } from "./config.ts";
import { LogStore, type RequestMeta } from "./logger.ts";
import { SseParser, type SseEvent } from "./sse.ts";
import type { ResponseFacts, StreamFraming } from "./types.ts";
import { since, tryParseJson } from "./util.ts";

/** Cap on the log's own copy of a response body. The relay is never capped. */
const BODY_CAPTURE_LIMIT = 8 * 1024 * 1024;

/**
 * Hop-by-hop headers are meaningful only for a single connection and must not
 * be relayed (RFC 9110 7.6.1). Everything else - including every vendor header
 * and the credential - is forwarded verbatim, because AI clients ship new
 * capabilities as new beta headers and an allowlist would silently disable them.
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
  const provider = cfg.provider;
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
      const parsedBody = headers["content-type"]?.includes("json")
        ? tryParseJson(bodyBuf.toString("utf8"))
        : undefined;

      const shape = provider.describeRequest({
        body: parsedBody,
        bodyBuf,
        headers,
        path: url,
        isInference: provider.isInferenceEndpoint(url),
      });

      const basePath = cfg.upstream.pathname.replace(/\/$/, "");
      const targetPath = basePath + url;

      const meta: RequestMeta = {
        method: req.method ?? "GET",
        path: url,
        url: new URL(targetPath, cfg.upstream).toString(),
        remote: req.socket.remoteAddress ?? "?",
        headers,
        bodyBuf,
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
          // Start the response on the wire now: streaming clients abort a
          // stream that goes quiet, and they count on pings arriving live.
          res.flushHeaders();

          const upHeaders = normalizeHeaders(up.headers);
          const framing: StreamFraming = provider.streamFraming
            ? provider.streamFraming(upHeaders)
            : String(up.headers["content-type"] ?? "").includes("text/event-stream")
              ? "sse"
              : "none";
          const sink = decoderFor(String(up.headers["content-encoding"] ?? ""));
          const parser = new SseParser();
          // SSE is framed on text, so decode incrementally to keep a multi-byte
          // character split across two chunks intact. Every other framing keeps
          // the bytes themselves, because a lossy round trip cannot be undone.
          const decoder = new StringDecoder("utf8");
          const resChunks: Buffer[] = [];
          let captured = 0;
          let ttfb: number | undefined;
          let firstByte = true;

          sink.on("data", (buf: Buffer) => {
            entry.writeRaw(buf);
            if (framing === "sse") {
              entry.writeEvents(parser.push(decoder.write(buf), since(started)));
              return;
            }
            if (captured < BODY_CAPTURE_LIMIT) {
              resChunks.push(buf);
              captured += buf.length;
            }
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
            // A client that disconnects the moment it has what it needs (the
            // Codex CLI does this reliably) makes the *upstream* socket error
            // after the whole reply already arrived. Finish the same way a
            // clean end would, so the capture is not thrown away - just
            // labelled - for what is normal traffic wearing an error shape.
            res.destroy();
            const message = `upstream stream error: ${err.message}`;
            sink.end();
            sink.on("close", () => finish(message));
            if (sink.writableEnded && sink.readableEnded) finish(message);
          });

          let finished = false;
          function finish(errorMessage?: string): void {
            if (finished) return;
            finished = true;
            let events: SseEvent[] = [];
            if (framing === "sse") {
              const tail = decoder.end();
              if (tail) entry.writeEvents(parser.push(tail, since(started)));
              entry.writeEvents(parser.end(since(started)));
              events = parser.events;
            } else if (framing === "binary") {
              try {
                events = provider.decodeStream?.(Buffer.concat(resChunks), upHeaders) ?? [];
              } catch {
                // A truncated or unknown frame must not cost us the capture.
              }
              entry.writeEvents(events);
            }
            const streamed = framing !== "none";
            const message = streamed ? provider.reconstructMessage(events) : undefined;
            const raw = streamed ? undefined : Buffer.concat(resChunks);
            const body = raw && (tryParseJson(raw.toString("utf8")) ?? encodeBody(raw));
            const facts = provider.responseFacts(message, body);
            const durationMs = since(started);
            void entry
              .finish({
                status,
                error: errorMessage,
                headers: up.headers,
                body,
                message,
                eventCount: streamed ? events.length : undefined,
                ttfbMs: ttfb,
                durationMs,
                ...facts,
              })
              .then(() => {
                onLine(
                  summarize(entry.turnIndex, entry.n, meta, status, durationMs, ttfb, facts, cfg),
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

/** Every branch is a Duplex, so the caller can both write and watch it end. */
function decoderFor(encoding: string): Duplex {
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
  facts: ResponseFacts,
  cfg: Config,
): string {
  const shape = meta.shape;
  const t = facts.usage ? cfg.provider.renderer.tokens(facts.usage) : undefined;

  const bits = [
    `[turn ${turn} · req ${n}]`,
    shape?.kind ?? meta.method,
    shape?.model ?? meta.path,
    shape ? `msgs=${shape.messageCount}` : "",
    `-> ${status}`,
    `${Math.round(durationMs)}ms`,
    ttfb !== undefined ? `ttfb=${Math.round(ttfb)}ms` : "",
    t ? `in=${t.input} out=${t.output}` : "",
    t?.cacheRead ? `cached=${t.cacheRead}` : "",
    facts.toolCalls?.length ? `tools=${facts.toolCalls.join(",")}` : "",
  ];
  return bits.filter(Boolean).join(" ");
}
