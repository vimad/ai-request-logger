/**
 * The log tree: sessions contain turns, turns contain provider requests.
 *
 * This layout is provider-agnostic. The only provider-shaped things that reach
 * disk are the contents of `RequestShape.detail` (merged into `request.json`)
 * and the Markdown, which the provider's renderer produces.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { Config } from "./config.ts";
import { renderIndex, renderSession, renderTurn } from "./render.ts";
import type { SseEvent } from "./sse.ts";
import type { RequestShape, ResponseFacts, TurnRequestSummary } from "./types.ts";
import { jsonStringify, nowIso, pad, sha1, slug, stamp } from "./util.ts";

const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

/** Requests that carry no turn of their own land in this bucket. */
const BACKGROUND_TURN = 0;

/** Traffic the provider could not describe still gets captured, under here. */
const UNSTRUCTURED_SESSION = "non-messages-traffic";

interface TurnState {
  index: number;
  key: string;
  label: string;
  dir: string;
  startedAt: string;
  requestCount: number;
  requests: TurnRequestSummary[];
  /** Messages the previous main-thread request carried, for the diff view. */
  prevMessageCount: number;
  userInput: string;
}

interface SessionState {
  id: string;
  dir: string;
  startedAt: string;
  turnCount: number;
  requestCount: number;
  current?: TurnState;
  turns: TurnState[];
}

export interface RequestMeta {
  method: string;
  path: string;
  url: string;
  remote: string;
  headers: Record<string, string>;
  bodyText: string;
  body: unknown;
  shape?: RequestShape;
}

export class LogStore {
  #cfg: Config;
  #sessions = new Map<string, SessionState>();

  constructor(cfg: Config) {
    this.#cfg = cfg;
    mkdirSync(cfg.logDir, { recursive: true });
  }

  get logDir(): string {
    return this.#cfg.logDir;
  }

  /** Open a log entry for one provider request. Never throws. */
  begin(meta: RequestMeta): RequestLog {
    const shape = meta.shape;
    const session = this.#session(shape ? shape.sessionId : UNSTRUCTURED_SESSION);
    const turn = shape ? this.#turn(session, shape) : this.#backgroundTurn(session);

    turn.requestCount += 1;
    session.requestCount += 1;
    const n = turn.requestCount;

    const parts = [`req-${pad(n)}`, shape ? shape.kind : "raw"];
    if (shape?.agentId) {
      parts.push(`agent-${slug(shape.agentId).replace(/^agent-/, "").slice(0, 12)}`);
    }
    if (shape?.model) parts.push(slug(shape.model, 30));
    const dir = join(turn.dir, parts.join("__"));
    mkdirSync(dir, { recursive: true });

    // Snapshot the anchor before this request moves it: subagent calls run
    // concurrently with the main thread and carry a conversation of their own.
    const prevMessageCount = turn.prevMessageCount;
    if (shape && shape.kind === "main" && !shape.agentId) {
      turn.prevMessageCount = shape.messageCount;
    }

    return new RequestLog(this, this.#cfg, session, turn, n, dir, meta, prevMessageCount);
  }

  #session(id: string): SessionState {
    const existing = this.#sessions.get(id);
    if (existing) return existing;
    const dir = join(this.#cfg.logDir, `${stamp()}__session-${slug(id, 40)}`);
    mkdirSync(dir, { recursive: true });
    const session: SessionState = {
      id,
      dir,
      startedAt: nowIso(),
      turnCount: 0,
      requestCount: 0,
      turns: [],
    };
    this.#sessions.set(id, session);
    return session;
  }

  #turn(session: SessionState, shape: RequestShape): TurnState {
    // Only the main agent loop opens turns. Background calls (titles, topic
    // detection, compaction) and subagent calls belong to the turn already
    // in flight, so they never reset the boundary.
    if (shape.kind !== "main" || shape.agentId) {
      return session.current ?? this.#backgroundTurn(session);
    }
    if (session.current && session.current.key === shape.turnKey) return session.current;

    session.turnCount += 1;
    const index = session.turnCount;
    const turn: TurnState = {
      index,
      key: shape.turnKey,
      label: shape.turnLabel,
      dir: join(session.dir, `turn-${pad(index)}__${slug(shape.turnLabel, 40)}`),
      startedAt: nowIso(),
      requestCount: 0,
      requests: [],
      prevMessageCount: 0,
      userInput: shape.userText,
    };
    mkdirSync(turn.dir, { recursive: true });
    session.current = turn;
    session.turns.push(turn);
    void writeFile(join(turn.dir, "user-input.txt"), shape.userText + "\n").catch(() => {});
    return turn;
  }

