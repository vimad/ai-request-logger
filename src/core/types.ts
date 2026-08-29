/**
 * The contract between the generic proxy and a provider.
 *
 * Everything in `src/core` is provider-agnostic: it forwards bytes, parses SSE
 * frames, and lays out a session/turn/request tree on disk. It knows nothing
 * about Anthropic, OpenAI or anyone else. A provider supplies the four things
 * that *are* wire-specific: which endpoints carry inference, how to read a
 * request body, how to rebuild a streamed reply, and how to render it.
 */
import type { SseEvent } from "./sse.ts";

/**
 * `main`  - the agent loop that answers the user (carries the tool set).
 * `aux`   - the client's background calls: conversation titles, topic
 *           detection, quota probes, compaction summaries. These must never
 *           open a new turn.
 * `other` - anything that is not an inference call (token counting, etc).
 */
export type RequestKind = "main" | "aux" | "other";

/**
 * What the core needs to know about one request to file it in the log tree.
 * Anything beyond this is provider trivia and travels in `detail`, which is
 * merged into `request.json` verbatim and handed back to the provider's
 * renderer untouched.
 */
export interface RequestShape {
  sessionId: string;
  /** Set on requests issued by a subagent, when the provider can tell. */
  agentId?: string;
  parentAgentId?: string;
  kind: RequestKind;
  /** Stable identity of the user input that started the current turn. */
  turnKey: string;
  /** Short human label for the turn, taken from the user's own words. */
  turnLabel: string;
  model?: string;
  stream: boolean;
  messageCount: number;
  /** Text of the user message that opened the turn. */
  userText: string;
  /** Provider-specific extras, logged as-is alongside the fields above. */
  detail?: Record<string, unknown>;
}

/** The handful of response facts the core reports on and rolls up. */
export interface ResponseFacts {
  usage?: unknown;
  stopReason?: string;
  toolCalls?: string[];
}

/** Provider-neutral token counts, so rollups can add up across providers. */
export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export const NO_TOKENS: TokenBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

export interface RenderRequestOptions {
  /** Messages already present in the previous request of this turn. */
  prevMessageCount?: number;
}

export interface ProviderRenderer {
  /** Normalise a provider usage object into counts the core can sum. */
  tokens(usage: unknown): TokenBreakdown;
  /** The token table shown in request.md, turn.md and session.md. */
  usageTable(t: TokenBreakdown | undefined): string;
  /** The whole of `request.md`, from the two JSON files beside it. */
  request(req: unknown, res: unknown, opts: RenderRequestOptions): string;
}

export interface DescribeInput {
  /** Parsed JSON, or undefined when the body did not claim to be JSON. */
  body: unknown;
  /** The request body verbatim, for providers speaking a binary wire format. */
  bodyBuf: Buffer;
  headers: Record<string, string>;
  path: string;
  /** Result of this provider's own `isInferenceEndpoint(path)`. */
  isInference: boolean;
}

/**
 * How the core should turn a streamed response body into events.
 *
 * `sse`    - blank-line framed `text/event-stream` (the default).
 * `binary` - some other framing; the core buffers its decoded copy and hands
 *            the whole body to `decodeStream` once the response completes.
 *            The relay to the client stays unbuffered either way.
 * `none`   - not a stream; parse the body as JSON/text.
 */
export type StreamFraming = "sse" | "binary" | "none";

export interface Provider {
  /** Stable id; recorded in every log file so reports can re-render offline. */
  id: string;
  /** Human label for the banner. */
  label: string;
  /** Upstream origin used when nothing is configured. */
  defaultUpstream: string;
  /** Client-side env var that points the tool at this proxy, for the banner. */
  baseUrlEnvVar: string;
  /** The command the user runs to start this client, for the banner. */
  clientCommand: string;
  /** True for paths that carry a prompt worth structuring (vs. plumbing). */
  isInferenceEndpoint(path: string): boolean;
  /** Read a request body into a shape, or undefined if it is not describable. */
  describeRequest(input: DescribeInput): RequestShape | undefined;
  /**
   * How to frame this response body into events. Defaults to `sse` when the
   * content-type says `text/event-stream` and `none` otherwise, which is what
   * a provider that only speaks JSON + SSE wants.
   */
  streamFraming?(headers: Record<string, string>): StreamFraming;
  /** Frame a `binary` response body into events. Required with that framing. */
  decodeStream?(body: Buffer, headers: Record<string, string>): SseEvent[];
  /** Rebuild the final message object from a stream of SSE events. */
  reconstructMessage(events: SseEvent[]): Record<string, unknown> | undefined;
  /** Pull usage, stop reason and tool calls out of a reply. */
  responseFacts(
    message: Record<string, unknown> | undefined,
    body: unknown,
  ): ResponseFacts;
  renderer: ProviderRenderer;
}

/* ------------------------------------------------- what lands on disk */

/** One provider request, as summarised inside `turn.json`. */
export interface TurnRequestSummary {
  n: number;
  dir: string;
  kind: string;
  model?: string;
  agentId?: string;
  status?: number;
  stopReason?: string;
  durationMs?: number;
  ttfbMs?: number;
  messageCount: number;
  toolCalls?: string[];
  usage?: unknown;
  error?: string;
}

/** `turn.json`, as the renderers read it back. */
export interface TurnRecord {
  turn?: number;
  session?: string;
  label?: string;
  startedAt?: string;
  requests?: TurnRequestSummary[];
}

/** `session.json`, as the renderers read it back. */
export interface SessionRecord {
  session?: string;
  provider?: string;
  startedAt?: string;
  updatedAt?: string;
  turns?: number;
  providerRequests?: number;
}

/** One row of the `log/index.md` landing page. */
export interface IndexRow {
  dir: string;
  turns: number;
  requests: number;
  ms: number;
  tokens: number;
}
