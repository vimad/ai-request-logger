/**
 * Turns one captured Claude Code turn into the model the visualizer draws.
 *
 * The central trick is a content-addressed blob store: every system block,
 * tool definition and message content block is hashed (after dropping the
 * fields that change between re-sends, like `cache_control`) and stored once.
 * Requests then hold references. Two requests that reference the same blob
 * sent the same bytes twice - which is exactly the point the visualizer is
 * built to make: the model is stateless, so every request carries everything.
 *
 * Reads only what is on disk. Claude-specific by design; a second provider
 * would get its own digest behind the same `VizTurn` shape.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tokens as claudeTokens } from "../claude/render.ts";
import { blocksOf, type ContentBlock } from "../claude/turns.ts";
import type { TokenBreakdown } from "../core/types.ts";
import { sha1 } from "../core/util.ts";

/* ------------------------------------------------------------------ shape */

/**
 * What a piece of context *is*, from the point of view of someone learning how
 * an agent works. Colour in the UI is keyed on this.
 */
export type Category =
  | "system" //       the system prompt
  | "tools" //        a tool definition
  | "prompt" //       what the human typed
  | "reminder" //     text the harness injected: <system-reminder>, role:system
  | "synthetic" //    a whole prompt the harness wrote to itself
  | "assistant" //    model text
  | "thinking" //     model reasoning
  | "tool_use" //     model asking for a tool
  | "tool_result" //  what the tool printed, handed back
  | "media" //        image / document
  | "other";

export interface Blob {
  id: string;
  cat: Category;
  /** Size of the normalised JSON, the honest measure of what is on the wire. */
  chars: number;
  /** A one-line name for lists and tooltips. */
  label: string;
  /** The readable body: prompt text, tool description, tool output... */
  text: string;
  name?: string;
  toolUseId?: string;
  isError?: boolean;
  /** tool_use input, or a tool definition's input_schema. */
  json?: unknown;
}

export interface Ref {
  b: string;
  /** This block carried a `cache_control` breakpoint. */
  cache?: boolean;
}

export interface VizMessage {
  role: string;
  refs: Ref[];
}

export interface Purpose {
  id: string;
  label: string;
  explain: string;
}

export interface StreamBlock {
  index: number;
  type: string;
  start: number;
  end: number;
  deltas: number;
}

export interface VizRequest {
  /** Unique within the turn view: `bg1` for a background-turn request, `r3` otherwise. */
  key: string;
  n: number;
  dir: string;
  /** Filed under turn-000__background rather than this turn. */
  fromBackground: boolean;
  at: number;
  /** Milliseconds after the first request in this view. */
  start: number;
  durationMs?: number;
  ttfbMs?: number;
  kind: string;
  agentId?: string;
  purpose: Purpose;
  model?: string;
  stream: boolean;
  status?: number;
  error?: string;
  stopReason?: string;
  path?: string;
  /** Every body field that is not system / tools / messages. */
  params: Record<string, unknown>;
  headers: Record<string, string>;
  responseHeaders: Record<string, string>;
  system: Ref[];
  tools: Ref[];
  messages: VizMessage[];
  response: Ref[];
  /** Raw response body when it was not a message (errors, mostly). */
  responseRaw?: unknown;
  tokens?: TokenBreakdown;
  thinkingTokens?: number;
  /** Characters of system + tools + messages, normalised. */
  sentChars: number;
  /** The previous request on the same thread, for "what is new" diffs. */
  prevKey?: string;
  stream_?: { events: number; blocks: StreamBlock[]; firstEvent?: number; lastEvent?: number };
}

export interface VizTurn {
  provider: string;
  session: { dir: string; id: string; startedAt?: string };
  turn: { dir: string; index: number; label: string; userInput: string; startedAt?: string };
  /** Where `fromBackground` requests live, for fetching their raw files. */
  backgroundDir?: string;
  t0: number;
  blobs: Record<string, Blob>;
  requests: VizRequest[];
  warnings: string[];
}

export interface TurnListing {
  dir: string;
  index: number;
  label: string;
  startedAt?: string;
  requests: number;
  main: number;
  background: number;
  durationMs: number;
  tokens: number;
}

export interface SessionListing {
  dir: string;
  id: string;
  provider: string;
  supported: boolean;
  startedAt?: string;
  updatedAt?: string;
  turns: TurnListing[];
}

