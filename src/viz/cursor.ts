/**
 * The Cursor CLI half of the digest.
 *
 * Cursor does not fit the one-request-per-model-call shape the other adapters
 * take apart, because **the agent loop runs on Cursor's servers**. The model
 * is called from there, so no model request ever crosses the proxy. What does:
 *
 * - `RunSSE`: one long response per run, mirroring the server's transcript
 *   down to the CLI. It carries the conversation as JSON chat messages
 *   (`system`, `user`, `assistant`, `tool`) among protobuf frames: streamed
 *   text and reasoning-summary deltas, the server asking the CLI to run a tool,
 *   tool start and finish records, and context-window readings.
 * - `BidiAppend`: dozens of small calls pushing events up: the prompt, tool
 *   results, acknowledgements, and a heartbeat every five seconds. None of
 *   them carries the conversation, so they are counted in a note and left out.
 *
 * So this rebuilds the model calls from the transcript. Every `assistant`
 * message is one model call. What the model read for it is everything before
 * it in the conversation, and what it answered is the message itself. Timing
 * comes from the epoch-millisecond timestamps inside the frames, because the
 * proxy only sees the stream as one body (every `at` in stream.jsonl is 0).
 *
 * Three traps, all seen in real captures:
 *
 * - A run stream is opened before its prompt is sent, so the logger files it
 *   under the turn in flight: the first run lands in turn-000, the second
 *   prompt's run lands in turn 1. Steps are assigned to turns by the
 *   `<user_query>` they answer, reading every run stream in the session.
 * - A later run re-sends nothing old: Cursor keeps the conversation on its
 *   server (content-addressed; the state frames list sha256 hashes) and only
 *   streams new messages. The transcript is therefore carried across the
 *   session's streams in time order.
 * - When a stream drops, the CLI reconnects and the server replays its last
 *   messages, with extra `providerOptions`. Messages are matched up with those
 *   dropped, so a replay counts once.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CursorUsage } from "../cursor/messages.ts";
import { tokens } from "../cursor/render.ts";
import { RUN_PATH } from "../cursor/turns.ts";
import {
  dirsIn,
  oneLine,
  PLUMBING,
  readJson,
  readStream,
  type BlobStore,
  type Category,
  type Purpose,
  type Ref,
  type RequestParts,
  type StreamBlock,
  type TurnInput,
  type VizAdapter,
  type VizMessage,
  type VizRequest,
} from "./model.ts";

type Json = Record<string, any>;
type Event = { at: number; event?: string; data: any };

interface RunStream {
  turnDir: string;
  reqDir: string;
  at: number;
  req: Json;
  res: Json;
  events: Event[];
}

/** A reasoning summary: Cursor streams one per step, because the reasoning itself is encrypted. */
interface Summary {
  text: string;
  start: number;
  end?: number;
}

/** What the frames say about the model call in progress, until its message lands. */
interface Pending {
  summaries: Summary[];
  usage?: CursorUsage;
  /** First output of any kind (epoch ms). */
  firstAt?: number;
  thinkAt?: number;
  textAt?: number;
  /** When the text record was written, i.e. the text was complete. */
  textDone?: number;
  thinkDeltas: number;
  textDeltas: number;
  events: number;
}

interface Step extends Pending {
  source: RunStream;
  /** Index of the assistant message in the session transcript. */
  index: number;
  model?: string;
  turnDir?: string;
  startAt: number;
  endAt: number;
}

interface Session {
  streams: RunStream[];
  /** Every chat message, in order, across the whole session, replays removed. */
  transcript: Json[];
  steps: Step[];
  /** Tool start and finish times by tool-call id (epoch ms). */
  toolTimes: Map<string, { start?: number; end?: number }>;
  /** Tools the server said the model may call. */
  allowed: Set<string>;
  /** Tools reachable only through CallDynamicTool. */
  dynamic: Set<string>;
  /** The last per-component context breakdown Cursor reported. */
  components?: CursorUsage["components"];
  /** Transcript index of each user message holding a `<user_query>` → turn dir. */
  queryTurn: Map<number, string>;
}

