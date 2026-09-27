/**
 * The shape the visualizer draws, and the pieces every provider's digest
 * shares: the content-addressed blob store and a few small readers.
 *
 * A provider plugs in as a `VizAdapter`: it knows how to take one request
 * apart into system / tools / messages / response blobs, how to read its
 * token usage, and what to call itself on screen. Everything else - finding
 * turns, pulling in background calls, threading requests for "what is new"
 * diffs - is the same for every harness and lives in `digest.ts`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  /** For a tool definition: the namespace it was declared in, if any. */
  group?: string;
  /** The skills this block advertises to the model, when it is a skills list. */
  skills?: Skill[];
}

/**
 * One entry in the skills list a harness injects. Only this much rides along
 * on every request; the SKILL.md body is fetched when the model asks for it.
 */
export interface Skill {
  name: string;
  description: string;
  /** Where the SKILL.md lives, when the harness says (Codex, Cursor). */
  path?: string;
  /** Characters this entry takes up in the list. */
  chars: number;
}

export interface Ref {
  b: string;
  /** This block carried a `cache_control` breakpoint. */
  cache?: boolean;
}

export interface VizMessage {
  role: string;
  refs: Ref[];
  /** Where it sits in the request body, when that is not `messages[i]`. */
  label?: string;
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

export interface StreamSummary {
  events: number;
  blocks: StreamBlock[];
  firstEvent?: number;
  lastEvent?: number;
}

/**
 * How the model's reply ended, in the loop's own terms: `tool_use` means the
 * harness runs something and goes round again, `end_turn` means it stops.
 * Anything else is the provider's raw value (`max_tokens`, `incomplete`...).
 */
export type Stop = "tool_use" | "end_turn" | (string & {});

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
  /** The provider's own stop value, as it appears on the wire. */
  stopReason?: string;
  /** The same, normalised for the loop (see `Stop`). */
  stop?: Stop;
  path?: string;
  /** Every body field that is not system / tools / conversation. */
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
  stream_?: StreamSummary;
  /**
   * The turn directory holding `dir`, when it is neither this turn nor the
   * background turn (a Cursor run stream filed under an earlier turn).
   */
  rawTurn?: string;
}

/** What the page calls the harness, and how it words the parts that differ. */
export interface HarnessInfo {
  /** `session.json` provider id. */
  id: string;
  /** "Claude Code", "Codex CLI". */
  name: string;
  /** The box on the right of the stage: "Claude API". */
  api: string;
  /** The response field that says why the reply ended, as the wire spells it. */
  stopField: string;
  /** Overrides for a category's explanation, where this harness differs. */
  about: Partial<Record<Category, string>>;
  /**
   * Set when the agent loop runs on the vendor's servers rather than on your
   * machine: where it runs ("Cursor's servers"). Your machine then only runs
   * the tools it is sent, and the page words the loop that way.
   */
  remoteLoop?: string;
  /**
   * "context" when the harness reports only how full the context window was,
   * with no output or cache split, so the page does not print zeros for them.
   */
  usage?: "billing" | "context";
  /** How the model gets a skill's full SKILL.md, for the Skills tab. */
  skills?: string;
}

export interface VizTurn {
  provider: string;
  harness: HarnessInfo;
  session: { dir: string; id: string; startedAt?: string };
  turn: { dir: string; index: number; label: string; userInput: string; startedAt?: string };
  /** Where `fromBackground` requests live, for fetching their raw files. */
  backgroundDir?: string;
  t0: number;
  blobs: Record<string, Blob>;
  requests: VizRequest[];
  warnings: string[];
  /** Things worth knowing about how this turn was rebuilt; not problems. */
  notes: string[];
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
  /** The harness's display name, when the visualizer understands it. */
  harness?: string;
  supported: boolean;
  startedAt?: string;
  updatedAt?: string;
  turns: TurnListing[];
}

/* -------------------------------------------------------------- adapter */

/** The provider-specific half of one digested request. */
export interface RequestParts {
  system: Ref[];
  tools: Ref[];
  messages: VizMessage[];
  response: Ref[];
  responseRaw?: unknown;
  params: Record<string, unknown>;
  purpose: Purpose;
  stop?: Stop;
  thinkingTokens?: number;
  stream_?: StreamSummary;
}

export interface VizAdapter {
  harness: HarnessInfo;
  /** The provider's `renderer.tokens`: raw usage into the neutral breakdown. */
  tokens(usage: unknown): TokenBreakdown;
  /** Take one request apart. `req` and `res` are request.json and response.json. */
  request(store: BlobStore, req: any, res: any, reqDir: string): RequestParts;
  /**
   * For a harness whose HTTP requests are not one per model call - Cursor
   * runs the loop on its servers and streams one transcript for a whole run -
   * build the turn's requests directly. `digest.ts` still sorts, keys and
   * threads them. Adapters without it get the per-request path.
   */
  turn?(input: TurnInput): { requests: VizRequest[]; notes: string[]; warnings: string[] };
  /** The home page's per-turn counts, for an adapter that has `turn`. */
  listTurns?(sessionDir: string): Map<string, { requests: number; durationMs: number; tokens: number }>;
}

export interface TurnInput {
  store: BlobStore;
  sessionDir: string;
  turnDir: string;
}

/* -------------------------------------------------------------- helpers */

export function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function dirsIn(path: string, prefix: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((n) => n.startsWith(prefix) && statSync(join(path, n)).isDirectory())
    .sort();
}

export function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** stream.jsonl, one `{ at, event, data }` per line; unreadable lines skipped. */
export function readStream(path: string): Array<{ at: number; event?: string; data: any }> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const out: Array<{ at: number; event?: string; data: any }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      out.push({ at: typeof ev.at === "number" ? ev.at : 0, event: ev.event, data: ev.data ?? {} });
    } catch {}
  }
  return out;
}

/**
 * A markdown bullet list of skills, one `- name: description` per entry.
 * An entry runs to the next top-level bullet, so a description may wrap.
 * Names can hold a colon (`plugin:skill`), so the name ends at the first
 * colon followed by whitespace. A trailing `(file: /path)` is the location.
 */
export function bulletSkills(list: string): Skill[] {
  const out: Skill[] = [];
  for (const entry of list.split(/\n(?=- )/)) {
    const m = /^- ([\s\S]+)$/.exec(entry.trim());
    if (!m) continue;
    const body = m[1]!.trim();
    const cut = /:\s/.exec(body);
    const name = (cut ? body.slice(0, cut.index) : body).trim();
    let description = cut ? body.slice(cut.index + 1).trim() : "";
    let path: string | undefined;
    const loc = /\s*\((?:file|[\w ]+resource):\s*([^()]+)\)\s*$/.exec(description);
    if (loc) {
      path = loc[1]!.trim();
      description = description.slice(0, loc.index).trim();
    }
    if (name && !/\s/.test(name)) out.push({ name, description, ...(path ? { path } : {}), chars: entry.trim().length });
  }
  return out;
}

export class BlobStore {
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

export const PLUMBING: Purpose = {
  id: "plumbing",
  label: "API plumbing",
  explain: "Not an inference call. The harness talks to other endpoints too, for things like listing models or counting tokens.",
};
