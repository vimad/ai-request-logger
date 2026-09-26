// "Take any request apart": a filmstrip of requests and tabs for everything
// inside the selected one.

import { openBlob } from "./drawer.js";
import { code, highlight, jsonView, markdown, prose } from "./format.js";
import { CATS, allRefs, catVar, chip, clear, fmt, h, promptTokens, purposeColor, s, store } from "./util.js";

const TABS = [
  ["conversation", "Conversation"],
  ["system", "System prompt"],
  ["tools", "Tools"],
  ["response", "Response"],
  ["params", "Params & headers"],
  ["raw", "Raw JSON"],
];

export function inspector(ctx) {
  const { turn } = ctx;
  let key = turn.requests.find((r) => r.kind === "main")?.key ?? turn.requests[0]?.key;
  let tab = store.get("xray-tab", "conversation");
  const filmstrip = h("div", { class: "filmstrip" });
  const tabs = h("div", { class: "tabs" });
  const body = h("div", { class: "tab-body" });

  function renderFilm() {
    clear(filmstrip);
    for (const r of turn.requests) {
      const t = r.tokens;
      filmstrip.append(h("button", {
        class: "film" + (r.key === key ? " sel" : ""),
        style: { "--c": r.status >= 400 ? "var(--c-error)" : purposeColor(r.purpose) },
        onclick: () => select(r.key),
      },
        h("div", { class: "k" }, `${r.key} `, h("span", { class: "faint", style: { fontWeight: 400 } }, `+${fmt.ms(r.start)}`)),
        h("div", { class: "p" }, r.purpose.label),
        h("div", { class: "x" }, r.status >= 400 ? `HTTP ${r.status}` : `${r.stopReason ?? "-"} · ${t ? fmt.k(promptTokens(t)) + " in" : "-"}`)));
    }
  }

  function renderTabs() {
    clear(tabs);
    const r = turn.byKey.get(key);
    const counts = {
      conversation: r?.messages.length,
      system: r?.system.length,
      tools: r?.tools.length,
      response: r?.response.length,
    };
    for (const [id, label] of TABS) {
      tabs.append(h("button", { class: "tab" + (id === tab ? " on" : ""), onclick: () => { tab = id; store.set("xray-tab", id); renderTabs(); renderBody(); } },
        label, counts[id] !== undefined ? h("span", { class: "n" }, counts[id]) : null));
    }
  }

  function renderBody() {
    clear(body);
    const r = turn.byKey.get(key);
    if (!r) return body.append(h("div", { class: "empty" }, "No request selected."));
    const view = { conversation, system: systemTab, tools: toolsTab, response: responseTab, params: paramsTab, raw: rawTab }[tab] ?? conversation;
    body.append(view(ctx, r));
  }

  function select(k, t) {
    if (k) key = k;
    if (t) {
      tab = t;
      store.set("xray-tab", t);
    }
    renderFilm();
    renderTabs();
    renderBody();
    filmstrip.querySelector(".sel")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  select();
  return {
    el: h("section", { class: "section", id: "inspect" },
      h("div", { class: "section-head" },
        h("span", { class: "kicker" }, "03 · Take any request apart"),
        h("h2", null, "The request inspector"),
        h("p", null, "Pick a request. Every role is colour-coded: what you typed, what Claude Code injected, what the model wrote, and what your machine returned. Click any block for the full text.")),
      filmstrip,
      h("div", { class: "panel" }, tabs, body)),
    select,
    get key() {
      return key;
    },
  };
}

/* --------------------------------------------------------- conversation */

function conversation(ctx, r) {
  const { turn } = ctx;
  let showReminders = store.get("xray-reminders", false);
  let onlyNew = false;
  const list = h("div", { class: "convo" });

  const draw = () => {
    clear(list);
    let lastCache = -1;
    r.messages.forEach((m, i) => m.refs.forEach((x) => { if (x.cache) lastCache = i; }));
    r.messages.forEach((m, i) => {
      const states = m.refs.map((x) => r.diff.status.get(x.b));
      const fresh = states.some((st) => st === "new" || st === "echo");
      if (onlyNew && r.diff.hasPrev && !fresh) return;
      const cats = new Set(m.refs.map((x) => turn.blobs[x.b]?.cat));
      const roleCls = m.role === "assistant" ? "role-assistant" : m.role === "system" ? "role-system" : "role-user";
      const tag = !r.diff.hasPrev ? null
        : states.includes("echo") ? chip("⤺ the model's own reply, echoed back", "assistant", "badge-echo")
        : fresh ? chip("✦ new in this request", "prompt", "badge-new")
        : chip("↻ re-sent unchanged", "other", "badge-carried");
      const note = m.role === "system" ? "a system message in the middle of the conversation, written by Claude Code"
        : m.role === "user" && cats.has("tool_result") && !cats.has("prompt") ? "sent as “user”, but it's tool output from your machine"
        : m.role === "user" && !cats.has("prompt") && cats.has("reminder") ? "sent as “user”, but written by Claude Code"
        : "";
      list.append(h("div", { class: `msg ${roleCls}` + (r.diff.hasPrev && !fresh ? " faded" : "") },
        h("div", { class: "msg-head" },
          h("span", { class: "role" }, m.role),
          h("span", { class: "faint mono" }, `messages[${i}]`),
          note ? h("span", { class: "muted", style: { fontSize: "12px" } }, note) : null,
          h("span", { class: "spacer" }), tag),
        h("div", { class: "msg-body" }, m.refs.map((x) => blockView(ctx, r, x, showReminders)))));
    });
    if (r.response.length || r.responseRaw) {
      list.append(h("div", { class: "msg role-reply" },
        h("div", { class: "msg-head" },
          h("span", { class: "role" }, "↩ reply"),
          h("span", { class: "muted", style: { fontSize: "12px" } }, "what the model sent back to this request. It isn't part of the request, but it will be in the next one"),
          h("span", { class: "spacer" }), r.stopReason ? chip(`stop_reason: ${r.stopReason}`, "assistant") : null),
        h("div", { class: "msg-body" }, r.response.length ? r.response.map((x) => blockView(ctx, r, x, true, true)) : jsonView(r.responseRaw, 3))));
    }
  };

  const reminderCount = allRefs(r).filter((x) => turn.blobs[x.b]?.cat === "reminder").length;
  const bar = h("div", { class: "toolbar" },
    h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: showReminders, onchange: (e) => { showReminders = e.target.checked; store.set("xray-reminders", showReminders); draw(); } }), `Expand injected context (${reminderCount})`),
    r.diff.hasPrev ? h("label", { class: "toggle" }, h("input", { type: "checkbox", onchange: (e) => { onlyNew = e.target.checked; draw(); } }), `Only what's new since ${r.prevKey}`) : null,
    h("span", { class: "spacer" }),
    h("div", { class: "legend" }, ["prompt", "reminder", "synthetic", "thinking", "assistant", "tool_use", "tool_result"].map((c) => h("span", null, h("i", { class: "dot", style: { "--c": catVar(c) } }), CATS[c].label))));

  draw();
  const sysChars = r.system.reduce((n, x) => n + (turn.blobs[x.b]?.chars ?? 0), 0);
  const toolChars = r.tools.reduce((n, x) => n + (turn.blobs[x.b]?.chars ?? 0), 0);
  return h("div", null,
    h("div", { class: "callout" }, `Before these ${r.messages.length} messages, the request also carries the `,
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); ctx.selectRequest(r.key, "system"); } }, `system prompt (${fmt.chars(sysChars)})`), " and ",
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); ctx.selectRequest(r.key, "tools"); } }, `${r.tools.length} tool definitions (${fmt.chars(toolChars)})`), "."),
    bar, list);
}

