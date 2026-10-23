// Records the README demo video: Agent X-Ray replaying the turn captured in
// demo/log, with captions, a highlight ring and a visible cursor injected into
// the page. Follows demo/video-script.md scene by scene.
//
//   cd demo && npm i && npm run record      → demo/out/demo.webm
//
// It starts its own proxies + X-Ray on spare ports (9787–9790) so a running
// `npm start` is left alone, and rewrites the ports it shows back to the
// defaults (8787–8790) so the video matches what a reader will see.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LOG = join(HERE, "log");
const OUT = join(HERE, "out");
const VIZ = "http://127.0.0.1:9790";
const W = 1600;
const H = 900;
const REPO = "github.com/vimad/ai-request-logger";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the server */

async function startServer() {
  const proc = spawn(process.execPath, ["src/index.ts", "--port", "9787", "--viz-port", "9790", "--log-dir", LOG, "--quiet=true"], { cwd: ROOT, stdio: "ignore" });
  for (let k = 0; k < 50; k++) {
    try {
      if ((await fetch(`${VIZ}/api/sessions`)).ok) return proc;
    } catch {}
    await wait(200);
  }
  proc.kill();
  throw new Error("Agent X-Ray did not start on :9790");
}

/* ------------------------------------------------------ in-page overlay */