/* -------------------------------------------------------------- helpers */

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const SYNTHETIC = /^\s*\[(SUGGESTION MODE|No response requested)/i;

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function dirsIn(path: string, prefix: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((n) => n.startsWith(prefix) && statSync(join(path, n)).isDirectory())
    .sort();
}

function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** The first line of a reminder that says what it is about. */
function reminderLabel(text: string): string {
  const inner = text.replace(/<\/?system-reminder>/g, "").trim();
  const heading = /^#+\s*(.+)$/m.exec(inner);
  const first = inner.split("\n").find((l) => l.trim()) ?? "";
  return oneLine(heading && inner.indexOf(heading[0]) < 200 ? heading[1]! : first, 80);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c?.text === "string" ? c.text : c?.type === "image" ? "[image]" : JSON.stringify(c)))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content, null, 2);
}

/**
 * The fields that identify a block's content. Everything else - the
 * `cache_control` breakpoint that moves every request, the `caller` the API
 * adds to a response but the client drops on re-send - is transport.
 */
function normalise(b: ContentBlock): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text ?? "" };
    case "thinking":
      return { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: b.data ?? "" };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content ?? "", is_error: b.is_error === true };
    default: {
      const { cache_control: _c, caller: _k, ...rest } = b as Record<string, unknown>;
      return rest;
    }
  }
}

class BlobStore {
  readonly blobs: Record<string, Blob> = {};

  put(cat: Category, normalised: unknown, make: () => Omit<Blob, "id" | "cat" | "chars">): string {
    const json = JSON.stringify(normalised);
    // Category is part of the identity: the same text as a prompt and as a
    // system block are different things to the reader.
    const id = sha1(cat + "\u0000" + json).slice(0, 14);
    if (!this.blobs[id]) this.blobs[id] = { id, cat, chars: json.length, ...make() };
    return id;
  }
}

/* ------------------------------------------------------ classification */

function classifyBlock(role: string, b: ContentBlock): Category {
  if (role === "system") return "reminder";
  switch (b.type) {
    case "text": {
      const text = String(b.text ?? "");
      if (role === "assistant") return "assistant";
      if (SYNTHETIC.test(text)) return "synthetic";
      const stripped = text.replace(SYSTEM_REMINDER, "").trim();
      if (!stripped) return "reminder";
      if (/^<(command-|local-command|bash-|task-notification)/.test(stripped)) return "reminder";
      return "prompt";
    }
    case "thinking":
    case "redacted_thinking":
      return "thinking";
    case "tool_use":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    case "image":
    case "document":
      return "media";
    default:
      return "other";
  }
}

function blockBlob(store: BlobStore, role: string, b: ContentBlock): Ref {
  const cat = classifyBlock(role, b);
  const norm = normalise(b);
  const id = store.put(cat, norm, () => {
    switch (b.type) {
      case "text": {
        const text = String(b.text ?? "");
        return { label: cat === "reminder" ? reminderLabel(text) : oneLine(text), text };
      }
      case "thinking": {
        const text = String(b.thinking ?? "");
        return {
          label: text ? oneLine(text) : "Thinking (content not returned to the client)",
          text: text || "(The API returned this thinking block with its text omitted; only the signature travels back.)",
        };
      }
      case "redacted_thinking":
        return { label: "Redacted thinking", text: "(encrypted by the API)" };
      case "tool_use": {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const hint = typeof input.command === "string"
          ? input.command
          : typeof input.file_path === "string"
            ? input.file_path
            : typeof input.pattern === "string"
              ? input.pattern
              : typeof input.description === "string"
                ? input.description
                : JSON.stringify(input);
        return {
          label: `${b.name ?? "tool"}: ${oneLine(String(hint), 70)}`,
          text: JSON.stringify(input, null, 2),
          name: String(b.name ?? ""),
          toolUseId: typeof b.id === "string" ? b.id : undefined,
          json: input,
        };
      }
      case "tool_result": {
        const text = toolResultText(b.content);
        return {
          label: (b.is_error ? "Error: " : "") + (oneLine(text, 80) || "(empty output)"),
          text,
          toolUseId: b.tool_use_id,
          isError: b.is_error === true,
        };
      }
      case "image":
      case "document": {
        const src = (b.source ?? {}) as { media_type?: string };
        return { label: `${b.type} · ${src.media_type ?? "?"}`, text: `[${b.type}: ${src.media_type ?? "unknown"}]` };
      }
      default:
        return { label: String(b.type), text: JSON.stringify(b, null, 2) };
    }
  });
  return b.cache_control ? { b: id, cache: true } : { b: id };
}