/* ----------------------------------------------------------- the streams */

/** Every run stream in the session, oldest first. */
function runStreams(sessionDir: string): RunStream[] {
  const out: RunStream[] = [];
  for (const t of dirsIn(sessionDir, "turn-")) {
    for (const r of dirsIn(join(sessionDir, t), "req-")) {
      const dir = join(sessionDir, t, r);
      // The run stream is the only streamed call; skip the BidiAppends cheaply.
      if (!existsSync(join(dir, "stream.jsonl"))) continue;
      const req = readJson(join(dir, "request.json"));
      if (!req || !RUN_PATH.test(String(req.path ?? ""))) continue;
      out.push({
        turnDir: t,
        reqDir: r,
        at: Date.parse(req.at ?? "") || 0,
        req,
        res: readJson(join(dir, "response.json")) ?? {},
        events: readStream(join(dir, "stream.jsonl")) ?? [],
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const isChat = (c: unknown): c is Json =>
  !!c && typeof c === "object" && typeof (c as Json).role === "string" && "content" in (c as Json);

const partsOf = (m: Json): Json[] =>
  Array.isArray(m.content) ? m.content.filter((p: unknown) => p && typeof p === "object") : [];

/** Drop `providerOptions` and `id`, which a replayed message gains or loses. */
function strip(v: any): any {
  if (Array.isArray(v)) return v.map(strip);
  if (!v || typeof v !== "object") return v;
  const out: Json = {};
  for (const [k, x] of Object.entries(v)) if (k !== "providerOptions" && k !== "id") out[k] = strip(x);
  return out;
}

const identity = (m: Json) => JSON.stringify(strip(m));

/**
 * Tool timing hides in several frame shapes (the dispatch, the completion,
 * the stored record); all of them carry the call id at field 57 and the
 * start and end at 59 and 60.
 */
function scanToolTimes(v: any, into: Session["toolTimes"], depth = 0): void {
  if (!v || typeof v !== "object" || depth > 5) return;
  if (typeof v.f57 === "string" && (typeof v.f59 === "number" || typeof v.f60 === "number")) {
    const t = into.get(v.f57) ?? {};
    if (typeof v.f59 === "number") t.start = Math.min(t.start ?? Infinity, v.f59);
    if (typeof v.f60 === "number") t.end = Math.max(t.end ?? 0, v.f60);
    into.set(v.f57, t);
  }
  for (const x of Object.values(v)) scanToolTimes(x, into, depth + 1);
}

/** Tool names from the execution contracts the server attaches to a pending call. */
function collectAllowed(m: any, into: Set<string>): void {
  const contracts = m?.providerOptions?.cursor?.pendingToolExecutionContracts;
  if (!contracts || typeof contracts !== "object") return;
  for (const c of Object.values(contracts) as Json[]) {
    for (const n of Array.isArray(c?.allowedToolNames) ? c.allowedToolNames : []) into.add(String(n));
  }
}

function modelOf(m: any): string | undefined {
  for (const p of Array.isArray(m?.content) ? m.content : []) {
    const name = p?.providerOptions?.cursor?.modelName;
    if (typeof name === "string") return name;
  }
  return undefined;
}

const fresh = (): Pending => ({ summaries: [], thinkDeltas: 0, textDeltas: 0, events: 0 });

/** The `<user_query>` inside a user message, if it has one. */
function queryOf(m: Json): string | undefined {
  if (m.role !== "user") return undefined;
  const text = typeof m.content === "string" ? m.content : partsOf(m).map((p) => String(p.text ?? "")).join("\n");
  return /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)?.[1];
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

function readSession(sessionDir: string): Session {
  const s: Session = {
    streams: runStreams(sessionDir),
    transcript: [],
    steps: [],
    toolTimes: new Map(),
    allowed: new Set(),
    dynamic: new Set(),
    queryTurn: new Map(),
  };
  const seen = new Set<string>();
  const seenSummary = new Set<string>();
  let pending = fresh();

  for (const st of s.streams) {
    for (const ev of st.events) {
      const d = ev.data ?? {};
      pending.events++;
      scanToolTimes(d, s.toolTimes);

      if (ev.event === "run.control") {
        // Field 4 is a reasoning-summary delta, field 1 a text delta; both
        // carry the step's clock at field 25. Tool frames carry it too, but
        // a reconnect replays those, so they say nothing about the model.
        const at = typeof d.f25 === "number" ? d.f25 : undefined;
        if ("f4" in d) {
          pending.thinkDeltas++;
          if (at !== undefined) pending.thinkAt ??= at;
        } else if ("f1" in d) {
          pending.textDeltas++;
          if (at !== undefined) pending.textAt ??= at;
        } else {
          continue;
        }
        if (at !== undefined) pending.firstAt ??= at;
        continue;
      }

      if (ev.event === "run.state") {
        if (d.usage) {
          const u = d.usage as CursorUsage;
          if (u.components?.length) s.components = u.components;
          pending.usage = { ...u, components: u.components?.length ? u.components : s.components };
        }
        collectAllowed(d.content, s.allowed);
        continue;
      }

      if (ev.event !== "message") continue;
      const c = d.content;

      if (isChat(c)) {
        collectAllowed(c, s.allowed);
        const key = identity(c);
        if (seen.has(key)) continue;
        seen.add(key);
        s.transcript.push(c);
        if (c.role === "assistant") {
          s.steps.push({ ...pending, source: st, index: s.transcript.length - 1, model: modelOf(c), startAt: 0, endAt: 0 });
          pending = fresh();
        }
        continue;
      }

      // The stored records beside the chat messages (protobuf, read schema-free).
      if (typeof c?.f3?.f1 === "string" && typeof c.f3.f3 === "number") {
        const k = `${c.f3.f3}:${c.f3.f1}`;
        if (!seenSummary.has(k)) {
          seenSummary.add(k);
          pending.summaries.push({ text: c.f3.f1, start: c.f3.f3, end: typeof c.f3.f4 === "number" ? c.f3.f4 : undefined });
        }
      } else if (typeof c?.f1?.f1 === "string" && typeof c.f1.f2 === "number") {
        pending.textDone = Math.max(pending.textDone ?? 0, c.f1.f2);
      } else if (c?.f1?.f1?.bytes === 32 && c.f1.f9 !== undefined) {
        // The conversation state: root hash, turn hashes, and at field 9 the
        // tools the model can only reach through CallDynamicTool.
        for (const n of ([] as unknown[]).concat(c.f1.f9)) if (typeof n === "string") s.dynamic.add(n);
      }
    }
  }

  assignTurns(sessionDir, s);
  timeSteps(sessionDir, s);
  return s;
}

/** Each user query to the turn that holds that prompt; time decides otherwise. */
function assignTurns(sessionDir: string, s: Session): void {
  const turns = dirsIn(sessionDir, "turn-")
    .filter((t) => !t.startsWith("turn-000"))
    .map((t) => {
      let input = "";
      try {
        input = readFileSync(join(sessionDir, t, "user-input.txt"), "utf8");
      } catch {}
      const meta = readJson(join(sessionDir, t, "turn.json")) ?? {};
      return { dir: t, input: flat(input), at: Date.parse(meta.startedAt ?? "") || 0, claimed: false };
    });

  let current: string | undefined;
  s.transcript.forEach((m, i) => {
    const q = queryOf(m);
    if (q === undefined) return;
    const match = turns.find((t) => !t.claimed && t.input === flat(q))
      // A prompt the logger labelled differently: take the next unclaimed turn.
      ?? turns.find((t) => !t.claimed && (!current || t.dir > current));
    if (match) {
      match.claimed = true;
      current = match.dir;
      s.queryTurn.set(i, match.dir);
    }
  });

  let turn: string | undefined;
  let step = 0;
  s.transcript.forEach((_, i) => {
    if (s.queryTurn.has(i)) turn = s.queryTurn.get(i);
    if (s.steps[step]?.index === i) s.steps[step++]!.turnDir = turn;
  });
}

/**
 * When each model call started and ended, from the server's clock. A call
 * starts when its input is complete: the prompt for the first call of a turn,
 * the last tool result for every call after. It ends when its last output
 * lands: its text, its reasoning summary, or the moment the server hands its
 * tool calls to your machine.
 */
function timeSteps(sessionDir: string, s: Session): void {
  const turnStart = new Map<string, number>();
  for (const t of dirsIn(sessionDir, "turn-")) {
    const at = Date.parse(readJson(join(sessionDir, t, "turn.json"))?.startedAt ?? "");
    if (at) turnStart.set(t, at);
  }
  let prev: Step | undefined;
  for (const step of s.steps) {
    const calls = callIds(s.transcript[step.index]!);
    const callStarts = calls.map((id) => s.toolTimes.get(id)?.start).filter((x): x is number => x !== undefined);
    const sameTurn = prev && prev.turnDir === step.turnDir;
    const prevEnds = sameTurn ? callIds(s.transcript[prev!.index]!).map((id) => s.toolTimes.get(id)?.end).filter((x): x is number => x !== undefined) : [];
    step.startAt = prevEnds.length
      ? Math.max(...prevEnds)
      : sameTurn ? prev!.endAt
      : (step.turnDir && turnStart.get(step.turnDir)) || step.source.at;
    const ends = [step.textDone, step.textAt, ...step.summaries.map((x) => x.end ?? x.start), ...callStarts]
      .filter((x): x is number => typeof x === "number");
    step.endAt = Math.max(step.startAt, ...ends, step.firstAt ?? 0);
    prev = step;
  }
}

function callIds(m: Json): string[] {
  return partsOf(m).filter((p) => p.type === "tool-call" && typeof p.toolCallId === "string").map((p) => p.toolCallId);
}

/* ----------------------------------------------------------------- blobs */

/** What Cursor calls the sections of the context it injects as a user message. */
const SECTION: Record<string, string> = {
  user_info: "Your environment",
  agent_transcripts: "Where transcripts are kept",
  rules: "Rules",
  available_subagent_types: "Subagent definitions",
  available_subagent_models: "Subagent models",
  agent_skills: "Skills",
  dynamic_tools: "MCP & dynamic tools",
  timestamp: "Timestamp",
};

/**
 * Cut injected text at each top-level tag. Every chunk runs to the start of
 * the next, so nothing is lost, not even the whitespace between them.
 */
function sections(text: string): Array<{ tag?: string; text: string }> {
  const starts: Array<{ at: number; tag?: string }> = [];
  const open = /^<([a-z_][\w-]*)(?:\s[^>]*)?>/gm;
  let m: RegExpExecArray | null;
  let after = 0;
  while ((m = open.exec(text))) {
    if (m.index < after) continue;
    const close = text.indexOf(`</${m[1]}>`, m.index);
    if (close < 0) continue;
    starts.push({ at: m.index, tag: m[1] });
    after = close + m[1]!.length + 3;
    open.lastIndex = after;
  }
  if (!starts.length || starts[0]!.at > 0) starts.unshift({ at: 0 });
  return starts
    .map((st, i) => ({ tag: st.tag, text: text.slice(st.at, starts[i + 1]?.at ?? text.length) }))
    .filter((x) => x.text.length > 0);
}

function sectionLabel(tag: string | undefined, text: string): string {
  const inner = text.replace(/<\/?[\w-]+[^>]*>/g, " ");
  if (!tag) return oneLine(inner, 80);
  return oneLine(`${SECTION[tag] ?? tag} <${tag}> · ${inner}`, 80);
}

/** A user message: your words, and the context Cursor wraps round them. */
function userRefs(store: BlobStore, m: Json): Ref[] {
  const texts: string[] = typeof m.content === "string"
    ? [m.content]
    : partsOf(m).map((p) => (typeof p.text === "string" ? p.text : ""));
  const refs: Ref[] = [];
  partsOf(m).filter((p) => typeof p.text !== "string").forEach((p) => {
    refs.push({ b: store.put(/image|file/.test(String(p.type)) ? "media" : "other", p, () => ({ label: String(p.type ?? "part"), text: JSON.stringify(p, null, 2) })) });
  });
  for (const text of texts) {
    const chunks = sections(text);
    const tagged = chunks.some((c) => c.tag);
    for (const c of chunks) {
      const cat: Category = c.tag === "user_query" || !tagged ? "prompt" : "reminder";
      const shown = c.tag === "user_query" ? /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(c.text)?.[1] ?? c.text : c.text;
      refs.push({
        b: store.put(cat, { type: "text", text: c.text }, () => ({
          label: cat === "prompt" ? oneLine(shown) : sectionLabel(c.tag, c.text),
          text: c.text,
        })),
      });
    }
  }
  return refs;
}

/** A short hint of what a tool call does, for its one-line label. */
function callHint(args: any): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  for (const k of ["command", "path", "glob_pattern", "pattern", "query", "url", "description"]) {
    if (typeof args[k] === "string") return args[k];
  }
  return JSON.stringify(args);
}

function assistantRefs(store: BlobStore, m: Json, summaries: Summary[]): Ref[] {
  let summarised = false;
  return partsOf(m).map((p) => {
    if (p.type === "reasoning") {
      const own = typeof p.text === "string" && p.text ? p.text : "";
      const summary = summarised ? [] : summaries.map((x) => x.text);
      summarised = true;
      const text = [
        own,
        summary.length ? summary.join("\n\n") : "",
        p.signature && !own
          ? "(The reasoning itself reaches your machine only as an encrypted signature. What you can read above is the summary Cursor streamed while the model thought.)"
          : "",
      ].filter(Boolean).join("\n\n");
      return {
        b: store.put("thinking", { type: "reasoning", text: p.text ?? "", signature: p.signature ?? null }, () => ({
          label: own ? oneLine(own) : summary.length ? oneLine(summary.join(" ")) : "Reasoning (encrypted)",
          text: text || "(empty)",
        })),
      };
    }
    if (p.type === "text") {
      const text = String(p.text ?? "");
      return { b: store.put("assistant", { type: "text", text }, () => ({ label: oneLine(text), text })) };
    }
    if (p.type === "tool-call") {
      const name = String(p.toolName ?? "tool");
      return {
        b: store.put("tool_use", { type: "tool-call", toolCallId: p.toolCallId, toolName: name, args: p.args ?? null }, () => ({
          label: `${name}: ${oneLine(callHint(p.args), 70)}`,
          text: JSON.stringify(p.args ?? {}, null, 2),
          name,
          toolUseId: p.toolCallId,
          json: p.args,
        })),
      };
    }
    return { b: store.put("other", strip(p), () => ({ label: String(p.type ?? "part"), text: JSON.stringify(p, null, 2) })) };
  });
}

function toolRefs(store: BlobStore, m: Json): Ref[] {
  const failed = m.providerOptions?.cursor?.highLevelToolCallResult?.isError === true;
  return partsOf(m).map((p) => {
    if (p.type !== "tool-result") {
      return { b: store.put("other", strip(p), () => ({ label: String(p.type ?? "part"), text: JSON.stringify(p, null, 2) })) };
    }
    const text = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? p.output ?? "", null, 2);
    const isError = failed || p.isError === true;
    return {
      b: store.put("tool_result", { type: "tool-result", toolCallId: p.toolCallId, toolName: p.toolName, result: p.result ?? null }, () => ({
        label: (isError ? "Error: " : "") + (oneLine(text, 80) || "(empty output)"),
        text,
        toolUseId: p.toolCallId,
        isError,
      })),
    };
  });
}

/* --------------------------------------------------------------- the turn */

const LOOP: Purpose = {
  id: "loop",
  label: "Agent loop",
  explain: "One lap of the agent loop, run on Cursor's servers: the model reads the whole conversation and answers with text or asks for tools. Rebuilt from the transcript Cursor streams down to your machine.",
};

/**
 * The tool list. Cursor's server adds the tool schemas itself, so only their
 * names ever reach your machine. Each known tool gets a small blob, and one
 * more stands for the schemas' size as Cursor reports it, so the request is
 * still drawn to scale.
 */
function toolList(store: BlobStore, s: Session): Ref[] {
  const used = new Set(s.transcript.flatMap((m) => partsOf(m).filter((p) => p.type === "tool-call").map((p) => String(p.toolName))));
  const builtIn = [...new Set([...s.allowed, ...used])].filter((n) => !s.dynamic.has(n)).sort();
  const refs: Ref[] = builtIn.map((name) => ({
    b: store.put("tools", { name }, () => ({
      label: name,
      name,
      text: `Built into Cursor. The model sees a full definition of ${name}, but Cursor's server adds it; only the name reaches your machine.`,
    })),
  }));
  for (const name of [...s.dynamic].sort()) {
    refs.push({
      b: store.put("tools", { name, dynamic: true }, () => ({
        label: name,
        name,
        text: `Not loaded up front. The model reaches ${name} through CallDynamicTool, after reading its schema; the <dynamic_tools> section of the injected context lists it.`,
        group: "Dynamic · reached through CallDynamicTool",
      })),
    });
  }
  const schemas = s.components?.find((c) => c.id === "tools");
  const schemaChars = schemas?.chars;
  if (schemaChars) {
    const shown = refs.reduce((n, r) => n + (store.blobs[r.b]?.chars ?? 0), 0);
    const id = store.put("tools", { hidden: "tool schemas" }, () => ({
      label: "Tool schemas (added on Cursor's server)",
      name: "(schemas)",
      text: `Cursor reports ${schemaChars.toLocaleString("en-US")} characters (${(schemas?.tokens ?? 0).toLocaleString("en-US")} tokens) of tool definitions in the model's context. They are added on Cursor's server and never reach your machine, so their text cannot be shown. This block stands in for them, so the request is drawn to scale.`,
      group: "Not visible from your machine",
    }));
    store.blobs[id]!.chars = Math.max(0, schemaChars - shown);
    refs.push({ b: id });
  }
  return refs;
}

/** BidiAppend traffic in one turn directory, by what it carries. */
function clientEvents(dir: string): { total: number; results: number; heartbeats: number; other: number } {
  const out = { total: 0, results: 0, heartbeats: 0, other: 0 };
  for (const r of dirsIn(dir, "req-")) {
    if (existsSync(join(dir, r, "stream.jsonl"))) continue;
    const shape = readJson(join(dir, r, "request.json"))?.shape;
    if (shape?.endpoint !== "BidiAppend") continue;
    out.total++;
    const kind = Array.isArray(shape.eventFields) ? shape.eventFields[0] : undefined;
    if (kind === 1) continue;
    if (kind === 2) out.results++;
    else if (kind === 7) out.heartbeats++;
    else out.other++;
  }
  return out;
}

function buildTurn({ store, sessionDir, turnDir }: TurnInput): { requests: VizRequest[]; notes: string[]; warnings: string[] } {
  const s = readSession(sessionDir);
  const notes: string[] = [];
  const warnings: string[] = [];
  const steps = s.steps.filter((x) => x.turnDir === turnDir);

  // Each transcript entry becomes blobs once; later requests reference them.
  const summariesAt = new Map(s.steps.map((x) => [x.index, x.summaries]));
  const cache = new Map<number, Ref[]>();
  const refsAt = (i: number): Ref[] => {
    let refs = cache.get(i);
    if (!refs) {
      const m = s.transcript[i]!;
      refs = m.role === "system"
        ? [{ b: store.put("system", { type: "text", text: String(m.content) }, () => ({ label: `system · ${oneLine(String(m.content), 60)}`, text: String(m.content) })) }]
        : m.role === "assistant" ? assistantRefs(store, m, summariesAt.get(i) ?? [])
        : m.role === "tool" ? toolRefs(store, m)
        : userRefs(store, m);
      cache.set(i, refs);
    }
    return refs;
  };
  const tools = toolList(store, s);

  const main = dirsIn(join(sessionDir, turnDir), "req-")
    .map((r) => readJson(join(sessionDir, turnDir, r, "request.json")))
    .find((q) => q?.shape?.kind === "main")?.shape ?? {};

  const requests = steps.map((step, k): VizRequest => {
    const system: Ref[] = [];
    const messages: VizMessage[] = [];
    for (let i = 0; i < step.index; i++) {
      const m = s.transcript[i]!;
      if (m.role === "system") system.push(...refsAt(i));
      else messages.push({ role: String(m.role), refs: refsAt(i), label: `transcript[${i}]` });
    }
    const response = refsAt(step.index);
    const calls = callIds(s.transcript[step.index]!);
    const sentChars = [...system, ...tools, ...messages.flatMap((m) => m.refs)].reduce((n, r) => n + (store.blobs[r.b]?.chars ?? 0), 0);

    const rel = (t: number | undefined) => (t === undefined ? undefined : Math.max(0, t - step.startAt));
    const blocks: StreamBlock[] = [];
    if (step.summaries.length || step.thinkDeltas) {
      const start = rel(step.thinkAt ?? step.summaries[0]?.start) ?? 0;
      blocks.push({ index: blocks.length, type: "thinking", start, end: rel(Math.max(...step.summaries.map((x) => x.end ?? x.start), 0)) ?? start, deltas: step.thinkDeltas });
    }
    if (step.textDeltas || step.textDone) {
      const start = rel(step.textAt ?? step.textDone) ?? 0;
      blocks.push({ index: blocks.length, type: "text", start, end: Math.max(start, rel(step.textDone) ?? start), deltas: step.textDeltas });
    }
    for (const id of calls) {
      const at = rel(s.toolTimes.get(id)?.start);
      if (at !== undefined) blocks.push({ index: blocks.length, type: "tool_use", start: at, end: at, deltas: 0 });
    }

    const usage = step.usage;
    const params: Record<string, unknown> = {
      model: step.model ?? main.model,
      conversationId: main.conversationId,
      runId: main.runId,
    };
    if (usage?.usedTokens !== undefined) params.contextWindow = `${usage.usedTokens.toLocaleString("en-US")} of ${(usage.maxTokens ?? 0).toLocaleString("en-US")} tokens`;
    params.rebuiltFrom = `${step.source.turnDir}/${step.source.reqDir}`;

    return {
      key: "",
      n: k + 1,
      dir: step.source.reqDir,
      rawTurn: step.source.turnDir,
      fromBackground: false,
      at: step.startAt,
      start: 0,
      durationMs: step.endAt - step.startAt,
      ttfbMs: step.firstAt !== undefined && step.firstAt >= step.startAt ? step.firstAt - step.startAt : undefined,
      kind: "main",
      purpose: LOOP,
      model: step.model ?? main.model,
      stream: true,
      status: typeof step.source.res.status === "number" ? step.source.res.status : undefined,
      stop: calls.length ? "tool_use" : "end_turn",
      path: step.source.req.path,
      params,
      headers: step.source.req.headers ?? {},
      responseHeaders: step.source.res.headers ?? {},
      system,
      tools,
      messages,
      response,
      tokens: usage ? tokens(usage) : undefined,
      sentChars,
      stream_: { events: step.events, blocks },
    };
  });

  const streams = new Set(steps.map((x) => x.source));
  notes.push(
    `Cursor runs the agent loop on its own servers, so the model is never called from your machine. The ${steps.length} model call${steps.length === 1 ? "" : "s"} on this page ${steps.length === 1 ? "was" : "were"} rebuilt from the transcript Cursor streams down RunSSE: each assistant message is one call, and what the model read for it is everything before it.`,
  );
  const ev = clientEvents(join(sessionDir, turnDir));
  if (ev.total) {
    notes.push(
      `Also on the wire this turn: ${ev.total} BidiAppend calls from your machine up to Cursor: your prompt, ${ev.results} tool results and client-state uploads, ${ev.heartbeats} heartbeats and ${ev.other} acknowledgements. None of them carries the conversation, so they are left out here. They are all in the log.`,
    );
  }
  if (streams.size > 1) {
    notes.push(
      `The run stream was opened ${streams.size} times for this turn: when it drops, the CLI reconnects and Cursor replays the last messages. The replayed messages were matched up and are counted once.`,
    );
  }
  const elsewhere = [...streams].filter((x) => x.turnDir !== turnDir).map((x) => `${x.turnDir}/${x.reqDir}`);
  if (elsewhere.length) {
    notes.push(
      `The logger filed ${elsewhere.length === 1 ? "this turn's run stream" : "some of this turn's run streams"} under ${elsewhere.join(", ")}, because Cursor opens a run before it sends the prompt. The steps were matched to this turn by the prompt they answer.`,
    );
  }
  if (!steps.length) {
    warnings.push(
      s.streams.length
        ? "No model call in the captured run streams answers this turn's prompt. The run may have been cancelled, or its stream was not captured."
        : "No RunSSE stream was captured in this session, so there is no transcript to rebuild. Check that the CLI is on HTTP/1.1 (see docs/cursor.md).",
    );
  } else if (!s.transcript.some((m) => m.role === "system")) {
    warnings.push(
      "This conversation started before the proxy saw it, and Cursor only streams what is new, so the system prompt and earlier messages are missing. Each request is drawn with what was captured.",
    );
  }
  return { requests, notes, warnings };
}

function listTurns(sessionDir: string): Map<string, { requests: number; durationMs: number; tokens: number }> {
  const out = new Map<string, { requests: number; durationMs: number; tokens: number }>();
  for (const step of readSession(sessionDir).steps) {
    if (!step.turnDir) continue;
    const c = out.get(step.turnDir) ?? { requests: 0, durationMs: 0, tokens: 0 };
    c.requests++;
    c.durationMs += step.endAt - step.startAt;
    c.tokens += tokens(step.usage).total;
    out.set(step.turnDir, c);
  }
  return out;
}

/** Unused: `turn` builds every request. Kept so the adapter satisfies the interface. */
function request(): RequestParts {
  return { system: [], tools: [], messages: [], response: [], params: {}, purpose: PLUMBING };
}

export const cursorViz: VizAdapter = {
  harness: {
    id: "cursor",
    name: "Cursor",
    api: "Model API",
    stopField: "inferred stop",
    remoteLoop: "Cursor's servers",
    usage: "context",
    about: {
      system: "Instructions Cursor writes for the model: who it is, how to talk, how to use its tools. You never see them. Cursor's server keeps them and sends them to the model on every call.",
      tools: "What the model may ask for. Cursor's server adds the full definitions itself, so only the tool names reach your machine; one extra block stands for the size Cursor reports for them.",
      reminder: "Context Cursor adds to the conversation for you, as a user message you never typed: your environment, your rules, the skills and subagents it offers, the MCP tools it can load, a timestamp on every prompt.",
      thinking: "The model's reasoning. It reaches your machine only as an encrypted signature; what you can read is the short summary Cursor streams while the model thinks.",
      tool_use: "The model cannot run anything, and in Cursor neither can the server. It sends the tool call down the stream to the CLI, which runs it on your machine and uploads the result.",
      tool_result: "What the tool returned on your machine. The CLI uploads it with a BidiAppend call, and Cursor's server adds it to the conversation.",
    },
  },
  tokens,
  request,
  turn: buildTurn,
  listTurns,
};
