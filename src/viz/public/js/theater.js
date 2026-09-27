// "The agent loop": an animated stage that replays one turn step by step,
// with a live view of what the current request carries and a real-time Gantt.

import {
  CATS, catVar, chip, clear, esc, fmt, groupsOf, h, isBackground, promptTokens, purposeColor, s, store,
} from "./util.js";
import { openBlob } from "./drawer.js";

const BASE = { prompt: 2400, send: 2300, think: 2000, reply: 2000, tool: 2800, answer: 2400, bg: 2800 };
const PAUSE = 1500;

/* ------------------------------------------------------------------ steps */

function toolCalls(turn, r) {
  return r.response.map((x) => turn.blobs[x.b]).filter((b) => b?.cat === "tool_use");
}

function isMain(r) {
  return r.kind === "main" && !r.agentId;
}

function buildSteps(turn) {
  const steps = [];
  const reqs = turn.requests;
  const mains = reqs.filter(isMain);
  const lastMain = mains[mains.length - 1];
  // Calls made well before the prompt (startup probes while you were still
  // typing) play first; everything else follows the prompt in real order.
  const promptAt = (mains[0]?.start ?? 0) - 1500;
  let prompted = false;
  let lap = 0;
  for (const r of reqs) {
    if (!prompted && (isMain(r) || r.start >= promptAt)) {
      steps.push({ type: "prompt" });
      prompted = true;
    }
    if (!isMain(r)) {
      const overlapping = mains.some((m) => m.start < r.start + (r.durationMs ?? 0) && r.start < m.start + (m.durationMs ?? 0));
      steps.push({ type: "bg", r, overlapping, lap, early: !prompted });
      continue;
    }
    lap++;
    steps.push({ type: "send", r, lap }, { type: "think", r, lap }, { type: "reply", r, lap });
    const calls = toolCalls(turn, r);
    const next = mains[mains.indexOf(r) + 1];
    if (r.stop === "tool_use" && calls.length) steps.push({ type: "tool", r, lap, calls, next });
    if (r === lastMain) steps.push({ type: "answer", r, lap });
  }
  if (!prompted) steps.push({ type: "prompt" });
  if (!lastMain) steps.push({ type: "answer", r: undefined, lap });
  return steps;
}

/* -------------------------------------------------------------- narration */

function share(part, whole) {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  // 99.6% is not 100%: the difference is the whole point of the view.
  if (p > 99 && p < 100) return p.toFixed(1) + "%";
  return p < 0.1 ? "<0.1%" : p < 1 ? p.toFixed(1) + "%" : Math.round(p) + "%";
}