function blockView(ctx, r, ref, expandReminders, isReply = false) {
  const { turn } = ctx;
  const b = turn.blobs[ref.b];
  if (!b) return null;
  const meta = CATS[b.cat] ?? CATS.other;
  const big = b.text.length > 1400;
  const open = b.cat === "prompt" || b.cat === "assistant" || b.cat === "tool_use" || (b.cat === "reminder" || b.cat === "synthetic" ? expandReminders : b.cat === "tool_result" ? !big : b.cat === "thinking" ? b.text.length < 800 : true);
  let title = meta.label;
  if (b.cat === "tool_use") title = `Tool call → ${b.name}`;
  if (b.cat === "tool_result") title = `${b.isError ? "Tool error" : "Tool output"} ← ${turn.toolNameById.get(b.toolUseId) ?? "tool"}`;
  if (b.cat === "reminder") title = "Injected by Claude Code";

  const content = b.cat === "tool_use" ? code(b.text)
    : b.cat === "tool_result" || b.cat === "thinking" ? code(big ? b.text.slice(0, 1400) + "\n…" : b.text)
    : b.cat === "prompt" || b.cat === "assistant" ? prose(b.text)
    : prose(big ? b.text.slice(0, 1400) + "\n\n…" : b.text);
  const more = big && b.cat !== "tool_use" && b.cat !== "prompt" && b.cat !== "assistant"
    ? h("button", { class: "btn", style: { marginTop: "8px" }, onclick: () => openBlob(ctx, b.id, r.key) }, `Open all ${fmt.n(b.chars)} chars`) : null;

  const el = h("div", { class: `blk cat-${b.cat}` + (open ? " open" : "") + (b.cat === "prompt" ? " prompt-blk" : "") },
    h("div", { class: "blk-head", onclick: () => el.classList.toggle("open") },
      h("span", { class: "caret" }, "▸"),
      h("span", { class: "ttl" }, `${meta.icon} ${title}`),
      h("span", { class: "lbl" }, b.cat === "tool_use" || b.cat === "prompt" || b.cat === "assistant" ? "" : b.label),
      h("span", { class: "sz" }, `${fmt.k(b.chars)} · ≈${fmt.k(b.chars * turn.tokPerChar)} tok`),
      h("button", { class: "icon-btn", style: { padding: "1px 7px", fontSize: "12px" }, title: "Inspect", onclick: (e) => { e.stopPropagation(); openBlob(ctx, b.id, r.key); } }, "⤢")),
    h("div", { class: "blk-body" }, content, more));
  if (!ref.cache || isReply) return el;
  return h("div", null, el, h("div", { class: "cache-mark", style: { marginTop: "6px" } }, "🔖 cache_control: the request up to here can be served from the prompt cache next time"));
}