/** Why Claude Code made this call. The teaching value is in the `explain`. */
function purposeOf(req: any, res: any): Purpose {
  const shape = req?.shape ?? {};
  const body = req?.body ?? {};
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const system = typeof body.system === "string"
    ? body.system
    : Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").join("\n") : "";
  const last = messages[messages.length - 1];
  const lastText = last ? blocksOf(last.content).map((b) => (typeof b.text === "string" ? b.text : "")).join("\n") : "";
  const firstText = messages[0] ? blocksOf(messages[0].content).map((b) => (typeof b.text === "string" ? b.text : "")).join("\n") : "";

  if (shape.kind === "raw" || shape.kind === "other") {
    return {
      id: "plumbing",
      label: "API plumbing",
      explain: "Not an inference call. Claude Code talks to other endpoints too, for things like counting tokens or checking in.",
    };
  }
  if (shape.agentId) {
    return {
      id: "subagent",
      label: "Subagent",
      explain: "A subagent (spawned with the Agent tool) running its own loop. It starts from a fresh, smaller context and reports a summary back to the main thread.",
    };
  }
  if (shape.kind === "main") {
    return {
      id: "loop",
      label: "Agent loop",
      explain: "One lap of the agent loop: the whole conversation so far goes to the model, which answers with text or asks for tools.",
    };
  }
  if (firstText.trim() === "quota" || (body.max_tokens === 1 && messages.length === 1)) {
    return {
      id: "quota",
      label: "Quota check",
      explain: "A one-token probe Claude Code sends at startup to learn your rate-limit status. A 429 here just means \"you are near a limit\", read from the response headers.",
    };
  }
  if (/naming a coding session|title for (this|the) (conversation|session)/i.test(system) || /"title"\s*:/.test(JSON.stringify(res?.body?.content ?? ""))) {
    return {
      id: "title",
      label: "Session title",
      explain: "A small, tool-less call that names the session for the /resume list. It sees only your prompt, not the whole context.",
    };
  }
  if (/^\s*\[SUGGESTION MODE/i.test(lastText)) {
    return {
      id: "suggestion",
      label: "Next-prompt suggestion",
      explain: "After the turn ends, Claude Code asks the model to predict what you will type next, to offer it as a ghost suggestion. It re-sends the entire conversation to do it - and hits the prompt cache, so it is cheap.",
    };
  }
  if (/new conversation topic|isNewTopic/i.test(system + lastText)) {
    return {
      id: "topic",
      label: "Topic detection",
      explain: "Checks whether your message starts a new topic, so the terminal title can follow along.",
    };
  }
  if (/summar/i.test(lastText) && /(compact|conversation so far|context)/i.test(lastText + system)) {
    return {
      id: "compact",
      label: "Compaction",
      explain: "The context window is filling up, so the harness asks the model to summarise the conversation. The summary replaces the history in later requests.",
    };
  }
  if (/^\s*\[No response requested/i.test(lastText)) {
    return {
      id: "notice",
      label: "Background notice",
      explain: "A message the harness feeds the model without expecting a reply.",
    };
  }
  return {
    id: "background",
    label: "Background call",
    explain: "A call Claude Code makes on its own behalf, outside the main agent loop.",
  };
}

function streamSummary(path: string): VizRequest["stream_"] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const blocks = new Map<number, StreamBlock>();
  let events = 0;
  let firstEvent: number | undefined;
  let lastEvent: number | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    events++;
    const at = typeof ev.at === "number" ? ev.at : 0;
    firstEvent ??= at;
    lastEvent = at;
    const d = ev.data ?? {};
    if (d.type === "content_block_start") {
      blocks.set(d.index, { index: d.index, type: d.content_block?.type ?? "?", start: at, end: at, deltas: 0 });
    } else if (d.type === "content_block_delta") {
      const b = blocks.get(d.index);
      if (b) {
        b.deltas++;
        b.end = at;
      }
    } else if (d.type === "content_block_stop") {
      const b = blocks.get(d.index);
      if (b) b.end = at;
    }
  }
  return { events, blocks: [...blocks.values()].sort((a, b) => a.index - b.index), firstEvent, lastEvent };
}

/* --------------------------------------------------------------- digest */