function narrate(turn, step) {
  const r = step.r;
  const who = turn.harness.name;
  // Where the loop runs: on your machine (Claude Code, Codex) or on the
  // vendor's servers (Cursor), and whether token counts are billing or context.
  const remote = turn.harness.remoteLoop;
  const contextOnly = turn.harness.usage === "context";
  const out = (t) => (contextOnly ? "" : ` ${fmt.n(t?.output)} tokens out`);
  const stopCode = `<code>${esc(turn.harness.stopField)}: ${esc(r?.stopReason ?? r?.stop ?? "")}</code>`;
  const tok = (chars) => fmt.k(chars * turn.tokPerChar);
  const mains = turn.requests.filter(isMain);
  switch (step.type) {
    case "prompt": {
      const n = turn.turn.userInput.length;
      const bg = turn.requests.length - mains.length;
      return {
        title: "You type a prompt and press Enter",
        body: `<b>${fmt.n(n)} characters.</b> Everything that follows (${mains.length} trip${mains.length === 1 ? "" : "s"} round the agent loop and ${bg} background call${bg === 1 ? "" : "s"}) is ${who} turning those characters into work.`,
      };
    }
    case "send": {
      const groups = groupsOf(r, turn.blobs);
      const sys = groups.find((g) => g.id === "system");
      const tools = groups.find((g) => g.id === "tools");
      const promptChars = r.messages.flatMap((m) => m.refs).map((x) => turn.blobs[x.b]).filter((b) => b?.cat === "prompt").reduce((n, b) => n + b.chars, 0);
      if (!r.diff.hasPrev) {
        const reminders = r.messages.flatMap((m) => m.refs).filter((x) => turn.blobs[x.b]?.cat === "reminder").length;
        return {
          title: `Lap ${step.lap} · ${remote ? `${who}'s server` : who} packs the first request`,
          body: `It is much more than your prompt: the <b>system prompt</b> (${fmt.chars(sys?.chars ?? 0)}), <b>${r.tools.length} tool definitions</b> (${fmt.chars(tools?.chars ?? 0)}) and the conversation, where your prompt sits next to <b>${reminders} block${reminders === 1 ? "" : "s"} of injected context</b>. About <b>${tok(r.sentChars)} tokens</b> in all. Your own words are <b>${share(promptChars, r.sentChars)}</b> of it.`,
        };
      }
      const newBits = [];
      const counts = {};
      for (const ref of r.messages.flatMap((m) => m.refs)) {
        const st = r.diff.status.get(ref.b);
        if (st === "carried") continue;
        const cat = turn.blobs[ref.b]?.cat;
        const key = st === "echo" ? `echo:${cat}` : cat;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      const words = {
        "echo:tool_use": "the model's own tool call, echoed back",
        "echo:thinking": "its thinking, echoed back",
        "echo:assistant": "its own text, echoed back",
        tool_result: "the tool output",
        reminder: "fresh injected context",
        prompt: "your prompt",
        synthetic: "a harness prompt",
        assistant: "model text",
        tool_use: "a tool call",
        thinking: "thinking",
      };
      for (const [k, n] of Object.entries(counts)) newBits.push(`${words[k] ?? k}${n > 1 ? ` ×${n}` : ""}`);
      return {
        title: `Lap ${step.lap} · Everything again, plus what's new`,
        body: `The model kept nothing from the last lap, so ${remote ? `${who}'s server` : who} sends the whole thing again: <b>${share(r.diff.carriedChars, r.sentChars)}</b> of this request is exactly what it sent last time. New this lap: <b>${newBits.join(" · ") || "nothing"}</b>. This is how an agent "remembers".${remote ? ` Your machine never sees this request: ${who} keeps the conversation on ${remote} and streams down only the new pieces.` : ""}`,
      };
    }
    case "think": {
      const t = r.tokens;
      if (!t) return { title: "The model reads the request", body: `No usage was reported for this call${r.status ? ` (HTTP ${r.status})` : ""}.${r.ttfbMs ? ` First output after <b>${fmt.ms(r.ttfbMs)}</b>.` : ""}` };
      const total = promptTokens(t);
      if (contextOnly) {
        return {
          title: `The model reads ${fmt.n(total)} tokens`,
          body: `That is how full ${who} says the context window was${r.params.contextWindow ? ` (${esc(r.params.contextWindow)})` : ""}. ${who} reports no cache or billing split, so there is nothing to say about what was cached.${r.ttfbMs ? ` First output after <b>${fmt.ms(r.ttfbMs)}</b>.` : ""}`,
        };
      }
      const fresh = t.input + t.cacheWrite;
      return {
        title: `The model reads ${fmt.n(total)} tokens`,
        body: t.cacheRead > 0
          ? `<b>${fmt.n(t.cacheRead)}</b> (${share(t.cacheRead, total)}) come straight from the <b>prompt cache</b>, because the start of the request is byte-for-byte what was sent before. Only <b>${fmt.n(fresh)}</b> are new. First byte back after <b>${fmt.ms(r.ttfbMs)}</b>.`
          : `Nothing is cached yet, so all of it is processed and <b>${fmt.n(t.cacheWrite)}</b> tokens are written to the prompt cache for the next lap to reuse. First byte back after <b>${fmt.ms(r.ttfbMs)}</b>.`,
      };
    }
    case "reply": {
      const t = r.tokens;
      const think = r.thinkingTokens ? ` It reasoned first (${fmt.n(r.thinkingTokens)} thinking tokens).` : "";
      if (r.status && r.status >= 400) {
        return { title: `The API refused: HTTP ${r.status}`, body: `No answer this time. ${who} will usually retry. ${esc(JSON.stringify(r.responseRaw ?? r.error ?? "")).slice(0, 200)}` };
      }
      if (r.stop === "tool_use") {
        const names = [...new Set(toolCalls(turn, r).map((b) => b.name))].join(", ");
        return {
          title: `It answers with a tool call: ${names}`,
          body: remote
            ? `${stopCode}. The model can't touch your machine, and here neither can ${remote}: the server sends the call down the stream to the CLI.${think}${out(t)}${contextOnly ? "" : "."} In ${fmt.ms(r.durationMs)}.`
            : `${stopCode}. The model can't touch your machine, so it asks ${who} to run something for it.${think}${out(t)}, in ${fmt.ms(r.durationMs)}.`,
        };
      }
      if (r.stop === "end_turn") {
        return { title: "It answers in plain text", body: `${stopCode}. There's no tool call this time, so the loop stops here.${think}${out(t)}${contextOnly ? "" : "."}` };
      }
      return { title: `The stream ends: ${r.stopReason ?? "no stop reason"}`, body: contextOnly ? `In ${fmt.ms(r.durationMs)}.` : `${fmt.n(t?.output)} tokens out.` };
    }
    case "tool": {
      const gap = step.next ? step.next.start - (r.start + (r.durationMs ?? 0)) : undefined;
      const outChars = step.next
        ? step.next.messages.flatMap((m) => m.refs).map((x) => turn.blobs[x.b]).filter((b) => b?.cat === "tool_result" && step.calls.some((c) => c.toolUseId === b.toolUseId)).reduce((n, b) => n + b.chars, 0)
        : 0;
      const list = step.calls.map((c) => `<code>${esc(c.label)}</code>`).join(", ");
      const names = [...new Set(step.calls.map((c) => c.name))].join(" + ");
      return {
        title: remote ? `Your machine runs ${names} for ${who}` : `${who} runs ${names} on your machine`,
        body: `${list}. ${remote ? `The CLI uploads the output${outChars ? ` (${fmt.chars(outChars)})` : ""} and ${who}'s server puts it on the end of the conversation.` : `The output${outChars ? ` (${fmt.chars(outChars)})` : ""} goes onto the end of the conversation.`}${gap !== undefined ? ` Time on your side before the next lap: <b>${fmt.ms(gap)}</b>${gap > 4000 ? ", which includes you answering any permission prompt" : ""}.` : ""}`,
      };
    }
    case "answer": {
      const tIn = mains.reduce((n, x) => n + promptTokens(x.tokens), 0);
      const tOut = mains.reduce((n, x) => n + (x.tokens?.output ?? 0), 0);
      return {
        title: "The answer lands in your terminal",
        body: `${mains.length} lap${mains.length === 1 ? "" : "s"}: <b>${fmt.n(tIn)}</b> tokens read${contextOnly ? ` (${who} does not report output tokens)` : `, <b>${fmt.n(tOut)}</b> written`}. You see one reply. The model read the whole conversation ${mains.length} time${mains.length === 1 ? "" : "s"} to write it.`,
      };
    }
    case "bg": {
      const reply = r.response.map((x) => turn.blobs[x.b]).find((b) => b?.cat === "assistant");
      const status = r.status && r.status >= 400 ? ` Response: HTTP ${r.status}.` : "";
      return {
        title: `${step.early ? "At startup" : step.overlapping ? "Meanwhile" : "Behind the scenes"}: ${r.purpose.label}`,
        body: `${esc(r.purpose.explain)} Sent about <b>${tok(r.sentChars)} tokens</b>${r.tools.length ? `, <b>including all ${r.tools.length} tool definitions</b>` : " with no tools"}.${reply ? ` The reply: <b>“${esc(reply.text.slice(0, 120))}”</b>.` : ""}${status}`,
      };
    }
  }
  return { title: "", body: "" };
}

/* ------------------------------------------------------------------ stage */

function stageSvg(info) {
  const box = (x, y, w, hh, cls = "node-box") => s("rect", { x, y, width: w, height: hh, rx: 18, class: cls });
  const svg = s("svg", { viewBox: "0 0 1000 560", role: "img", "aria-label": "Agent loop animation" });
  const defs = s("defs", null,
    s("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
      s("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--line-2)" })),
    s("radialGradient", { id: "brain" }, s("stop", { offset: "0%", "stop-color": "var(--c-system)", "stop-opacity": 0.55 }), s("stop", { offset: "100%", "stop-color": "var(--c-system)", "stop-opacity": 0 })),
  );
  svg.append(defs);

  const P = {
    user: s("path", { d: "M141,300 L235,300", class: "wire", "marker-end": "url(#arrow)" }),
    req: s("path", { d: "M535,275 C620,250 690,250 770,275", class: "wire", "marker-end": "url(#arrow)" }),
    res: s("path", { d: "M770,328 C690,352 620,352 535,328", class: "wire", "marker-end": "url(#arrow)" }),
    down: s("path", { d: "M330,385 L330,440", class: "wire", "marker-end": "url(#arrow)" }),
    up: s("path", { d: "M440,440 L440,385", class: "wire", "marker-end": "url(#arrow)" }),
    bg: s("path", { d: "M420,215 C455,70 790,70 850,215", class: "wire bg" }),
  };
  svg.append(...Object.values(P));
  svg.append(
    s("text", { x: 652, y: 243, class: "wire-label", "text-anchor": "middle" }, "request →"),
    s("text", { x: 652, y: 372, class: "wire-label", "text-anchor": "middle" }, "← streamed reply"),
    s("text", { x: 636, y: 100, class: "bg-tag", "text-anchor": "middle" }, "BACKGROUND CALLS"),
    s("text", { x: 188, y: 290, class: "wire-label", "text-anchor": "middle" }, "prompt"),
    s("text", { x: 318, y: 418, class: "wire-label", "text-anchor": "end" }, "run"),
    s("text", { x: 452, y: 418, class: "wire-label" }, "output"),
  );

  // You
  const you = s("g", null,
    s("circle", { cx: 95, cy: 300, r: 46, class: "node-box" }),
    s("circle", { cx: 95, cy: 286, r: 13, fill: "var(--c-prompt)" }),
    s("path", { d: "M70,327 C72,305 118,305 120,327 Z", fill: "var(--c-prompt)" }),
    s("text", { x: 95, y: 370, class: "node-title", "text-anchor": "middle" }, "You"),
    s("text", { x: 95, y: 388, class: "node-sub", "text-anchor": "middle" }, "in the terminal"),
  );

  // Harness
  const harnessBox = box(235, 215, 300, 170);
  const lap = s("text", { x: 252, y: 344, class: "lap" }, "");
  const status = s("text", { x: 252, y: 370, class: "node-mono" }, "idle");
  const tower = s("g");
  const harness = s("g", null, harnessBox, lap,
    s("text", { x: 252, y: 247, class: "node-title" }, info.name),
    s("text", { x: 252, y: 266, class: "node-sub" }, info.remoteLoop ? `the agent · runs on ${info.remoteLoop}` : "the harness · runs on your laptop"),
    s("text", { x: 252, y: 284, class: "node-sub" }, info.remoteLoop ? "keeps the conversation · your CLI shows it" : "keeps the conversation"),
    s("rect", { x: 486, y: 228, width: 34, height: 144, rx: 6, fill: "var(--line)" }),
    tower, status);

  // Model
  const modelBox = box(770, 215, 200, 170);
  const pulses = [1, 2, 3].map((i) => s("circle", { cx: 870, cy: 316, r: 30, class: `pulse p${i}`, "stroke-width": 2 }));
  const nodes = s("g", { class: "brain-nodes" });
  const pts = [[850, 300], [890, 298], [870, 318], [846, 332], [894, 334], [870, 342]];
  for (const [a, b] of [[0, 1], [0, 2], [1, 2], [2, 3], [2, 4], [3, 5], [4, 5], [0, 3], [1, 4]]) {
    nodes.append(s("line", { x1: pts[a][0], y1: pts[a][1], x2: pts[b][0], y2: pts[b][1], stroke: "var(--c-system)", "stroke-opacity": 0.5 }));
  }
  pts.forEach(([x, y], i) => nodes.append(s("circle", { cx: x, cy: y, r: 4.5, fill: "var(--c-system)", class: `bn bn${i}` })));
  const readBg = s("rect", { x: 790, y: 360, width: 160, height: 7, rx: 3.5, fill: "var(--line)" });
  const readCache = s("rect", { x: 790, y: 360, width: 0, height: 7, rx: 3.5, fill: "var(--c-cache)" });
  const readFresh = s("rect", { x: 790, y: 360, width: 0, height: 7, rx: 3.5, fill: "var(--c-system)" });
  const readText = s("text", { x: 790, y: 380, class: "node-mono" }, "");
  const modelName = s("text", { x: 787, y: 266, class: "node-sub" }, "");
  const model = s("g", null, modelBox,
    s("circle", { cx: 870, cy: 318, r: 44, fill: "url(#brain)" }),
    ...pulses, nodes,
    s("text", { x: 787, y: 247, class: "node-title" }, info.api),
    modelName,
    s("text", { x: 953, y: 247, class: "node-mono", "text-anchor": "end" }, "stateless"),
    readBg, readCache, readFresh, readText);

  // Tools terminal
  const termBox = s("rect", { x: 235, y: 440, width: 300, height: 104, rx: 12, class: "term-box" });
  const term1 = s("text", { x: 250, y: 492, class: "term-text" }, "");
  const term2 = s("text", { x: 250, y: 514, class: "term-dim" }, "");
  const term3 = s("text", { x: 250, y: 534, class: "term-dim" }, "");
  const tools = s("g", null, termBox,
    s("circle", { cx: 252, cy: 456, r: 4, fill: "#f87171" }), s("circle", { cx: 266, cy: 456, r: 4, fill: "#fbbf24" }), s("circle", { cx: 280, cy: 456, r: 4, fill: "#34d399" }),
    s("text", { x: 520, y: 460, class: "term-dim", "text-anchor": "end" }, "your machine · tools run here"),
    term1, term2, term3);

  svg.append(you, harness, model, tools);
  const packets = s("g");
  svg.append(packets);

  return {
    svg, P, packets, tower, status, lap, harnessBox, modelBox, termBox, term1, term2, term3,
    readCache, readFresh, readText, modelName, nodes,
  };
}