/* -------------------------------------------------------- system prompt */

function systemTab(ctx, r) {
  const { turn } = ctx;
  if (!r.system.length) return h("div", { class: "empty" }, "This request has no system prompt.");
  const outline = h("nav", { class: "outline" });
  const main = h("div");
  const search = h("input", { type: "search", placeholder: "Search the system prompt…" });
  const counter = h("span", { class: "muted", style: { fontSize: "13px" } });
  let raw = false;
  let marks = [];
  let cur = -1;

  const draw = () => {
    clear(outline);
    clear(main);
    r.system.forEach((ref, i) => {
      const b = turn.blobs[ref.b];
      const prefix = `sys${i}`;
      const { html, headings } = markdown(b.text, prefix);
      const content = h("div", { class: "sys-block-body" });
      if (raw) content.append(code(b.text));
      else content.append(h("div", { class: "prose", html }));
      main.append(h("div", { class: "sys-block", id: `${prefix}-top` },
        h("div", { class: "sys-block-head" },
          h("b", null, `system[${i}]`), h("span", { class: "muted" }, b.label),
          h("span", { class: "spacer" }),
          h("span", { class: "mono faint" }, `${fmt.n(b.chars)} chars · ≈${fmt.k(b.chars * turn.tokPerChar)} tok`),
          ref.cache ? chip("🔖 cached", "other") : null),
        content));
      outline.append(h("a", { href: `#${prefix}-top`, onclick: jump(`${prefix}-top`) }, h("b", null, `Block ${i + 1}`), h("span", { class: "size" }, fmt.k(b.chars))));
      if (!raw) {
        const lines = b.text.split("\n");
        headings.forEach((hd, k) => {
          const end = headings[k + 1]?.offset ?? lines.length;
          const size = lines.slice(hd.offset, end).join("\n").length;
          outline.append(h("a", { class: `l${Math.min(3, hd.level)}`, href: `#${hd.id}`, onclick: jump(hd.id) }, hd.text.slice(0, 60), h("span", { class: "size" }, fmt.k(size))));
        });
      }
    });
    applySearch();
  };

  const jump = (id) => (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  function applySearch() {
    const q = search.value.trim();
    marks = highlight(main, q);
    cur = -1;
    counter.textContent = q ? `${marks.length} match${marks.length === 1 ? "" : "es"} · Enter for next` : "";
  }
  search.addEventListener("input", () => draw());
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !marks.length) return;
    marks[cur]?.classList.remove("cur");
    cur = (cur + 1) % marks.length;
    marks[cur].classList.add("cur");
    marks[cur].scrollIntoView({ behavior: "smooth", block: "center" });
  });

  const total = r.system.reduce((n, x) => n + (turn.blobs[x.b]?.chars ?? 0), 0);
  const sameEverywhere = turn.requests.filter((x) => x.system.map((y) => y.b).join() === r.system.map((y) => y.b).join()).length;
  draw();
  return h("div", null,
    h("div", { class: "callout", style: { "--c": "var(--c-system)" } },
      h("b", null, `${fmt.n(total)} characters`), ` (≈${fmt.k(total * turn.tokPerChar)} tokens) of instructions you never see. The identical system prompt goes out with `,
      h("b", null, `${sameEverywhere} of the ${turn.requests.length}`), " requests in this view. The model only knows who it is and how to behave because it is told again every time."),
    h("div", { class: "toolbar" }, search, counter, h("span", { class: "spacer" }),
      h("label", { class: "toggle" }, h("input", { type: "checkbox", onchange: (e) => { raw = e.target.checked; draw(); } }), "Raw text")),
    h("div", { class: "sys-grid" }, outline, main));
}