function digestRequest(
  store: BlobStore,
  reqDir: string,
  name: string,
  fromBackground: boolean,
): VizRequest | undefined {
  const req = readJson(join(reqDir, "request.json"));
  if (!req) return undefined;
  const res = readJson(join(reqDir, "response.json")) ?? {};
  const shape = req.shape ?? {};
  const body = req.body && typeof req.body === "object" ? req.body : {};

  const system: Ref[] = [];
  const sysBlocks: ContentBlock[] = typeof body.system === "string"
    ? [{ type: "text", text: body.system }]
    : Array.isArray(body.system) ? body.system : [];
  sysBlocks.forEach((b, i) => {
    const text = String(b.text ?? "");
    const id = store.put("system", normalise(b), () => ({
      label: i === 0 && /billing-header/.test(text)
        ? "Billing header"
        : text.length < 120 ? oneLine(text) : `System prompt · ${oneLine(text, 60)}`,
      text,
    }));
    system.push(b.cache_control ? { b: id, cache: true } : { b: id });
  });

  const tools: Ref[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const { cache_control: _c, ...def } = t ?? {};
    const id = store.put("tools", def, () => ({
      label: String(def.name ?? def.type ?? "tool"),
      name: String(def.name ?? def.type ?? "tool"),
      text: String(def.description ?? ""),
      json: def.input_schema ?? def,
    }));
    tools.push(t?.cache_control ? { b: id, cache: true } : { b: id });
  }

  const messages: VizMessage[] = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = String(m?.role ?? "?");
    messages.push({ role, refs: blocksOf(m?.content).map((b) => blockBlob(store, role, b)) });
  }

  const resBody = res.body;
  const response: Ref[] = Array.isArray(resBody?.content)
    ? resBody.content.map((b: ContentBlock) => blockBlob(store, "assistant", b))
    : [];

  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k !== "system" && k !== "tools" && k !== "messages") params[k] = v;
  }

  const sentChars =
    [...system, ...tools, ...messages.flatMap((m) => m.refs)].reduce((n, r) => n + (store.blobs[r.b]?.chars ?? 0), 0);

  return {
    key: "",
    n: Number(req.request ?? 0),
    dir: name,
    fromBackground,
    at: Date.parse(req.at ?? "") || 0,
    start: 0,
    durationMs: res.timing?.durationMs,
    ttfbMs: res.timing?.ttfbMs,
    kind: String(shape.kind ?? "?"),
    agentId: shape.agentId,
    purpose: purposeOf(req, res),
    model: shape.model ?? body.model,
    stream: shape.stream === true,
    status: res.status,
    error: res.error,
    stopReason: res.stopReason,
    path: req.path,
    params,
    headers: req.headers ?? {},
    responseHeaders: res.headers ?? {},
    system,
    tools,
    messages,
    response,
    responseRaw: response.length ? undefined : resBody,
    tokens: res.usage ? claudeTokens(res.usage) : undefined,
    thinkingTokens: res.usage?.output_tokens_details?.thinking_tokens,
    sentChars,
    stream_: shape.stream ? streamSummary(join(reqDir, "stream.jsonl")) : undefined,
  };
}

/**
 * Background-turn requests that belong in front of this turn: the ones made
 * after the previous turn finished. Claude Code only files a request under
 * turn-000 when no turn is in flight, so in practice these are the startup
 * probes and the title call that the first prompt triggers.
 */
function backgroundWindow(sessionDir: string, turnDir: string): { from: number; to: number } | undefined {
  const turns = dirsIn(sessionDir, "turn-").filter((d) => !d.startsWith("turn-000"));
  const i = turns.indexOf(turnDir);
  if (i < 0) return undefined;
  const prev = i > 0 ? readJson(join(sessionDir, turns[i - 1]!, "turn.json")) : undefined;
  const from = prev?.updatedAt ? Date.parse(prev.updatedAt) : -Infinity;
  const self = readJson(join(sessionDir, turnDir, "turn.json"));
  const to = self?.updatedAt ? Date.parse(self.updatedAt) : Infinity;
  return { from, to };
}

