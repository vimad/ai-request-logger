// Routing, the home page, the hero, and wiring the three sections together.

import { closeDrawer } from "./drawer.js";
import { inspector } from "./inspector.js";
import { matrix } from "./matrix.js";
import { theater } from "./theater.js";
import { clear, enrich, fmt, h, isBackground, promptTokens, s } from "./util.js";

const app = document.getElementById("app");
const crumbs = document.getElementById("crumbs");
const live = document.getElementById("live");
const help = document.getElementById("help");

let page = { stop() {}, onKey() { return false; } };
let poll = 0;

/* ---------------------------------------------------------------- chrome */

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("xray-theme", t);
  } catch {}
}
function currentTheme() {
  return document.documentElement.dataset.theme
    ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}
document.getElementById("theme-btn").onclick = () => setTheme(currentTheme() === "dark" ? "light" : "dark");
document.getElementById("help-btn").onclick = () => { help.hidden = false; };
help.addEventListener("click", (e) => {
  if (e.target === help || e.target.closest("[data-close-help]")) help.hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") {
    if (!help.hidden) return void (help.hidden = true);
    if (document.getElementById("drawer").classList.contains("open")) return void closeDrawer();
  }
  if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
  if (e.key === "?") return void (help.hidden = !help.hidden);
  if (e.key === "t" || e.key === "T") return void setTheme(currentTheme() === "dark" ? "light" : "dark");
  page.onKey(e);
});

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/* ---------------------------------------------------------------- router */

