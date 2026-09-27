/**
 * Turns one captured turn into the model the visualizer draws.
 *
 * The central trick is a content-addressed blob store: every system block,
 * tool definition and message content block is hashed (after dropping the
 * fields that change between re-sends, like `cache_control`) and stored once.
 * Requests then hold references. Two requests that reference the same blob
 * sent the same bytes twice - which is exactly the point the visualizer is
 * built to make: the model is stateless, so every request carries everything.
 *
 * Reads only what is on disk. Taking a request apart is provider-specific and
 * lives in an adapter (`claude.ts`, `codex.ts`); everything here is shared.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeViz } from "./claude.ts";
import { codexViz } from "./codex.ts";
import {
  BlobStore,
  dirsIn,
  readJson,
  type SessionListing,
  type TurnListing,
  type VizAdapter,
  type VizRequest,
  type VizTurn,
} from "./model.ts";

export type * from "./model.ts";

/** Providers the visualizer understands, keyed on `session.json` `provider`. */
export const ADAPTERS: Record<string, VizAdapter> = {
  claude: claudeViz,
  codex: codexViz,
};

function adapterFor(provider: string): VizAdapter | undefined {
  return Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : undefined;
}

/* --------------------------------------------------------------- digest */

function digestRequest(
  adapter: VizAdapter,
  store: BlobStore,
  reqDir: string,
  name: string,
  fromBackground: boolean,
): VizRequest | undefined {
  const req = readJson(join(reqDir, "request.json"));
  if (!req) return undefined;
  const res = readJson(join(reqDir, "response.json")) ?? {};
  const shape = req.shape ?? {};
  const parts = adapter.request(store, req, res, reqDir);

  const sentChars = [...parts.system, ...parts.tools, ...parts.messages.flatMap((m) => m.refs)]
    .reduce((n, r) => n + (store.blobs[r.b]?.chars ?? 0), 0);

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
    model: shape.model ?? req.body?.model,
    stream: shape.stream === true,
    status: res.status,
    error: res.error,
    stopReason: res.stopReason,
    path: req.path,
    headers: req.headers ?? {},
    responseHeaders: res.headers ?? {},
    tokens: res.usage ? adapter.tokens(res.usage) : undefined,
    sentChars,
    ...parts,
  };
}

/**
 * Background-turn requests that belong in front of this turn: the ones made
 * after the previous turn finished. A harness only files a request under
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
  let adapter = adapterFor(provider);
  if (!adapter) {
    warnings.push(`This session was captured with the "${provider}" provider, which the visualizer does not understand yet. It is drawn as if it were Claude Code traffic.`);
    adapter = claudeViz;
  }

  const requests: VizRequest[] = [];
  for (const name of dirsIn(turnDir, "req-")) {
    const r = digestRequest(adapter, store, join(turnDir, name), name, false);
    if (r) requests.push(r);
  }

  const bgDir = dirsIn(sessionDir, "turn-000")[0];
  const window = backgroundWindow(sessionDir, turnName);
  if (bgDir && bgDir !== turnName && window) {
    for (const name of dirsIn(join(sessionDir, bgDir), "req-")) {
      const r = digestRequest(adapter, store, join(sessionDir, bgDir, name), name, true);
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
    harness: adapter.harness,
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
  for (const name of dirsIn(logDir, "")) {
    const dir = join(logDir, name);
    const session = readJson(join(dir, "session.json"));
    if (!session) continue;
    const provider = String(session.provider ?? "claude");
    const adapter = adapterFor(provider);
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
        tokens: adapter ? reqs.reduce((n, r) => n + adapter.tokens(r.usage).total, 0) : 0,
      });
    }
    if (turns.length === 0) continue;
    out.push({
      dir: name,
      id: String(session.session ?? name),
      provider,
      harness: adapter?.harness.name,
      supported: adapter !== undefined,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      turns,
    });
  }
  return out.sort((a, b) => String(b.startedAt ?? b.dir).localeCompare(String(a.startedAt ?? a.dir)));
}