/* ---------------------------------------------------------------- tools */

function toolsTab(ctx, r) {
  const { turn } = ctx;
  if (!r.tools.length) return h("div", { class: "empty" }, "This request offers the model no tools, so the model can only reply with text.");
  const tools = r.tools.map((x) => turn.blobs[x.b]).filter(Boolean);
  const max = Math.max(...tools.map((t) => t.chars));
  const total = tools.reduce((n, t) => n + t.chars, 0);
  const search = h("input", { type: "search", placeholder: "Filter tools…" });
  let bySize = false;
  const groupsEl = h("div", { class: "tool-groups" });

  const draw = () => {
    clear(groupsEl);
    const q = search.value.trim().toLowerCase();
    const groups = new Map();
    for (const t of tools) {
      if (q && !t.name.toLowerCase().includes(q) && !t.text.toLowerCase().includes(q)) continue;
      const m = /^mcp__(.+?)__/.exec(t.name);
      const g = m ? `MCP server · ${m[1]}` : "Built into Claude Code";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    for (const [g, list] of groups) {
      if (bySize) list.sort((a, b) => b.chars - a.chars);
      const chars = list.reduce((n, t) => n + t.chars, 0);
      groupsEl.append(h("div", { class: "tool-group" },
        h("h4", null, `${g} · ${list.length} · ${fmt.chars(chars)}`),
        h("div", { class: "tool-grid" }, list.map((t) => {
          const used = turn.usedTools.get(t.name);
          return h("button", { class: "tool" + (used ? " used" : ""), title: used ? `Called ${used}× in this turn` : "Not called in this turn", onclick: () => openBlob(ctx, t.id, r.key) },
            h("span", { class: "nm" }, t.name.replace(/^mcp__.+?__/, "")),
            h("span", { class: "meter" }, h("i", { style: { width: `${(t.chars / max) * 100}%` } })),
            h("span", { class: "sz" }, `${fmt.n(t.chars)} chars${used ? ` · used ×${used}` : ""}`));
        }))));
    }
  };
  search.addEventListener("input", draw);
  draw();
  const used = [...turn.usedTools.entries()];
  return h("div", null,
    h("div", { class: "callout", style: { "--c": "var(--c-tools)" } },
      h("b", null, `${tools.length} tools, ${fmt.chars(total)} (≈${fmt.k(total * turn.tokPerChar)} tokens)`),
      " describe everything the model is allowed to ask for. They ride along on every request. This turn actually used ",
      h("b", null, used.length ? used.map(([n, c]) => `${n}${c > 1 ? ` ×${c}` : ""}`).join(", ") : "none of them"), "."),
    h("div", { class: "toolbar" }, search, h("span", { class: "spacer" }),
      h("label", { class: "toggle" }, h("input", { type: "checkbox", onchange: (e) => { bySize = e.target.checked; draw(); } }), "Sort by size")),
    groupsEl);
}

/* ------------------------------------------------------------- response */

function responseTab(ctx, r) {
  const { turn } = ctx;
  const t = r.tokens;
  const kv = (k, v) => h("div", null, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
  const parts = t ? [
    ["Cache read", t.cacheRead, "var(--c-cache)"],
    ["Cache write", t.cacheWrite, "var(--c-system)"],
    ["Fresh input", t.input, "var(--c-prompt)"],
    ["Output", t.output, "var(--c-assistant)"],
  ] : [];
  const sum = parts.reduce((n, p) => n + p[1], 0) || 1;

  const out = [
    h("div", { class: "kv" },
      kv("Status", r.status ?? "-"),
      kv("Stop reason", r.stopReason ?? "-"),
      kv("First byte", fmt.ms(r.ttfbMs)),
      kv("Total", fmt.ms(r.durationMs)),
      kv("Tokens in", t ? fmt.n(promptTokens(t)) : "-"),
      kv("Tokens out", t ? fmt.n(t.output) : "-"),
      r.thinkingTokens ? kv("…of which thinking", fmt.n(r.thinkingTokens)) : null,
      r.stream_ ? kv("SSE events", fmt.n(r.stream_.events)) : null),
  ];
  if (t) {
    out.push(h("div", { class: "subhead" }, "Where the tokens went"),
      h("div", { class: "tokbar" }, parts.filter((p) => p[1] > 0).map(([k, v, c]) => h("i", { style: { background: c, flexGrow: String(v / sum) }, title: `${k}: ${fmt.n(v)}` }, v / sum > 0.08 ? `${k} ${fmt.k(v)}` : ""))),
      h("div", { class: "legend" }, parts.map(([k, v, c]) => h("span", null, h("i", { class: "dot", style: { "--c": c } }), `${k}: ${fmt.n(v)}`))),
      h("p", { class: "muted", style: { fontSize: "13px" } },
        t.cacheRead ? `The ${fmt.n(t.cacheRead)} cache-read tokens are the prefix this request shares with an earlier one. They still count toward the context, but they are much cheaper and faster than fresh input.` : "No cache hit. This is the first request with this prefix (or the cache expired)."));
  }
  if (r.stream_?.blocks.length) out.push(h("div", { class: "subhead" }, "The stream, over time"), streamChart(r));
  out.push(h("div", { class: "subhead" }, "What came back"));
  if (r.response.length) out.push(h("div", { class: "msg-body", style: { padding: 0 } }, r.response.map((x) => blockView(ctx, r, x, true, true))));
  else out.push(r.responseRaw ? jsonView(r.responseRaw, 4) : h("div", { class: "muted" }, "No body was recorded."));
  return h("div", null, out);
}

function streamChart(r) {
  const blocks = r.stream_.blocks;
  const end = Math.max(r.durationMs ?? 0, ...blocks.map((b) => b.end), 1);
  const W = 1000, L = 110, row = 22;
  const H = 30 + blocks.length * row + 10;
  const x = (t) => L + (t / end) * (W - L - 20);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "stream-svg", style: `height:${H}px`, preserveAspectRatio: "none" });
  svg.append(s("rect", { x: x(0), y: 8, width: x(r.ttfbMs ?? 0) - x(0), height: 12, rx: 3, fill: "var(--line)" }));
  svg.append(s("text", { x: x(0) + 4, y: 18 }, `waiting · ${fmt.ms(r.ttfbMs)}`));
  svg.append(s("text", { x: 0, y: 18 }, "request sent"));
  const cat = (type) => (type === "text" ? "assistant" : type === "redacted_thinking" ? "thinking" : type);
  blocks.forEach((b, k) => {
    const y = 30 + k * row;
    svg.append(s("text", { x: 0, y: y + 12 }, `[${b.index}] ${b.type}`));
    svg.append(s("rect", { x: x(b.start), y, width: Math.max(3, x(b.end) - x(b.start)), height: 14, rx: 3, fill: catVar(cat(b.type)) },
      s("title", null, `${b.type}: ${fmt.ms(b.start)} → ${fmt.ms(b.end)} · ${b.deltas} deltas`)));
    svg.append(s("text", { x: Math.max(x(b.end), x(b.start) + 3) + 6, y: y + 12 }, `${b.deltas} deltas`));
  });
  return svg;
}