async function route() {
  page.stop();
  page = { stop() {}, onKey() { return false; } };
  clearInterval(poll);
  closeDrawer();
  live.hidden = true;
  const m = /^#\/turn\/([^/]+)\/([^/]+)/.exec(location.hash);
  if (m) await turnPage(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  else await homePage();
}
window.addEventListener("hashchange", route);
route();

/* ------------------------------------------------------------------ home */

function introArt() {
  const svg = s("svg", { viewBox: "0 0 400 300", class: "intro-art", "aria-hidden": "true" });
  const cats = ["system", "tools", "prompt", "reminder", "assistant", "thinking", "tool_use", "tool_result"];
  const rings = [60, 100, 140];
  rings.forEach((r, k) => {
    svg.append(s("circle", { cx: 200, cy: 150, r, fill: "none", stroke: "var(--line-2)", "stroke-dasharray": "2 6" }));
    const g = s("g", null);
    g.append(s("animateTransform", { attributeName: "transform", type: "rotate", from: `${k % 2 ? 360 : 0} 200 150`, to: `${k % 2 ? 0 : 360} 200 150`, dur: `${18 + k * 8}s`, repeatCount: "indefinite" }));
    for (let d = 0; d < 3 + k; d++) {
      const a = (d / (3 + k)) * Math.PI * 2 + k;
      g.append(s("circle", { cx: 200 + Math.cos(a) * r, cy: 150 + Math.sin(a) * r, r: 5 + (d % 2) * 2, fill: `var(--c-${cats[(d + k * 3) % cats.length]})` }));
    }
    svg.append(g);
  });
  svg.append(s("circle", { cx: 200, cy: 150, r: 30, fill: "var(--panel-2)", stroke: "var(--c-system)", "stroke-width": 2 }));
  svg.append(s("circle", { cx: 200, cy: 150, r: 9, fill: "var(--c-prompt)" }));
  return svg;
}

async function homePage() {
  crumbs.replaceChildren();
  const list = h("div", { class: "sessions" });
  let lastJson = "";
  const load = async () => {
    let data;
    try {
      data = await getJson("/api/sessions");
    } catch (err) {
      clear(list).append(h("div", { class: "warn" }, `Could not read the log directory: ${err.message}`));
      return;
    }
    const json = JSON.stringify(data.sessions);
    if (json === lastJson) return;
    lastJson = json;
    clear(list);
    if (!data.sessions.length) {
      list.append(h("div", { class: "panel empty" },
        h("h3", null, "No turns captured yet"),
        h("p", null, "Reading ", h("code", null, data.logDir)),
        h("p", null, "Start the proxy with ", h("code", null, "npm start"), " and run ", h("code", null, "ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude"), ", or ", h("code", null, "npm run start:codex"), " and run the ", h("code", null, "codex -c …"), " line it prints, or ", h("code", null, "npm run start:cursor"), " and ", h("code", null, "agent --endpoint http://127.0.0.1:8787"), ". Ask it something, and it will appear here on its own.")));
      return;
    }
    for (const sess of data.sessions) {
      const when = sess.startedAt ? new Date(sess.startedAt).toLocaleString() : "";
      list.append(h("div", { class: "panel session" },
        h("div", { class: "session-head" },
          h("h3", null, `session ${sess.id.slice(0, 8)}`),
          h("span", { class: "muted", style: { fontSize: "13px" } }, when),
          h("span", { class: `chip harness-${sess.supported ? sess.provider : "unknown"}` }, sess.harness ?? sess.provider),
          sess.supported ? null : h("span", { class: "muted", style: { fontSize: "12px" } }, "the visualizer does not understand this provider yet")),
        h("div", { class: "turns" }, sess.turns.map((t) => h("a", {
          class: "turn-card" + (sess.supported ? "" : " disabled"),
          href: `#/turn/${encodeURIComponent(sess.dir)}/${encodeURIComponent(t.dir)}`,
        },
          h("div", { class: "idx" }, `TURN ${String(t.index).padStart(2, "0")}`),
          h("div", { class: "q" }, t.label),
          h("div", { class: "meta" },
            h("span", null, `${t.main} lap${t.main === 1 ? "" : "s"}`),
            h("span", null, `${t.background} background`),
            t.tokens ? h("span", null, `${fmt.k(t.tokens)} tokens`) : null,
            h("span", null, fmt.ms(t.durationMs))),
          h("div", { class: "bars" },
            Array.from({ length: Math.min(40, t.main) }, (_, k) => h("i", { style: { height: `${40 + ((k * 37) % 60)}%` } })),
            Array.from({ length: Math.min(12, t.background) }, () => h("i", { class: "bg", style: { height: "35%" } }))))))));
    }
  };

  clear(app).append(
    h("div", { class: "intro" },
      h("div", null,
        h("h1", null, "What really happens when you ", h("em", null, "press Enter")),
        h("p", null, "Agent X-Ray replays a real Claude Code, Codex CLI or Cursor CLI turn from the proxy's logs. It shows the loop, the hidden system prompt, the tools, the context the harness injects, and the background calls you never see. It's built for explaining how a coding agent works."),
        h("p", { class: "how muted" },
          "1. ", h("code", null, "npm start"), "  2. ", h("code", null, "ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude"), "  (or ", h("code", null, "npm run start:codex"), " and the ", h("code", null, "codex -c …"), " line it prints, or ", h("code", null, "npm run start:cursor"), " and ", h("code", null, "agent --endpoint http://127.0.0.1:8787"), ")  3. ask it something, then pick the turn below.")),
      introArt()),
    list);
  await load();
  poll = setInterval(load, 4000);
}

/* ------------------------------------------------------------------ turn */

async function turnPage(sessionDir, turnDir) {
  clear(app).append(h("div", { class: "empty" }, "Reading the log…"));
  let raw;
  try {
    raw = await getJson(`/api/turn?session=${encodeURIComponent(sessionDir)}&turn=${encodeURIComponent(turnDir)}`);
  } catch (err) {
    clear(app).append(h("div", { class: "warn" }, `Could not load this turn: ${err.message}`), h("a", { href: "#/" }, "← back to all turns"));
    return;
  }
  const turn = enrich(raw);
  crumbs.replaceChildren(
    h("a", { href: "#/" }, "All turns"), h("span", { class: "sep" }, "›"),
    h("span", null, `session ${turn.session.id.slice(0, 8)}`), h("span", { class: "sep" }, "›"),
    h("span", { class: "here" }, `turn ${turn.turn.index} · ${turn.turn.label}`));

  if (!turn.requests.length) {
    clear(app).append(h("div", { class: "empty" }, "This turn has no requests."));
    return;
  }

  const ctx = {
    turn,
    backgroundTurnDir: raw.backgroundDir,
    selectRequest(key, tab) {
      closeDrawer();
      insp.select(key, tab);
      mat.select(key);
      insp.el.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  };

  const th = theater(ctx);
  const mat = matrix(ctx);
  const insp = inspector(ctx);
  mat.select(insp.key);

  clear(app).append(
    ...turn.warnings.map((w) => h("div", { class: "warn" }, w)),
    ...(turn.notes ?? []).map((n) => h("div", { class: "note" }, n)),
    hero(turn),
    th.el,
    mat.el,
    insp.el,
    h("p", { class: "faint", style: { marginTop: "40px", fontSize: "12px" } },
      `Rebuilt from ${turn.session.dir}/${turn.turn.dir}. Everything on this page comes from request.json, response.json and stream.jsonl.`));
  page = { stop: th.stop, onKey: th.onKey };

  // A turn still in progress keeps growing; offer a reload rather than
  // yanking the page out from under someone mid-explanation.
  const known = turn.requests.filter((r) => !r.fromBackground).length;
  poll = setInterval(async () => {
    try {
      const data = await getJson("/api/sessions");
      const t = data.sessions.find((x) => x.dir === sessionDir)?.turns.find((x) => x.dir === turnDir);
      if (t && t.requests !== known) {
        live.hidden = false;
        live.replaceChildren(h("a", { href: "#", onclick: (e) => { e.preventDefault(); route(); } }, `${t.requests - known} new request${t.requests - known === 1 ? "" : "s"} captured · reload`));
      }
    } catch {}
  }, 4000);
}

function hero(turn) {
  const reqs = turn.requests;
  const mains = reqs.filter((r) => !isBackground(r));
  const bgs = reqs.length - mains.length;
  const sent = reqs.reduce((n, r) => n + r.sentChars, 0);
  const typed = Math.max(1, turn.turn.userInput.length);
  const tin = reqs.reduce((n, r) => n + promptTokens(r.tokens), 0);
  const cacheRead = reqs.reduce((n, r) => n + (r.tokens?.cacheRead ?? 0), 0);
  const tout = reqs.reduce((n, r) => n + (r.tokens?.output ?? 0), 0);
  const think = reqs.reduce((n, r) => n + (r.thinkingTokens ?? 0), 0);

  const own = reqs.filter((r) => !r.fromBackground);
  const wallStart = Math.min(...own.map((r) => r.start));
  const wallEnd = Math.max(...own.map((r) => r.start + (r.durationMs ?? 0)));
  const modelMs = mains.reduce((n, r) => n + (r.durationMs ?? 0), 0);
  let localMs = 0;
  for (let k = 0; k + 1 < mains.length; k++) localMs += Math.max(0, mains[k + 1].start - (mains[k].start + (mains[k].durationMs ?? 0)));

  // Area-true circles: your prompt against everything that went over the wire.
  const R = 64;
  const r = Math.max(1.6, R * Math.sqrt(typed / Math.max(typed, sent)));
  const amp = h("div", { class: "amp" },
    (() => {
      const svg = s("svg", { width: 150, height: 140, viewBox: "0 0 150 140" });
      svg.append(s("circle", { cx: 80, cy: 70, r: R, fill: "color-mix(in srgb, var(--c-tools) 22%, transparent)", stroke: "var(--c-tools)" }));
      svg.append(s("circle", { cx: 80 - R + r + 10, cy: 70, r, fill: "var(--c-prompt)" },
        s("animate", { attributeName: "r", values: `${r};${r + 2.5};${r}`, dur: "1.6s", repeatCount: "indefinite" })));
      svg.append(s("line", { x1: 80 - R + r + 10, y1: 70 - r - 2, x2: 8, y2: 14, stroke: "var(--c-prompt)" }));
      svg.append(s("text", { x: 2, y: 10, style: "font: 700 10px var(--mono); fill: var(--c-prompt)" }, "you"));
      return svg;
    })(),
    h("div", { class: "amp-text" },
      h("strong", null, `${fmt.n(Math.round(sent / typed))}×`),
      `Your ${fmt.n(typed)} characters turned into `, h("b", null, fmt.chars(sent)), ` sent to the model across ${reqs.length} requests. The circles are drawn to scale by area.`));

  const bar = (parts) => h("div", { class: "mini" }, parts.map(([v, c]) => h("i", { style: { width: `${(v / Math.max(1, parts.reduce((n, p) => n + p[0], 0))) * 100}%`, background: c } })));
  const stat = (k, v, sub, extra) => h("div", { class: "panel stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), h("div", { class: "s" }, sub), extra);

  // Cursor reports only how full the context window was: no cache, no output.
  const contextOnly = turn.harness.usage === "context";
  const remote = turn.harness.remoteLoop;

  return h("div", { class: "hero" },
    h("div", { class: "panel prompt-card" },
      h("div", { class: "label" }, `Turn ${turn.turn.index} · you typed`),
      h("blockquote", null, turn.turn.userInput || turn.turn.label),
      amp),
    h("div", { class: "stats" },
      remote
        ? stat("Model calls", reqs.length, `${mains.length} agent-loop lap${mains.length === 1 ? "" : "s"}, made on ${remote} and rebuilt from the run stream`, bar([[mains.length, "var(--c-prompt)"], [bgs, "var(--c-bg)"]]))
        : stat("API requests", reqs.length, `${mains.length} agent-loop lap${mains.length === 1 ? "" : "s"} · ${bgs} background`, bar([[mains.length, "var(--c-prompt)"], [bgs, "var(--c-bg)"]])),
      contextOnly
        ? stat("Tokens read", fmt.k(tin), "the context size each lap, summed; no cache split is reported", bar([[tin, "var(--c-system)"]]))
        : stat("Tokens read", fmt.k(tin), `${tin ? Math.round((cacheRead / tin) * 100) : 0}% served from the prompt cache`, bar([[cacheRead, "var(--c-cache)"], [tin - cacheRead, "var(--c-system)"]])),
      contextOnly
        ? stat("Tokens written", "-", `${turn.harness.name} does not report output tokens`)
        : stat("Tokens written", fmt.n(tout), think ? `incl. ${fmt.n(think)} thinking` : "by the model, across every request", bar([[tout - think, "var(--c-assistant)"], [think, "var(--c-thinking)"]])),
      stat("Wall time", fmt.ms(wallEnd - wallStart), `model ${fmt.ms(modelMs)} · your machine ${fmt.ms(localMs)}`, bar([[modelMs, "var(--c-system)"], [localMs, "var(--c-tool_result)"]]))));
}