  #backgroundTurn(session: SessionState): TurnState {
    const existing = session.turns.find((t) => t.index === BACKGROUND_TURN);
    if (existing) return existing;
    const turn: TurnState = {
      index: BACKGROUND_TURN,
      key: "background",
      label: "background",
      dir: join(session.dir, "turn-000__background"),
      startedAt: nowIso(),
      requestCount: 0,
      requests: [],
      prevMessageCount: 0,
      userInput: "",
    };
    mkdirSync(turn.dir, { recursive: true });
    session.turns.push(turn);
    return turn;
  }

  async flush(session: SessionState, turn: TurnState): Promise<void> {
    await Promise.all([
      writeFile(
        join(turn.dir, "turn.json"),
        jsonStringify({
          turn: turn.index,
          session: session.id,
          label: turn.label,
          startedAt: turn.startedAt,
          updatedAt: nowIso(),
          providerRequests: turn.requestCount,
          requests: turn.requests,
        }),
      ),
      writeFile(
        join(session.dir, "session.json"),
        jsonStringify({
          session: session.id,
          provider: this.#cfg.provider.id,
          startedAt: session.startedAt,
          updatedAt: nowIso(),
          turns: session.turnCount,
          providerRequests: session.requestCount,
          index: session.turns.map((t) => ({
            turn: t.index,
            label: t.label,
            dir: relative(session.dir, t.dir),
            providerRequests: t.requestCount,
          })),
        }),
      ),
    ]).catch(() => {});

    const { renderer } = this.#cfg.provider;
    try {
      await writeFile(
        join(turn.dir, "turn.md"),
        renderTurn(
          {
            turn: turn.index,
            session: session.id,
            label: turn.label,
            startedAt: turn.startedAt,
            requests: turn.requests,
          },
          turn.userInput,
          renderer,
        ),
      );
      await writeFile(
        join(session.dir, "session.md"),
        renderSession(
          {
            session: session.id,
            provider: this.#cfg.provider.id,
            startedAt: session.startedAt,
            updatedAt: nowIso(),
            turns: session.turnCount,
            providerRequests: session.requestCount,
          },
          session.turns.map((t) => ({
            meta: { turn: t.index, label: t.label, requests: t.requests },
            dir: relative(session.dir, t.dir),
          })),
          renderer,
        ),
      );
      await writeFile(join(this.#cfg.logDir, "index.md"), this.#renderIndex());
    } catch {
      // The JSON is the source of truth; Markdown is a convenience.
    }
  }

  #renderIndex(): string {
    const { renderer } = this.#cfg.provider;
    const rows = [...this.#sessions.values()].map((s) => {
      const reqs = s.turns.flatMap((t) => t.requests);
      return {
        dir: basename(s.dir),
        turns: s.turnCount,
        requests: s.requestCount,
        ms: reqs.reduce((n, r) => n + (r.durationMs ?? 0), 0),
        tokens: reqs.reduce((n, r) => n + renderer.tokens(r.usage).total, 0),
      };
    });
    return renderIndex(rows, this.#cfg.logDir);
  }

  async appendIndex(line: unknown): Promise<void> {
    await appendFile(join(this.#cfg.logDir, "index.jsonl"), JSON.stringify(line) + "\n").catch(
      () => {},
    );
  }
}

export function redactHeaders(
  headers: Record<string, string>,
  redact: boolean,
): Record<string, string> {
  if (!redact) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase())
      ? `<redacted len=${v.length} sha1=${sha1(v).slice(0, 8)}>`
      : v;
  }
  return out;
}

export interface FinishResult extends ResponseFacts {
  status?: number;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  message?: Record<string, unknown>;
  eventCount?: number;
  ttfbMs?: number;
  durationMs?: number;
  error?: string;
}

/** One provider request/response pair on disk. */
export class RequestLog {
  #store: LogStore;
  #cfg: Config;
  #session: SessionState;
  #turn: TurnState;
  #meta: RequestMeta;
  #stream?: WriteStream;
  #raw?: WriteStream;
  #prevMessageCount: number;
  #requestPayload: unknown;
  readonly n: number;
  readonly dir: string;
  readonly startedAt = nowIso();

