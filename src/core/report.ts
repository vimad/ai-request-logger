#!/usr/bin/env node
/**
 * Re-parses a log tree into Markdown:
 *
 *   node src/core/report.ts [logDir] [--provider=<id>]
 *
 * The proxy already writes these files as it runs; this regenerates them for
 * logs captured earlier, or after you change a renderer. Each log records the
 * provider that produced it, so a mixed log directory re-renders correctly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { defaultProvider, getProvider } from "../providers.ts";
import { renderIndex, renderSession, renderTurn } from "./render.ts";
import type { IndexRow, Provider, SessionRecord, TurnRecord } from "./types.ts";

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

/** The provider a log tree was captured with, falling back to the default. */
function providerFor(sessionDir: string, override?: Provider): Provider {
  if (override) return override;
  const id = readJson(join(sessionDir, "session.json"))?.provider;
  try {
    return getProvider(id);
  } catch {
    return defaultProvider;
  }
}

/** Render every request in one turn directory, then the turn rollup. */
export async function renderTurnDir(
  turnDir: string,
  provider: Provider = defaultProvider,
): Promise<TurnRecord | undefined> {
  const meta: TurnRecord | undefined = readJson(join(turnDir, "turn.json"));
  if (!meta) return undefined;

  let prevMessageCount = 0;
  for (const name of dirsIn(turnDir, "req-")) {
    const dir = join(turnDir, name);
    const req = readJson(join(dir, "request.json"));
    if (!req) continue;
    const res = readJson(join(dir, "response.json")) ?? {};
    await writeFile(
      join(dir, "request.md"),
      provider.renderer.request(req, res, { prevMessageCount }),
    );
    const count = Array.isArray(req.body?.messages) ? req.body.messages.length : 0;
    // Only the main thread grows one conversation; a subagent or background
    // call has its own, so it must not be diffed against the thread's.
    if (count > 0 && !req.shape?.agentId && req.shape?.kind === "main") prevMessageCount = count;
  }

  let userInput = "";
  try {
    userInput = readFileSync(join(turnDir, "user-input.txt"), "utf8");
  } catch {}
  await writeFile(join(turnDir, "turn.md"), renderTurn(meta, userInput, provider.renderer));
  return meta;
}

export async function renderSessionDir(
  sessionDir: string,
  override?: Provider,
): Promise<{ session: SessionRecord; turns: Array<{ meta: TurnRecord; dir: string }> } | undefined> {
  const session: SessionRecord | undefined = readJson(join(sessionDir, "session.json"));
  if (!session) return undefined;
  const provider = providerFor(sessionDir, override);

  const turns: Array<{ meta: TurnRecord; dir: string }> = [];
  for (const name of dirsIn(sessionDir, "turn-")) {
    const meta = await renderTurnDir(join(sessionDir, name), provider);
    if (meta) turns.push({ meta, dir: name });
  }
  await writeFile(
    join(sessionDir, "session.md"),
    renderSession(session, turns, provider.renderer),
  );
  return { session, turns };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const providerFlag = args.find((a) => a.startsWith("--provider="))?.split("=")[1];
  const override = providerFlag ? getProvider(providerFlag) : undefined;
  const positional = args.find((a) => !a.startsWith("--"));
  const target = resolve(positional ?? process.env.LOGGER_LOG_DIR ?? "log");

  if (!existsSync(target)) {
    console.error(`No such log directory: ${target}`);
    process.exit(1);
  }

  // Accept a whole log root, one session, or a single turn directory.
  if (existsSync(join(target, "turn.json"))) {
    await renderTurnDir(target, override ?? providerFor(join(target, ".."), override));
    console.log(`Wrote turn.md and request.md files under ${target}`);
    return;
  }
  if (existsSync(join(target, "session.json"))) {
    await renderSessionDir(target, override);
    console.log(`Wrote session.md under ${target}`);
    return;
  }

  const rows: IndexRow[] = [];
  for (const name of readdirSync(target)) {
    const dir = join(target, name);
    if (!statSync(dir).isDirectory()) continue;
    const result = await renderSessionDir(dir, override);
    if (!result) continue;
    const renderer = providerFor(dir, override).renderer;
    const reqs = result.turns.flatMap((t) => t.meta?.requests ?? []);
    rows.push({
      dir: basename(dir),
      turns: result.session.turns ?? 0,
      requests: reqs.length,
      ms: reqs.reduce((n, r) => n + (r.durationMs ?? 0), 0),
      tokens: reqs.reduce((n, r) => n + renderer.tokens(r.usage).total, 0),
    });
  }

  await writeFile(join(target, "index.md"), renderIndex(rows, target));
  console.log(`Rendered ${rows.length} session(s). Start at ${join(target, "index.md")}`);
}

if (import.meta.filename === process.argv[1]) await main();