// Runs in every document: a caption bar, a highlight ring and a fake cursor
// (Playwright's video leaves the real one out).
const OVERLAY = () => {
  const css = `
    #demo-cap { position: fixed; left: 50%; bottom: 44px; transform: translate(-50%, 20px); z-index: 99999;
      max-width: 1180px; padding: 18px 30px; border-radius: 16px; text-align: center; pointer-events: none;
      background: rgba(8,12,26,.88); border: 1px solid rgba(167,139,250,.45); box-shadow: 0 20px 60px rgba(0,0,0,.55);
      backdrop-filter: blur(8px); color: #f8fafc; font: 600 30px/1.3 -apple-system, "Inter", system-ui, sans-serif;
      opacity: 0; transition: opacity .35s, transform .35s; }
    #demo-cap.on { opacity: 1; transform: translate(-50%, 0); }
    #demo-cap small { display: block; margin-top: 6px; font-weight: 400; font-size: 20px; color: #a5b4fc; }
    #demo-ring { position: absolute; z-index: 99998; pointer-events: none; border-radius: 14px;
      border: 3px solid #f472b6; box-shadow: 0 0 0 9999px rgba(3,6,16,.45), 0 0 30px #f472b6;
      opacity: 0; transition: all .45s cubic-bezier(.2,.8,.2,1); }
    #demo-ring.on { opacity: 1; animation: demo-pulse 1.4s ease-in-out infinite; }
    @keyframes demo-pulse { 50% { box-shadow: 0 0 0 9999px rgba(3,6,16,.45), 0 0 50px 6px #f472b6; } }
    #demo-cursor { position: fixed; z-index: 100000; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
      background: rgba(255,255,255,.9); border: 2px solid #0b1020; box-shadow: 0 2px 10px rgba(0,0,0,.5);
      pointer-events: none; transition: transform .12s; left: -50px; top: -50px; }
    #demo-cursor.down { transform: scale(.7); background: #f472b6; }`;
  const mount = () => {
    if (document.getElementById("demo-cap")) return;
    const style = document.createElement("style");
    style.textContent = css;
    const cap = Object.assign(document.createElement("div"), { id: "demo-cap" });
    const ring = Object.assign(document.createElement("div"), { id: "demo-ring" });
    const cur = Object.assign(document.createElement("div"), { id: "demo-cursor" });
    document.documentElement.append(style, cap, ring, cur);
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => cur.classList.add("down"), true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
  };
  (window as any).__demo = {
    caption(text: string, sub?: string) {
      mount();
      const cap = document.getElementById("demo-cap")!;
      if (!text) return cap.classList.remove("on");
      cap.innerHTML = text + (sub ? `<small>${sub}</small>` : "");
      cap.classList.add("on");
    },
    ring(sel: string | null, pad = 8) {
      mount();
      const ring = document.getElementById("demo-ring")!;
      const el = sel ? document.querySelector(sel) : null;
      if (!el) return ring.classList.remove("on");
      const r = el.getBoundingClientRect();
      Object.assign(ring.style, { left: `${r.left + scrollX - pad}px`, top: `${r.top + scrollY - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      ring.classList.add("on");
    },
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount);
  else mount();
};

/* ---------------------------------------------------------------- helpers */

const caption = (p: Page, text: string, sub?: string) => p.evaluate(([t, s]) => (window as any).__demo.caption(t, s), [text, sub ?? ""]);
const ring = (p: Page, sel: string | null, pad?: number) => p.evaluate(([s, d]) => (window as any).__demo.ring(s, d), [sel, pad ?? 8] as const);

let mouse = { x: W / 2, y: H / 2 };
async function moveTo(p: Page, sel: string) {
  const box = await p.locator(sel).first().boundingBox();
  if (!box) throw new Error(`nothing to point at: ${sel}`);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 30);
  await p.mouse.move(x, y, { steps: 25 });
  mouse = { x, y };
}
async function click(p: Page, sel: string) {
  await moveTo(p, sel);
  await wait(150);
  await p.mouse.down();
  await wait(90);
  await p.mouse.up();
}
/** Smooth-scroll so `sel` sits `offset` px below the top of the viewport. */
async function scrollTo(p: Page, sel: string, offset = 70) {
  await p.evaluate(([s, o]) => {
    const el = document.querySelector(s as string)!;
    scrollTo({ top: el.getBoundingClientRect().top + scrollY - (o as number), behavior: "smooth" });
  }, [sel, offset]);
  await wait(1100);
}

/* ------------------------------------------------------- scripted pages */

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; height:100%; background: radial-gradient(900px 500px at 15% 20%, rgba(56,189,248,.12), transparent 60%),
    radial-gradient(900px 600px at 90% 90%, rgba(167,139,250,.14), transparent 60%), #080c1a; color:#e2e8f0;
    font-family: -apple-system, "Inter", system-ui, sans-serif; overflow:hidden; }
  .card { height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:26px; }
  h1 { margin:0; font-size:66px; line-height:1.12; letter-spacing:-.02em; max-width:1250px; }
  h1 em { font-style:normal; background: linear-gradient(90deg,#38bdf8,#a78bfa,#f472b6); -webkit-background-clip:text; color:transparent; }
  .sub { font-size:28px; color:#94a3b8; } code { font-family: ui-monospace, "SF Mono", Menlo, monospace; color:#7dd3fc; }
  .fade { animation: in .8s ease both; } .d1 { animation-delay:.5s } .d2 { animation-delay:1.1s }
  @keyframes in { from { opacity:0; transform: translateY(16px) } }
  .term { width:1240px; margin: 90px auto 0; border-radius:16px; background:#0b1020; border:1px solid #23304f;
    box-shadow: 0 30px 80px rgba(0,0,0,.6); overflow:hidden; }
  .term .bar { height:40px; display:flex; align-items:center; gap:8px; padding:0 16px; background:#111a33; }
  .term .bar i { width:13px; height:13px; border-radius:50%; } .term .bar span { margin-left:12px; color:#64748b; font: 14px ui-monospace, Menlo, monospace; }
  .term pre { margin:0; padding:26px 30px; min-height:420px; font: 21px/1.55 ui-monospace, "SF Mono", Menlo, monospace; color:#cbd5e1; white-space:pre; }
  .p { color:#a78bfa } .g { color:#4ade80 } .b { color:#38bdf8 } .y { color:#facc15 } .m { color:#64748b } .hl { background: rgba(244,114,182,.18); outline: 2px solid #f472b6; border-radius:6px; }
</style></head><body>${body}</body></html>`;

const terminal = (title: string) => page(`<div class="term"><div class="bar"><i style="background:#f87171"></i><i style="background:#facc15"></i><i style="background:#4ade80"></i><span>${title}</span></div><pre id="t"></pre></div>`);

/** Types `cmd` after a prompt, then prints `out` line by line. */
async function typeInTerminal(p: Page, cmd: string, out: string[], lineMs = 70) {
  const pre = p.locator("#t");
  await pre.evaluate((el) => { el.innerHTML = '<span class="p">❯</span> '; });
  for (const ch of cmd) {
    await pre.evaluate((el, c) => { el.innerHTML += c; }, ch);
    await wait(38);
  }
  await wait(350);
  for (const line of out) {
    await pre.evaluate((el, l) => { el.innerHTML += "\n" + l; }, line);
    await wait(lineMs);
  }
}

/** The demo log tree, as `tree -L 4` would print it, request dirs trimmed to three. */
function logTree(): string[] {
  const lines = ["log/", "├── index.md", "├── index.jsonl"];
  const sessions = readdirSync(LOG).filter((d) => d.includes("__session-") && !d.includes("non-messages"));
  let expanded = 0;
  const walk = (dir: string, prefix: string, depth: number) => {
    const kids = readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
    kids.forEach((n, k) => {
      const last = k === kids.length - 1;
      const full = join(dir, n);
      const isDir = statSync(full).isDirectory();
      const name = n.replace(/session-([0-9a-f]{8})[0-9a-f-]+/, "session-$1…");
      const color = isDir ? `<span class="b">${name}/</span>` : /request\.md|turn\.md|session\.md/.test(n) ? `<span class="g">${name}</span>` : name;
      lines.push(`${prefix}${last ? "└── " : "├── "}${color}`);
      // Expand only the first request directory; the rest stay one line each.
      const expand = depth < 2 || (depth === 2 && !expanded++);
      if (isDir && expand) walk(full, prefix + (last ? "    " : "│   "), depth + 1);
    });
  };
  for (const s of sessions) {
    lines.push(`└── <span class="b">${s.replace(/session-([0-9a-f]{8})[0-9a-f-]+/, "session-$1…")}/</span>`);
    walk(join(LOG, s), "    ", 1);
  }
  return lines.filter((l) => !/stream\.jsonl/.test(l));
}

/* ------------------------------------------------------------------ main */

async function main() {
  const server = await startServer();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  await ctx.addInitScript(OVERLAY);
  // Show the default ports, not the spare ones this script runs on.
  await ctx.route(`${VIZ}/api/connect`, async (route) => {
    const res = await route.fetch();
    const text = (await res.text()).replace(/97(8[789]|90)/g, "87$1").replace(/demo\/log/g, "log");
    await route.fulfill({ response: res, body: text });
  });
  // Keep the connect panel on Claude Code first.
  await ctx.addInitScript(() => { try { localStorage.setItem("xray-connect-tab", "claude"); localStorage.setItem("xray-tab", "conversation"); } catch {} });

  const p = await ctx.newPage();

  // 1 — the hook
  await p.setContent(page(`<div class="card">
    <h1 class="fade">What does your AI coding agent<br><em>actually</em> send to the model?</h1>
    <div class="sub fade d1"><code>ai-request-logger</code> · zero dependencies · one command</div></div>`));
  await wait(4200);

  // 2 — one command
  await p.setContent(terminal("~/ai-request-logger — zsh"));
  await p.mouse.move(-20, -20);
  await typeInTerminal(p, "npm start", [
    "",
    '<span class="m">ai-request-logger · logging to log/</span>',
    "",
    '  <span class="y">Claude Code</span>  <span class="b">http://127.0.0.1:8787</span>',
    '  <span class="y">Cursor CLI </span>  <span class="b">http://127.0.0.1:8788</span>',
    '  <span class="y">Codex CLI  </span>  <span class="b">http://127.0.0.1:8789</span>',
    '  <span class="y">Agent X-Ray</span>  <span class="b">http://127.0.0.1:8790</span>',
    "",
    '<span class="m">Point your agent at its proxy:</span>',
    '  <span id="cmd">ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude</span>',
  ]);
  await caption(p, "A transparent proxy for Claude Code, Cursor CLI and Codex CLI.", "No install. No build. Just point your agent at it.");
  await wait(600);
  await p.evaluate(() => document.getElementById("cmd")!.classList.add("hl"));
  await wait(3600);

  // 3 — X-Ray home
  await p.goto(VIZ + "/");
  await p.waitForSelector(".turn-card");
  await p.mouse.move(W / 2, H / 2);
  await wait(900);
  await scrollTo(p, "details.connect", 160);
  await click(p, "details.connect summary");
  await wait(600);
  await caption(p, "One proxy per agent. Copy the command, run your agent as usual.");
  for (const id of ["cursor", "codex", "claude"]) {
    await click(p, `details.connect .tab[data-id="${id}"]`);
    await wait(900);
  }
  await click(p, "details.connect summary");
  await wait(500);
  await scrollTo(p, ".session", 200);
  await ring(p, ".turn-card");
  await caption(p, "Every session, every turn: captured as you work.");
  await wait(2400);
  await ring(p, null);

  // 4 — the hero
  await click(p, ".turn-card");
  await p.waitForSelector(".hero");
  await p.evaluate(() => scrollTo(0, 0));
  await caption(p, "");
  await wait(900);
  await ring(p, ".prompt-card blockquote");
  await caption(p, "You typed one line…");
  await wait(2000);
  await ring(p, ".amp");
  await caption(p, "…and this is what was sent to the model.", "Every request, every token, every second, drawn to scale.");
  await wait(3200);
  await ring(p, null);

  // 5 — the agent loop
  await scrollTo(p, ".theater", 70);
  await caption(p, "Watch the agent loop: think → call a tool → read the result → think again.");
  await click(p, ".theater .play");
  await p.keyboard.press("3"); // 2×
  await wait(5000);
  await ring(p, ".theater .panel.stack");
  await caption(p, "Every lap re-sends the whole conversation.", "Each block is marked re-sent, echoed, or new.");
  await wait(6000);
  await ring(p, null);

  // 6 — every request carries everything
  await p.keyboard.press("Space"); // pause the loop
  await caption(p, "");
  const matrix = ".matrix-wrap";
  await scrollTo(p, matrix, 70);
  await ring(p, `${matrix} .matrix-scroll`, 4);
  await caption(p, "Most of the bytes on the wire are repeats.", "Bands join blocks that are byte-for-byte identical to the last request.");
  await wait(4800);
  await ring(p, null);

  // 7 — the inspector
  await caption(p, "");
  await scrollTo(p, ".filmstrip", 150);
  await caption(p, "The full system prompt. Every tool. Every hidden reminder the harness injects.");
  const tabs = ".tabs .tab";
  for (const label of ["System prompt", "Tools", "Skills", "Response", "Conversation"]) {
    await click(p, `${tabs}:has-text("${label}")`);
    await wait(1500);
  }
  // Open one injected block in the drawer.
  const injected = ".convo .blk-head";
  if (await p.locator(injected).count()) {
    await click(p, `${injected} .icon-btn`);
    await wait(500);
    await caption(p, "Click anything to see who wrote it, and every request that carried it.");
    await wait(3000);
    await p.keyboard.press("Escape");
  }
  await wait(400);

  // 8 — it's all just files
  await p.setContent(terminal("~/ai-request-logger — zsh"));
  await p.mouse.move(-20, -20);
  await typeInTerminal(p, "tree log", logTree(), 55);
  await caption(p, "Plain JSON + Markdown on disk.", "Grep it, diff it, open it in any editor.");
  await wait(3800);

  // 9 — outro
  await p.setContent(page(`<div class="card">
    <h1 class="fade"><em>ai-request-logger</em></h1>
    <div class="sub fade d1"><code>${REPO}</code></div>
    <div class="sub fade d2">Node 22.18+ · <code>npm start</code></div></div>`));
  await wait(4000);

  const video = p.video();
  await ctx.close();
  await browser.close();
  server.kill();
  const file = await video!.path();
  const dest = join(OUT, "demo.webm");
  renameSync(file, dest);
  console.log(`wrote ${relative(process.cwd(), dest)}`);
}

await main();