  constructor(
    store: LogStore,
    cfg: Config,
    session: SessionState,
    turn: TurnState,
    n: number,
    dir: string,
    meta: RequestMeta,
    prevMessageCount: number,
  ) {
    this.#prevMessageCount = prevMessageCount;
    this.#store = store;
    this.#cfg = cfg;
    this.#session = session;
    this.#turn = turn;
    this.#meta = meta;
    this.n = n;
    this.dir = dir;
  }

  get turnIndex(): number {
    return this.#turn.index;
  }

  get sessionId(): string {
    return this.#session.id;
  }

  async writeRequest(): Promise<void> {
    const { shape, headers, body, bodyText, method, path, url, remote } = this.#meta;
    this.#requestPayload = {
      at: this.startedAt,
      provider: this.#cfg.provider.id,
      session: this.#session.id,
      turn: this.#turn.index,
      request: this.n,
      method,
      path,
      upstream: url,
      client: remote,
      // Core fields first, then whatever the provider added, flattened so the
      // renderer sees one object rather than having to reach into `detail`.
      shape: shape && {
        kind: shape.kind,
        model: shape.model,
        stream: shape.stream,
        agentId: shape.agentId,
        parentAgentId: shape.parentAgentId,
        messageCount: shape.messageCount,
        ...(shape.detail ?? {}),
      },
      headers: redactHeaders(headers, this.#cfg.redact),
      body: body ?? bodyText,
    };
    await writeFile(join(this.dir, "request.json"), jsonStringify(this.#requestPayload)).catch(
      () => {},
    );
  }

  streamWriter(): WriteStream {
    this.#stream ??= createWriteStream(join(this.dir, "stream.jsonl"), { flags: "a" });
    return this.#stream;
  }

  writeEvents(events: SseEvent[]): void {
    if (events.length === 0) return;
    const w = this.streamWriter();
    for (const e of events) w.write(JSON.stringify(e) + "\n");
  }

  writeRaw(chunk: string): void {
    if (!this.#cfg.rawSse) return;
    this.#raw ??= createWriteStream(join(this.dir, "stream.raw.txt"), { flags: "a" });
    this.#raw.write(chunk);
  }

  async finish(result: FinishResult): Promise<void> {
    this.#stream?.end();
    this.#raw?.end();

    const responsePayload = {
      at: nowIso(),
      status: result.status,
      error: result.error,
      timing: { ttfbMs: result.ttfbMs, durationMs: result.durationMs },
      sseEvents: result.eventCount,
      headers: result.headers && redactHeaders(flatten(result.headers), this.#cfg.redact),
      usage: result.usage,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      // For streamed replies this is rebuilt from the SSE events, so it has
      // the same shape a non-streaming response would have had.
      body: result.body ?? result.message,
    };
    await writeFile(join(this.dir, "response.json"), jsonStringify(responsePayload)).catch(() => {});

    // The human-readable view, written alongside the raw JSON.
    try {
      await writeFile(
        join(this.dir, "request.md"),
        this.#cfg.provider.renderer.request(this.#requestPayload, responsePayload, {
          prevMessageCount: this.#prevMessageCount,
        }),
      );
    } catch {
      // Rendering must never cost us the raw capture.
    }

    const summary: TurnRequestSummary = {
      n: this.n,
      dir: relative(this.#turn.dir, this.dir),
      kind: this.#meta.shape?.kind ?? "raw",
      model: this.#meta.shape?.model,
      agentId: this.#meta.shape?.agentId,
      status: result.status,
      stopReason: result.stopReason,
      durationMs: result.durationMs,
      ttfbMs: result.ttfbMs,
      messageCount: this.#meta.shape?.messageCount ?? 0,
      toolCalls: result.toolCalls,
      usage: result.usage,
      error: result.error,
    };
    this.#turn.requests.push(summary);

    await this.#store.flush(this.#session, this.#turn);
    await this.#store.appendIndex({
      at: this.startedAt,
      provider: this.#cfg.provider.id,
      session: this.#session.id,
      turn: this.#turn.index,
      request: this.n,
      path: this.#meta.path,
      ...summary,
      dir: relative(this.#store.logDir, this.dir),
    });
  }
}

function flatten(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