export function digestTurn(logDir: string, sessionName: string, turnName: string): VizTurn {
  const sessionDir = join(logDir, sessionName);
  const turnDir = join(sessionDir, turnName);
  const session = readJson(join(sessionDir, "session.json")) ?? {};
  const turn = readJson(join(turnDir, "turn.json")) ?? {};
  const store = new BlobStore();
  const warnings: string[] = [];
  const provider = String(session.provider ?? "claude");
  if (provider !== "claude") warnings.push(`This session was captured with the "${provider}" provider; the visualizer only understands Claude Code traffic so far.`);

  const requests: VizRequest[] = [];
  for (const name of dirsIn(turnDir, "req-")) {
    const r = digestRequest(store, join(turnDir, name), name, false);
    if (r) requests.push(r);
  }

  const bgDir = dirsIn(sessionDir, "turn-000")[0];
  const window = backgroundWindow(sessionDir, turnName);
  if (bgDir && bgDir !== turnName && window) {
    for (const name of dirsIn(join(sessionDir, bgDir), "req-")) {
      const r = digestRequest(store, join(sessionDir, bgDir, name), name, true);
      if (r && r.at > window.from && r.at <= window.to) requests.push(r);
    }
  }

  // A background call's own prompt ("quota", the title request wrapping your
  // words in <session>) is the harness talking, not you. Anything the main
  // loop also carries is a real prompt and keeps its colour.
  const humanSaid = new Set(
    requests.filter((r) => r.kind === "main").flatMap((r) => r.messages.flatMap((m) => m.refs.map((x) => x.b))),
  );
  for (const r of requests) {
    if (r.kind === "main") continue;
    for (const ref of r.messages.flatMap((m) => m.refs)) {
      const blob = store.blobs[ref.b];
      if (blob?.cat === "prompt" && !humanSaid.has(ref.b)) blob.cat = "synthetic";
    }
  }

  requests.sort((a, b) => a.at - b.at || a.n - b.n);
  const t0 = requests[0]?.at ?? 0;
  const lastOnThread = new Map<string, VizRequest>();
  for (const r of requests) {
    r.key = (r.fromBackground ? "bg" : "r") + r.n;
    r.start = r.at - t0;
    // Main-thread requests (and the suggestion call, which replays the main
    // thread) diff against the previous main-thread request. A subagent diffs
    // against its own previous request.
    const thread = r.agentId ? `agent:${r.agentId}` : r.kind === "main" || r.purpose.id === "suggestion" ? "main" : undefined;
    if (thread) {
      const prev = lastOnThread.get(thread);
      if (prev) r.prevKey = prev.key;
      if (r.kind === "main" || r.agentId) lastOnThread.set(thread, r);
    }
  }

  let userInput = "";
  try {
    userInput = readFileSync(join(turnDir, "user-input.txt"), "utf8").trim();
  } catch {}

  return {
    provider,
    session: { dir: sessionName, id: String(session.session ?? sessionName), startedAt: session.startedAt },
    turn: {
      dir: turnName,
      index: Number(turn.turn ?? 0),
      label: String(turn.label ?? turnName),
      userInput,
      startedAt: turn.startedAt,
    },
    backgroundDir: bgDir,
    t0,
    blobs: store.blobs,
    requests,
    warnings,
  };
}

/* ------------------------------------------------------------- listing */

export function listSessions(logDir: string): SessionListing[] {
  const out: SessionListing[] = [];
  if (!existsSync(logDir)) return out;
  for (const name of readdirSync(logDir)) {
    const dir = join(logDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const session = readJson(join(dir, "session.json"));
    if (!session) continue;
    const provider = String(session.provider ?? "claude");
    const turns: TurnListing[] = [];
    for (const t of dirsIn(dir, "turn-")) {
      if (t.startsWith("turn-000")) continue;
      const meta = readJson(join(dir, t, "turn.json")) ?? {};
      const reqs: any[] = Array.isArray(meta.requests) ? meta.requests : [];
      turns.push({
        dir: t,
        index: Number(meta.turn ?? 0),
        label: String(meta.label ?? t),
        startedAt: meta.startedAt,
        requests: reqs.length,
        main: reqs.filter((r) => r.kind === "main" && !r.agentId).length,
        background: reqs.filter((r) => r.kind !== "main" || r.agentId).length,
        durationMs: reqs.reduce((n, r) => n + (r.durationMs ?? 0), 0),
        tokens: provider === "claude" ? reqs.reduce((n, r) => n + claudeTokens(r.usage).total, 0) : 0,
      });
    }
    if (turns.length === 0) continue;
    out.push({
      dir: name,
      id: String(session.session ?? name),
      provider,
      supported: provider === "claude",
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      turns,
    });
  }
  return out.sort((a, b) => String(b.startedAt ?? b.dir).localeCompare(String(a.startedAt ?? a.dir)));
}
