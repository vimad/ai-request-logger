#!/usr/bin/env node
/**
 * Re-parses a log tree into Markdown:
 *
 *   node src/report.ts [logDir]
 *
 * The proxy already writes these files as it runs; this regenerates them for
 * logs captured earlier, or after you change the renderer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { renderIndex, renderRequest, renderSession, renderTurn, totalTokens } from "./markdown.ts";
import type { IndexRow } from "./markdown.ts";

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

/** Render every request in one turn directory, then the turn rollup. */
export async function renderTurnDir(turnDir: string): Promise<any | undefined> {
  const meta = readJson(join(turnDir, "turn.json"));
  if (!meta) return undefined;

  let prevMessageCount = 0;
  const reqDirs = dirsIn(turnDir, "req-");
  for (const name of reqDirs) {
    const dir = join(turnDir, name);
    const req = readJson(join(dir, "request.json"));
    if (!req) continue;
    const res = readJson(join(dir, "response.json")) ?? {};
    await writeFile(join(dir, "request.md"), renderRequest(req, res, { prevMessageCount }));
    const count = Array.isArray(req.body?.messages) ? req.body.messages.length : 0;
    // Only the main thread grows one conversation; a subagent or background
    // call has its own, so it must not be diffed against the thread's.
    if (count > 0 && !req.shape?.agentId && req.shape?.kind === "main") prevMessageCount = count;
  }

  let userInput = "";
  try {
    userInput = readFileSync(join(turnDir, "user-input.txt"), "utf8");
  } catch {}
  await writeFile(join(turnDir, "turn.md"), renderTurn(meta, userInput));
  return meta;
}

export async function renderSessionDir(sessionDir: string): Promise<any | undefined> {
  const session = readJson(join(sessionDir, "session.json"));
  if (!session) return undefined;

  const turns: Array<{ meta: any; dir: string }> = [];
  for (const name of dirsIn(sessionDir, "turn-")) {
    const meta = await renderTurnDir(join(sessionDir, name));
    if (meta) turns.push({ meta, dir: name });
  }
  await writeFile(join(sessionDir, "session.md"), renderSession(session, turns));
  return { session, turns };
}

async function main(): Promise<void> {
  const target = resolve(process.argv[2] ?? process.env.LOGGER_LOG_DIR ?? "log");
  if (!existsSync(target)) {
    console.error(`No such log directory: ${target}`);
    process.exit(1);
  }

  // Accept a whole log root, one session, or a single turn directory.
  if (existsSync(join(target, "turn.json"))) {
    await renderTurnDir(target);
    console.log(`Wrote turn.md and request.md files under ${target}`);
    return;
  }
  if (existsSync(join(target, "session.json"))) {
    await renderSessionDir(target);
    console.log(`Wrote session.md under ${target}`);
    return;
  }

  const rows: IndexRow[] = [];
  for (const name of readdirSync(target)) {
    const dir = join(target, name);
    if (!statSync(dir).isDirectory()) continue;
    const result = await renderSessionDir(dir);
    if (!result) continue;
    const reqs = result.turns.flatMap((t: any) => t.meta?.requests ?? []);
    rows.push({
      dir: basename(dir),
      turns: result.session.turns,
      requests: reqs.length,
      ms: reqs.reduce((n: number, r: any) => n + (r.durationMs ?? 0), 0),
      tokens: reqs.reduce((n: number, r: any) => n + totalTokens(r.usage), 0),
    });
  }

  await writeFile(join(target, "index.md"), renderIndex(rows, target));
  console.log(`Rendered ${rows.length} session(s). Start at ${join(target, "index.md")}`);
}

if (import.meta.filename === process.argv[1]) await main();