/* --------------------------------------------------------------- the view */

export function theater(ctx) {
  const { turn } = ctx;
  const contextOnly = turn.harness.usage === "context";
  const steps = buildSteps(turn);
  const st = stageSvg(turn.harness);
  const maxChars = Math.max(1, ...turn.requests.map((r) => r.sentChars));

  let i = 0;
  let playing = false;
  let speed = store.get("xray-speed", 1);
  let narrationOn = store.get("xray-narration", true);
  let token = 0;
  let timer = 0;
  let played = false;

  /* ---- animation primitives, all cancellable by bumping `token` */

  const alive = (t) => t === token;
  const wait = (ms, t) => new Promise((res) => setTimeout(() => res(alive(t)), ms / speed));
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  function along(el, path, ms, t, { reverse = false } = {}) {
    const len = path.getTotalLength();
    const dur = ms / speed;
    return new Promise((res) => {
      const t0 = performance.now();
      const frame = (now) => {
        if (!alive(t)) return res(false);
        const k = Math.min(1, (now - t0) / dur);
        const p = path.getPointAtLength(len * (reverse ? 1 - ease(k) : ease(k)));
        el.setAttribute("transform", `translate(${p.x},${p.y})`);
        if (k < 1) requestAnimationFrame(frame);
        else res(true);
      };
      requestAnimationFrame(frame);
    });
  }

  function tweenNum(ms, t, fn) {
    const dur = ms / speed;
    return new Promise((res) => {
      const t0 = performance.now();
      const frame = (now) => {
        if (!alive(t)) return res(false);
        const k = Math.min(1, (now - t0) / dur);
        fn(ease(k));
        if (k < 1) requestAnimationFrame(frame);
        else res(true);
      };
      requestAnimationFrame(frame);
    });
  }

  /* ---- packets */

  function envelope(r) {
    const groups = groupsOf(r, turn.blobs);
    const w = 56 + 110 * Math.sqrt(r.sentChars / maxChars);
    const g = s("g");
    g.append(s("rect", { x: -w / 2 - 4, y: -15, width: w + 8, height: 30, rx: 8, fill: "var(--panel)", stroke: "var(--text)", "stroke-width": 1.5 }));
    let x = -w / 2;
    for (const gr of groups) {
      const gw = Math.max(2, (gr.chars / Math.max(1, r.sentChars)) * w);
      g.append(s("rect", { x, y: -10, width: gw, height: 20, fill: catVar(gr.cat), rx: 2 }));
      x += gw;
    }
    g.append(s("text", { x: 0, y: -24, class: "packet-label", "text-anchor": "middle" }, `${r.key} · ≈${fmt.k(r.sentChars * turn.tokPerChar)} tokens`));
    return g;
  }

  function pill(text, color, dark = true) {
    const w = Math.min(260, 20 + text.length * 7.2);
    return s("g", null,
      s("rect", { x: -w / 2, y: -13, width: w, height: 26, rx: 13, fill: color }),
      s("text", { x: 0, y: 4.5, "text-anchor": "middle", style: `font: 700 12px var(--sans); fill: ${dark ? "#0b1020" : "var(--text)"}` }, text));
  }

  /* ---- static scene for a step */

  function drawTower(r, flashNew) {
    clear(st.tower);
    if (!r) return;
    const groups = groupsOf(r, turn.blobs);
    const H = 144;
    const total = Math.max(1, r.sentChars);
    let y = 228 + H;
    const minH = 2.5;
    const hs = groups.map((g) => Math.max(minH, (g.chars / total) * H));
    const scale = H / Math.max(H, hs.reduce((a, b) => a + b, 0));
    groups.forEach((g, k) => {
      const gh = hs[k] * scale;
      y -= gh;
      const isNew = flashNew && g.refs.some((x) => ["new", "echo"].includes(r.diff.status.get(x.b)));
      const rect = s("rect", { x: 488, y: y + 0.5, width: 30, height: Math.max(1, gh - 1), fill: catVar(g.cat), rx: 2 });
      if (isNew) rect.animate([{ opacity: 0.2 }, { opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 900 / speed });
      st.tower.append(rect);
    });
  }

  function lastMainBefore(k) {
    for (let j = k; j >= 0; j--) {
      const sj = steps[j];
      if (sj.r && isMain(sj.r) && sj.type !== "prompt") return sj.type === "tool" && j < k && sj.next ? sj.next : sj.r;
    }
    return undefined;
  }

  function scene(k) {
    const step = steps[k];
    const r = step.r;
    clear(st.packets);
    st.svg.parentElement.classList.remove("thinking");
    for (const b of [st.harnessBox, st.modelBox, st.termBox]) b.classList.remove("active-box");
    st.readCache.setAttribute("width", 0);
    st.readFresh.setAttribute("width", 0);
    st.readFresh.setAttribute("x", 790);
    st.readText.textContent = "";
    st.modelName.textContent = (r?.model ?? turn.requests.find(isMain)?.model ?? "");

    const mainNow = step.type === "bg" ? lastMainBefore(k) : r;
    drawTower(mainNow && isMain(mainNow) ? mainNow : lastMainBefore(k), false);
    st.lap.textContent = step.lap ? `LAP ${step.lap}` : "";

    const statusText = {
      prompt: "reading your prompt…",
      send: "sending request…",
      think: "waiting for the model…",
      reply: "reading the stream…",
      tool: "running tools…",
      answer: "done · waiting for you",
      bg: `background: ${r?.purpose.label.toLowerCase() ?? ""}`,
    }[step.type];
    st.status.textContent = statusText ?? "";

    // The terminal keeps the last tool run on screen, dimmed.
    const prevTool = [...steps.slice(0, k + 1)].reverse().find((x) => x.type === "tool");
    st.term1.textContent = prevTool && step.type !== "tool" ? `$ ${prevTool.calls[0].label}`.slice(0, 38) : step.type === "tool" ? "" : "$ _";
    st.term1.style.opacity = step.type === "tool" ? 1 : 0.45;
    st.term2.textContent = "";
    st.term3.textContent = "";

    youBubble.classList.toggle("show", steps.slice(0, k + 1).some((x) => x.type === "prompt"));
    answerBubble.classList.toggle("show", steps.slice(0, k + 1).some((x) => x.type === "answer"));

    if (step.type === "think" && r) {
      st.modelBox.classList.add("active-box");
      st.svg.parentElement.classList.add("thinking");
    }
    const n = narrate(turn, step);
    narrH.innerHTML = n.title;
    if (r && step.type !== "prompt") narrH.append(" ", chipFor(r));
    narrP.innerHTML = n.body;
    narration.classList.toggle("hidden-text", !narrationOn);

    // Progress + suitcase + gantt follow the step.
    [...progress.children].forEach((el, j) => {
      el.classList.toggle("done", j < k);
      el.classList.toggle("now", j === k);
    });
    stepCount.textContent = `${k + 1} / ${steps.length}`;
    renderSuitcase(step.type === "prompt" ? undefined : r, step);
    gantt.mark(r?.key, step.type);
  }

  function chipFor(r) {
    return h("span", { class: "chip", style: { "--c": purposeColor(r.purpose) } }, `${r.key} · ${r.purpose.label}`);
  }

  /* ---- step animations */

  async function play(k, t) {
    const step = steps[k];
    const r = step.r;
    const base = BASE[step.type] ?? 2000;
    switch (step.type) {
      case "prompt": {
        const p = pill(`❯ ${oneLine(turn.turn.userInput, 26)}`, "var(--c-prompt)");
        st.packets.append(p);
        await along(p, st.P.user, base * 0.6, t);
        p.remove();
        st.harnessBox.classList.add("active-box");
        return wait(base * 0.4, t);
      }
      case "send": {
        st.harnessBox.classList.add("active-box");
        drawTower(r, true);
        await wait(base * 0.25, t);
        const env = envelope(r);
        st.packets.append(env);
        const ok = await along(env, st.P.req, base * 0.75, t);
        if (ok) st.modelBox.classList.add("active-box");
        return ok;
      }
      case "think": {
        const tk = r.tokens;
        const total = Math.max(1, promptTokens(tk));
        const cacheW = tk ? (tk.cacheRead / total) * 160 : 0;
        const freshW = tk ? ((tk.input + tk.cacheWrite) / total) * 160 : 0;
        const ok1 = await tweenNum(base * 0.35, t, (e) => {
          st.readCache.setAttribute("width", cacheW * e);
          st.readText.textContent = !tk ? "no usage reported" : contextOnly ? `context ${fmt.k(0)}` : `cache ${fmt.k(tk.cacheRead * e)} · new ${fmt.k(0)}`;
        });
        if (!ok1) return false;
        st.readFresh.setAttribute("x", 790 + cacheW);
        return tweenNum(base * 0.65, t, (e) => {
          st.readFresh.setAttribute("width", freshW * e);
          if (tk) st.readText.textContent = contextOnly ? `context ${fmt.k(tk.input * e)}` : `cache ${fmt.k(tk.cacheRead)} · new ${fmt.k((tk.input + tk.cacheWrite) * e)}`;
        });
      }
      case "reply": {
        st.modelBox.classList.add("active-box");
        const cats = r.response.map((x) => turn.blobs[x.b]?.cat ?? "assistant");
        if (r.status >= 400 || !cats.length) cats.push(r.status >= 400 ? "other" : "assistant");
        // Without an output count (Cursor), size the reply by what came back.
        const outTok = r.tokens?.output || Math.round(r.response.reduce((k, x) => k + (turn.blobs[x.b]?.chars ?? 0), 0) * turn.tokPerChar) || 40;
        const n = Math.max(6, Math.min(22, Math.round(outTok / 6)));
        const dots = [];
        for (let d = 0; d < n; d++) {
          const cat = cats[Math.min(cats.length - 1, Math.floor((d / n) * cats.length))];
          const dot = s("circle", { r: cat === "tool_use" ? 6 : 4.5, fill: r.status >= 400 ? "var(--c-error)" : catVar(cat) });
          st.packets.append(dot);
          dots.push(along(dot, st.P.res, base * 0.55, t).then(() => dot.remove()));
          if (!(await wait((base * 0.45) / n, t))) return false;
        }
        await Promise.all(dots);
        if (!alive(t)) return false;
        st.harnessBox.classList.add("active-box");
        const label = r.stop === "tool_use"
          ? pill(`→ ${[...new Set(toolCalls(turn, r).map((b) => b.name))].join(", ")}`, "var(--c-tool_use)")
          : pill(r.status >= 400 ? `HTTP ${r.status}` : `✓ ${r.stopReason ?? r.stop ?? "done"}`, r.status >= 400 ? "var(--c-error)" : "var(--c-assistant)");
        label.setAttribute("transform", "translate(385,200)");
        st.packets.append(label);
        return wait(400, t);
      }
      case "tool": {
        st.harnessBox.classList.add("active-box");
        const p = pill(`→ ${step.calls.map((c) => c.name).join(", ")}`.slice(0, 34), "var(--c-tool_use)");
        st.packets.append(p);
        if (!(await along(p, st.P.down, base * 0.2, t))) return false;
        p.remove();
        st.termBox.classList.add("active-box");
        const cmd = `$ ${step.calls[0].label}`.slice(0, 38);
        for (let c = 1; c <= cmd.length; c += 2) {
          st.term1.textContent = cmd.slice(0, c);
          if (!(await wait((base * 0.3) / (cmd.length / 2), t))) return false;
        }
        st.term1.textContent = cmd;
        if (step.calls.length > 1) st.term2.textContent = `+ ${step.calls.length - 1} more call${step.calls.length > 2 ? "s" : ""} in parallel`;
        const out = step.next?.messages.flatMap((m) => m.refs).map((x) => turn.blobs[x.b]).find((b) => b?.cat === "tool_result" && b.toolUseId === step.calls[0].toolUseId);
        st.term3.textContent = out ? `→ ${oneLine(out.text, 40)}` : "→ (output)";
        if (!(await wait(base * 0.15, t))) return false;
        const back = pill(`← output${out ? " · " + fmt.chars(out.chars) : ""}`, "var(--c-tool_result)");
        st.packets.append(back);
        if (!(await along(back, st.P.up, base * 0.2, t))) return false;
        back.remove();
        st.termBox.classList.remove("active-box");
        st.harnessBox.classList.add("active-box");
        if (step.next) drawTower(step.next, true);
        st.status.textContent = "conversation grew · next lap";
        return wait(base * 0.15, t);
      }
      case "answer": {
        const reply = r?.response.map((x) => turn.blobs[x.b]).find((b) => b?.cat === "assistant");
        const p = pill(`✓ ${oneLine(reply?.text ?? "answer", 24)}`, "var(--c-assistant)");
        st.packets.append(p);
        answerBubble.classList.remove("show");
        const ok = await along(p, st.P.user, base * 0.6, t, { reverse: true });
        p.remove();
        if (ok) answerBubble.classList.add("show");
        return ok && wait(base * 0.4, t);
      }
      case "bg": {
        const color = purposeColor(r.purpose);
        const env = envelope(r);
        env.querySelector("rect").setAttribute("stroke", color);
        st.packets.append(env);
        if (!(await along(env, st.P.bg, base * 0.45, t))) return false;
        env.remove();
        st.modelBox.classList.add("active-box");
        const ok = await wait(base * 0.1, t);
        if (!ok) return false;
        const reply = r.response.map((x) => turn.blobs[x.b]).find((b) => b?.cat === "assistant");
        const back = pill(r.status >= 400 ? `HTTP ${r.status}` : oneLine(reply?.text ?? r.purpose.label, 28), r.status >= 400 ? "var(--c-error)" : color);
        st.packets.append(back);
        await along(back, st.P.bg, base * 0.45, t, { reverse: true });
        return alive(t);
      }
    }
    return true;
  }

  function oneLine(text, max) {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
  }

  async function goTo(k, animate = true) {
    k = Math.max(0, Math.min(steps.length - 1, k));
    clearTimeout(timer);
    token++;
    const t = token;
    i = k;
    scene(k);
    played = animate;
    if (!animate) return;
    const ok = await play(k, t);
    if (!ok || !alive(t)) return;
    if (playing) {
      if (i >= steps.length - 1) {
        setPlaying(false);
        return;
      }
      timer = setTimeout(() => alive(t) && playing && goTo(i + 1), PAUSE / speed);
    }
  }

  function setPlaying(v) {
    playing = v;
    playBtn.textContent = v ? "❚❚ Pause" : "▶ Play";
    playBtn.classList.toggle("on", v);
    if (!v) return;
    // Resume from a step that was only drawn, never animated; otherwise move on.
    if (i >= steps.length - 1 && played) goTo(0);
    else goTo(played ? i + 1 : i);
  }

  /* ---- DOM */

  const youBubble = h("div", { class: "bubble you", style: { left: "1%", top: "4%" } },
    h("span", { class: "who" }, "You typed"), oneLine(turn.turn.userInput, 220));
  const firstAnswer = [...turn.requests].reverse().find((r) => isMain(r) && r.stop === "end_turn") ?? [...turn.requests].reverse().find(isMain);
  const answerText = firstAnswer?.response.map((x) => turn.blobs[x.b]).filter((b) => b?.cat === "assistant").map((b) => b.text).join("\n") ?? "";
  const answerBubble = h("div", { class: "bubble answer", style: { left: "1%", top: "72%", maxWidth: "21.5%", maxHeight: "26%" } },
    h("span", { class: "who" }, `${turn.harness.name} replied`), oneLine(answerText || "(no text)", 200));

  const stage = h("div", { class: "stage" }, st.svg, youBubble, answerBubble);
  const narrH = h("h3");
  const narrP = h("p");
  const narration = h("div", { class: "narration" }, narrH, narrP);

  const playBtn = h("button", { class: "btn primary play", onclick: () => setPlaying(!playing) }, "▶ Play");
  const progress = h("div", { class: "progress" },
    steps.map((stp, j) => h("i", { class: stp.type === "bg" ? "bg" : "", title: `${j + 1}. ${narrate(turn, stp).title.replace(/<[^>]+>/g, "")}`, onclick: () => { setPlaying(false); goTo(j); } })));
  const stepCount = h("span", { class: "step-count" });
  const speedBtns = [0.5, 1, 2, 4].map((v) => h("button", { class: "btn" + (v === speed ? " on" : ""), onclick: () => setSpeed(v) }, `${v}×`));
  function setSpeed(v) {
    speed = v;
    store.set("xray-speed", v);
    speedBtns.forEach((b) => b.classList.toggle("on", b.textContent === `${v}×`));
  }
  const narrBtn = h("button", { class: "btn" + (narrationOn ? " on" : ""), title: "Narration (N)", onclick: () => toggleNarration() }, "Narration");
  function toggleNarration() {
    narrationOn = !narrationOn;
    store.set("xray-narration", narrationOn);
    narrBtn.classList.toggle("on", narrationOn);
    narration.classList.toggle("hidden-text", !narrationOn);
  }
  const presentBtn = h("button", { class: "btn", title: "Present (F)", onclick: () => togglePresent() }, "⤢ Present");

  const controls = h("div", { class: "controls" },
    h("button", { class: "btn", title: "First step (Home)", onclick: () => { setPlaying(false); goTo(0); } }, "⏮"),
    h("button", { class: "btn", title: "Back (←)", onclick: () => { setPlaying(false); goTo(i - 1); } }, "◀"),
    playBtn,
    h("button", { class: "btn", title: "Forward (→)", onclick: () => { setPlaying(false); goTo(i + 1); } }, "▶"),
    h("button", { class: "btn", title: "Last step (End)", onclick: () => { setPlaying(false); goTo(steps.length - 1); } }, "⏭"),
    progress, stepCount,
    h("span", { class: "row speed", style: { gap: "3px" } }, speedBtns),
    narrBtn, presentBtn);

  const gantt = ganttView(turn, (key) => {
    setPlaying(false);
    const j = steps.findIndex((x) => x.r?.key === key && (x.type === "send" || x.type === "bg"));
    if (j >= 0) goTo(j);
  });

  const stageWrap = h("div", { class: "panel stage-wrap" }, stage, narration, controls, gantt.el);
  const suitcase = h("div", { class: "panel stack" });
  const wrap = h("div", { class: "theater" }, stageWrap, suitcase);

  function togglePresent() {
    wrap.classList.toggle("presenting");
    presentBtn.textContent = wrap.classList.contains("presenting") ? "✕ Exit" : "⤢ Present";
  }

  /* ---- the suitcase: what this request carries */

  function renderSuitcase(r, step) {
    clear(suitcase);
    if (!r) {
      suitcase.append(
        h("div", { class: "stack-head" }, h("h3", null, "What goes to the model"), h("div", { class: "sub" }, `Nothing has been sent yet. Step forward to watch ${turn.harness.name} pack the first request.`)),
        legend());
      return;
    }
    const groups = groupsOf(r, turn.blobs);
    const d = r.diff;
    const bar = h("div", { class: "scale-bar", title: "To scale: each band's height is its share of the request" });
    const manifest = h("div", { class: "manifest" });
    const total = Math.max(1, r.sentChars);
    let groupHead = null;

    groups.forEach((g) => {
      const states = g.refs.map((x) => d.status.get(x.b));
      const anyNew = states.some((x) => x === "new" || x === "echo");
      const allCarried = d.hasPrev && states.every((x) => x === "carried");
      const seg = h("i", { class: allCarried ? "carried" : "", style: { "--c": catVar(g.cat), flexGrow: String(g.chars / total), flexBasis: "0" } });
      bar.append(seg);

      const section = g.id === "system" ? "Instructions" : g.id === "tools" ? "Toolbox" : "Conversation";
      if (section !== groupHead) {
        groupHead = section;
        manifest.append(h("div", { class: "mrow-group" }, section === "Conversation" ? `Conversation · ${r.messages.length} messages` : section));
      }
      const badge = !d.hasPrev ? null
        : states.includes("echo") ? h("span", { class: "chip badge-echo" }, "⤺ echoed")
        : anyNew ? h("span", { class: "chip badge-new" }, "✦ new")
        : h("span", { class: "chip badge-carried" }, "↻ re-sent");
      const blocks = g.id === "system" || g.id === "tools" ? null : h("div", { class: "blocks" },
        g.refs.map((x) => {
          const b = turn.blobs[x.b];
          const stt = d.status.get(x.b);
          return h("span", {
            class: "dot" + (d.hasPrev && stt === "carried" ? " carried" : ""),
            style: { "--c": catVar(b.cat) },
            title: `${CATS[b.cat]?.label}: ${b.label} (${fmt.chars(b.chars)})`,
            onclick: (e) => { e.stopPropagation(); openBlob(ctx, x.b, r.key); },
          }, `${CATS[b.cat]?.icon ?? ""} ${fmt.k(b.chars)}`);
        }));
      const row = h("div", {
        class: "mrow" + (anyNew && d.hasPrev && (step?.type === "send" || step?.type === "bg") ? " new" : ""),
        style: { "--c": catVar(g.cat) },
        onmouseenter: () => seg.classList.add("hl"),
        onmouseleave: () => seg.classList.remove("hl"),
        onclick: () => {
          if (g.id === "system") ctx.selectRequest(r.key, "system");
          else if (g.id === "tools") ctx.selectRequest(r.key, "tools");
          else openBlob(ctx, pickBlob(g), r.key);
        },
      },
        h("span", { class: "t" }, g.msgIndex !== undefined ? `#${g.msgIndex} ${g.title}` : g.title),
        h("span", { class: "row", style: { gap: "6px" } }, badge, h("span", { class: "m" }, fmt.k(g.chars))),
        blocks);
      manifest.append(row);
      if (g.refs.some((x) => x.cache)) manifest.append(h("div", { class: "cache-line" }, "cache breakpoint"));
    });

    const tk = r.tokens;
    suitcase.append(
      h("div", { class: "stack-head" },
        h("h3", null, `Inside request ${r.key} `, h("span", { class: "chip", style: { "--c": purposeColor(r.purpose) } }, r.purpose.label)),
        h("div", { class: "sub" }, `${fmt.chars(r.sentChars)} · ${tk ? fmt.n(promptTokens(tk)) + " tokens in" : "≈" + fmt.k(r.sentChars * turn.tokPerChar) + " tokens"} · ${r.messages.length} messages · ${r.tools.length} tools`),
        d.hasPrev
          ? h("div", { class: "sub" }, h("b", null, share(d.carriedChars, r.sentChars)), ` re-sent unchanged from ${r.prevKey} · `, h("b", null, fmt.chars(d.newChars)), " new")
          : h("div", { class: "sub" }, "First request of its thread: everything here is being sent for the first time.")),
      h("div", { class: "stack-body" }, bar, manifest),
      legend());
  }

  function pickBlob(g) {
    const order = ["prompt", "tool_result", "tool_use", "assistant", "synthetic", "thinking", "reminder"];
    for (const c of order) {
      const x = g.refs.find((ref) => turn.blobs[ref.b]?.cat === c);
      if (x) return x.b;
    }
    return g.refs[0]?.b;
  }

  function legend() {
    const used = new Set(turn.requests.flatMap((r) => [...r.system, ...r.tools, ...r.messages.flatMap((m) => m.refs)].map((x) => turn.blobs[x.b]?.cat)));
    return h("div", { class: "legend", style: { marginTop: "12px" } },
      Object.entries(CATS).filter(([c]) => used.has(c)).map(([c, m]) => h("span", null, h("i", { class: "dot", style: { "--c": catVar(c) } }), m.label)));
  }

  /* ---- keyboard */

  function onKey(e) {
    if (e.target instanceof Element && e.target.closest("input, textarea")) return false;
    const map = {
      " ": () => setPlaying(!playing),
      ArrowRight: () => { setPlaying(false); goTo(i + 1); },
      ArrowLeft: () => { setPlaying(false); goTo(i - 1); },
      Home: () => { setPlaying(false); goTo(0); },
      End: () => { setPlaying(false); goTo(steps.length - 1); },
      n: toggleNarration, N: toggleNarration,
      f: togglePresent, F: togglePresent,
      1: () => setSpeed(0.5), 2: () => setSpeed(1), 3: () => setSpeed(2), 4: () => setSpeed(4),
      Escape: () => wrap.classList.contains("presenting") && togglePresent(),
    };
    const fn = map[e.key];
    if (!fn) return false;
    e.preventDefault();
    fn();
    return true;
  }

  const section = h("section", { class: "section" },
    h("div", { class: "section-head" },
      h("span", { class: "kicker" }, "01 · The agent loop"),
      h("h2", null, "Watch the turn happen"),
      h("p", null, turn.harness.remoteLoop
        ? `Press play, or step with ← →. Here the loop runs on ${turn.harness.remoteLoop}, not on your machine: the server calls the model, and your machine only runs the tools it is sent. The model still remembers nothing between calls, so every lap carries the whole conversation.`
        : `Press play, or step with ← →. ${turn.harness.name} runs on your machine; the model lives behind an API and remembers nothing between calls. Every lap round this loop is one HTTP request, and every request carries the whole conversation.`)),
    wrap);

  scene(0);
  return {
    el: section,
    onKey,
    stop: () => { token++; clearTimeout(timer); playing = false; },
  };
}

/* ------------------------------------------------------------------ gantt */

function ganttView(turn, onPick) {
  const reqs = turn.requests;
  const W = 1000;
  const L = 96;
  const lanes = [
    { id: "main", label: "Agent loop", test: (r) => r.kind === "main" && !r.agentId },
    { id: "bg", label: "Background", test: (r) => !(r.kind === "main" && !r.agentId) },
  ];
  const LH = 26;
  const top = 18;
  const H = top + lanes.length * (LH + 8) + 6;

  // Idle stretches over 4 s are cut down to a fixed width so the busy part
  // stays readable (a turn usually starts after a long pause for typing).
  const spans = reqs.map((r) => [r.start, r.start + (r.durationMs ?? 0)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1] + 4000) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  const CUT = 700;
  const cuts = [];
  let shown = 0;
  const segs = merged.map((m, k) => {
    if (k > 0) {
      cuts.push({ at: shown, idle: m[0] - merged[k - 1][1] });
      shown += CUT;
    }
    const seg = { from: m[0], to: m[1], x0: shown };
    shown += m[1] - m[0];
    return seg;
  });
  const span = Math.max(1, shown);
  const tx = (t) => {
    let seg = segs[0];
    for (const sg of segs) if (t >= sg.from - 1) seg = sg;
    return L + ((seg.x0 + Math.max(0, Math.min(t, seg.to) - seg.from)) / span) * (W - L - 10);
  };

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", style: `height:${H}px` });
  lanes.forEach((lane, k) => {
    const y = top + k * (LH + 8);
    svg.append(s("text", { x: 0, y: y + LH / 2 + 4, class: "lane-label" }, lane.label));
    svg.append(s("rect", { x: L, y, width: W - L - 10, height: LH, rx: 6, fill: "var(--bg-2)" }));
  });

  // Local time between laps: what the harness was doing on your machine.
  const mains = reqs.filter(lanes[0].test);
  for (let k = 0; k + 1 < mains.length; k++) {
    const a = mains[k].start + (mains[k].durationMs ?? 0);
    const b = mains[k + 1].start;
    if (b <= a) continue;
    const x1 = tx(a), x2 = tx(b);
    svg.append(s("rect", { x: x1, y: top + LH / 2 - 3, width: Math.max(1, x2 - x1), height: 6, rx: 3, fill: "var(--c-tool_result)", opacity: 0.8 },
      s("title", null, `on your machine: ${fmt.ms(b - a)}`)));
    if (x2 - x1 > 58) svg.append(s("text", { x: (x1 + x2) / 2, y: top - 4, class: "gap-label", "text-anchor": "middle" }, fmt.ms(b - a)));
  }

  const bars = new Map();
  for (const r of reqs) {
    const k = lanes.findIndex((l) => l.test(r));
    const y = top + k * (LH + 8);
    const x1 = tx(r.start), x2 = tx(r.start + (r.durationMs ?? 0));
    const color = r.status >= 400 ? "var(--c-error)" : purposeColor(r.purpose);
    const ttfbX = r.ttfbMs ? tx(r.start + r.ttfbMs) : x1;
    const g = s("g", { class: "bar", onclick: () => onPick(r.key) },
      s("title", null, `${r.key} · ${r.purpose.label} · ${fmt.ms(r.durationMs)} (first byte ${fmt.ms(r.ttfbMs)})${r.status ? " · HTTP " + r.status : ""}`),
      s("rect", { x: x1, y: y + 3, width: Math.max(3, x2 - x1), height: LH - 6, rx: 4, fill: color, opacity: 0.35 }),
      s("rect", { x: ttfbX, y: y + 3, width: Math.max(2, x2 - ttfbX), height: LH - 6, rx: 4, fill: color }));
    if (x2 - x1 > 30) g.append(s("text", { x: x1 + 5, y: y + LH / 2 + 3.5, class: "bar-label" }, r.key));
    svg.append(g);
    bars.set(r.key, g);
  }

  for (const c of cuts) {
    const x = L + (c.at / span) * (W - L - 10) + ((CUT / span) * (W - L - 10)) / 2;
    svg.append(s("path", { d: `M${x - 4},${top - 2} l4,6 l-4,6 l4,6 l-4,6 l4,6 l-4,6 l4,6 l-4,6 l4,6 l-4,6`, class: "cut" }));
    svg.append(s("text", { x, y: H - 1, class: "cut-label", "text-anchor": "middle" }, `${fmt.ms(c.idle)} idle`));
  }
  const end = Math.max(...reqs.map((r) => r.start + (r.durationMs ?? 0)));

  const head = s("line", { x1: L, x2: L, y1: top - 4, y2: H - 10, class: "playhead", opacity: 0 });
  svg.append(head);

  return {
    el: h("div", { class: "gantt" },
      h("div", { class: "row", style: { fontSize: "12px", color: "var(--muted)", marginBottom: "4px" } },
        h("b", { style: { color: "var(--text)" } }, "Real timeline"),
        "· faded = waiting for the first byte, solid = streaming · ",
        h("span", { style: { color: "var(--c-tool_result)" } }, "━ time on your machine"),
        `· click a bar to jump · ${fmt.ms(end)} end to end`),
      h("div", { class: "gantt-scroll" }, svg)),
    mark(key, type) {
      for (const [k, g] of bars) g.style.opacity = key && k !== key ? 0.45 : 1;
      const r = reqs.find((x) => x.key === key);
      if (!r) return head.setAttribute("opacity", 0);
      const t = type === "send" || type === "bg" ? r.start : type === "think" ? r.start + (r.ttfbMs ?? 0) : r.start + (r.durationMs ?? 0);
      const x = tx(t);
      head.setAttribute("x1", x);
      head.setAttribute("x2", x);
      head.setAttribute("opacity", 1);
    },
  };
}