/* -------------------------------------------------------------- params */

const PARAM_NOTES = {
  model: "Which model answers. Claude Code can use different models for the main loop and for background calls.",
  max_tokens: "The ceiling on output tokens for this reply.",
  stream: "Server-sent events: the reply arrives token by token instead of all at once.",
  thinking: "Extended thinking: the model may reason before answering.",
  output_config: "Output settings, such as the effort level.",
  context_management: "Rules for the API to trim context (e.g. clear old thinking) server-side.",
  metadata: "Opaque identifiers (device, account, session) for abuse detection and rate limits.",
  temperature: "Sampling randomness.",
  tool_choice: "Whether the model must, may, or must not call a tool.",
};

const BETA_NOTES = {
  "claude-code": "Claude Code client features",
  oauth: "Signed in with a Claude account, not an API key",
  "interleaved-thinking": "Thinking between tool calls",
  "prompt-caching-scope": "Prompt cache scoping",
  "context-management": "Server-side context editing",
  "extended-cache-ttl": "1-hour prompt cache instead of 5 minutes",
  "fine-grained-tool-streaming": "Stream tool arguments as they are generated",
  "context-1m": "1M-token context window",
  effort: "Effort control",
  "mid-conversation-system": "System messages inside the conversation",
  "redact-thinking": "Thinking text withheld from the client",
  "thinking-token-count": "Thinking tokens reported separately",
};

function paramsTab(ctx, r) {
  const rows = Object.entries(r.params).map(([k, v]) => h("tr", null,
    h("td", { class: "k" }, k),
    h("td", { class: "v" }, typeof v === "object" ? JSON.stringify(v) : String(v)),
    h("td", { class: "explain" }, PARAM_NOTES[k] ?? "")));
  const betas = String(r.headers["anthropic-beta"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const headerRows = (hdrs, hl) => Object.entries(hdrs).map(([k, v]) => h("tr", { class: hl(k) ? "hl" : "" }, h("td", { class: "k" }, k), h("td", { class: "v" }, v)));
  return h("div", null,
    h("div", { class: "subhead", style: { marginTop: 0 } }, `Request · ${r.path ?? ""}`),
    h("table", { class: "t" }, h("tr", null, h("th", null, "Body field"), h("th", null, "Value"), h("th", null, "What it does")), rows,
      h("tr", null, h("td", { class: "k" }, "system / tools / messages"), h("td", { class: "v" }, `${r.system.length} / ${r.tools.length} / ${r.messages.length}`), h("td", { class: "explain" }, "See the other tabs."))),
    betas.length ? [h("div", { class: "subhead" }, "Beta features switched on (anthropic-beta)"),
      h("div", { class: "betas" }, betas.map((b) => {
        const note = Object.entries(BETA_NOTES).find(([k]) => b.startsWith(k))?.[1];
        return h("span", { class: "chip cat-tools", title: note ?? "" }, b, note ? h("span", { class: "muted", style: { fontWeight: 400 } }, ` · ${note}`) : null);
      }))] : null,
    h("div", { class: "subhead" }, "Request headers"),
    h("p", { class: "muted", style: { fontSize: "13px", marginTop: 0 } }, "Credentials were redacted by the proxy before they reached disk."),
    h("table", { class: "t" }, headerRows(r.headers, (k) => /^(x-claude|anthropic|authorization|user-agent)/.test(k))),
    Object.keys(r.responseHeaders).length ? [h("div", { class: "subhead" }, "Response headers"),
      h("p", { class: "muted", style: { fontSize: "13px", marginTop: 0 } }, "The highlighted rows are how Claude Code learns your rate-limit status."),
      h("table", { class: "t" }, headerRows(r.responseHeaders, (k) => /ratelimit|request-id/.test(k)))] : null);
}

/* ----------------------------------------------------------------- raw */

function rawTab(ctx, r) {
  const { turn } = ctx;
  const out = h("div");
  const load = async (file) => {
    clear(out).append(h("div", { class: "muted" }, "Loading…"));
    const bgDir = r.fromBackground ? ctx.backgroundTurnDir : turn.turn.dir;
    const url = `/api/raw?session=${encodeURIComponent(turn.session.dir)}&turn=${encodeURIComponent(bgDir)}&req=${encodeURIComponent(r.dir)}&file=${file}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      clear(out);
      if (file.endsWith(".json")) out.append(jsonView(JSON.parse(text), 2));
      else out.append(code(text));
    } catch (err) {
      clear(out).append(h("div", { class: "warn" }, `Could not load ${file}: ${err.message}`));
    }
  };
  const buttons = ["request.json", "response.json", "stream.jsonl", "request.md"].map((f) => h("button", {
    class: "btn",
    onclick: (e) => {
      buttons.forEach((b) => b.classList.remove("on"));
      e.target.classList.add("on");
      load(f);
    },
  }, f));
  buttons[0].classList.add("on");
  load("request.json");
  return h("div", null,
    h("div", { class: "toolbar" }, buttons, h("span", { class: "muted mono", style: { fontSize: "12px" } }, `${r.fromBackground ? ctx.backgroundTurnDir : turn.turn.dir}/${r.dir}/`)),
    out);
}
