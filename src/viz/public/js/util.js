// Shared helpers: DOM builders, number formatting, and the category vocabulary
// every view colours by.

export const SVGNS = "http://www.w3.org/2000/svg";

/** `h("div", { class: "x", onclick }, child, "text", [more])` */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

/** The same, in the SVG namespace. */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith("--")) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ------------------------------------------------------------- numbers */

export const fmt = {
  n: (v) => (v === undefined || v === null || Number.isNaN(v) ? "-" : Math.round(v).toLocaleString("en-US")),
  k(v) {
    if (v === undefined || v === null) return "-";
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.0+$/, "") + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(Math.round(v));
  },
  ms(v) {
    if (v === undefined || v === null) return "-";
    if (v < 1000) return `${Math.round(v)} ms`;
    if (v < 60000) return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} s`;
    const m = Math.floor(v / 60000);
    return `${m}m ${Math.round((v % 60000) / 1000)}s`;
  },
  chars: (v) => `${fmt.k(v)} chars`,
  pct: (v) => `${Math.round(v * 100)}%`,
};

/* ----------------------------------------------------------- categories */

// "{h}" is the harness's name, filled in by setHarness().
const CAT_TEXT = {
  system: { label: "System prompt", who: "{h}", icon: "◆", about: "Instructions {h} writes for the model: who it is, how to behave, how to use tools. The user never sees it, and it is sent in full with every request." },
  tools: { label: "Tool definitions", who: "{h}", icon: "▦", about: "The name, description and JSON schema of every tool the model may call. They are sent with every request because the model has no other way to know they exist." },
  prompt: { label: "You typed", who: "You", icon: "❯", about: "The words you actually typed. Often the smallest thing in the request." },
  reminder: { label: "Injected context", who: "{h}", icon: "⚙", about: "Text the harness slips into the conversation for you: <system-reminder> blocks (CLAUDE.md, environment, dates, todo state) and mid-conversation system messages. It looks like part of your message to the model, but you never typed it." },
  synthetic: { label: "Harness prompt", who: "{h}", icon: "✎", about: "A whole prompt {h} wrote to the model on its own behalf, e.g. \"name this session\" or \"predict what the user types next\"." },
  assistant: { label: "Model text", who: "Model", icon: "✦", about: "Text the model wrote. Once written, it is sent back in every later request, because the model does not remember it." },
  thinking: { label: "Thinking", who: "Model", icon: "☁", about: "The model's reasoning. It streams back first, and its signature is replayed on later requests so the model can keep reasoning consistently." },
  tool_use: { label: "Tool call", who: "Model", icon: "→", about: "The model cannot run anything. It emits a structured request, and {h} executes it on your machine." },
  tool_result: { label: "Tool output", who: "Your machine", icon: "←", about: "What the tool printed, captured by {h} and handed back to the model in the next request." },
  media: { label: "Image / document", who: "You", icon: "▣", about: "An attachment." },
  other: { label: "Other", who: "?", icon: "·", about: "A block type the visualizer does not have a special view for." },
};

/** Category labels and explanations, worded for the harness on screen. */
export const CATS = {};

/** Re-words `CATS` for a turn's harness (`turn.harness` from the digest). */
export function setHarness(harness) {
  const name = harness?.name ?? "the harness";
  for (const [cat, base] of Object.entries(CAT_TEXT)) {
    CATS[cat] = {
      ...base,
      who: base.who.replaceAll("{h}", name),
      about: (harness?.about?.[cat] ?? base.about).replaceAll("{h}", name),
    };
  }
}
setHarness({ name: "Claude Code" });

export const catVar = (cat) => `var(--c-${cat in CATS ? cat : "other"})`;

export function chip(text, cat, extra = "") {
  return h("span", { class: `chip cat-${cat} ${extra}` }, text);
}

export const PURPOSE_COLOR = {
  loop: "var(--c-prompt)",
  subagent: "var(--c-agent)",
  plumbing: "var(--c-other)",
};
export const purposeColor = (p) => PURPOSE_COLOR[p.id] ?? "var(--c-bg)";

export const isBackground = (r) => r.kind !== "main" || !!r.agentId;

/* ---------------------------------------------------------- the model */

/** Everything the views derive from the raw digest, computed once. */
export function enrich(turn) {
  setHarness(turn.harness);
  const byKey = new Map(turn.requests.map((r) => [r.key, r]));
  const blobs = turn.blobs;

  let promptTok = 0;
  let promptChars = 0;
  for (const r of turn.requests) {
    if (r.tokens && r.sentChars) {
      promptTok += r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite;
      promptChars += r.sentChars;
    }
  }
  // Calibrated against what the API actually counted, so "≈ tokens" on a
  // block is honest for this model's tokenizer. Falls back to a typical ratio
  // when usage is missing or implausible.
  const measured = promptChars > 0 ? promptTok / promptChars : 0;
  const tokPerChar = measured > 0.1 && measured < 1 ? measured : 0.3;

  // Where each blob appears, and which tool_use each tool_result answers.
  const appears = new Map();
  const toolNameById = new Map();
  for (const r of turn.requests) {
    const seen = new Set();
    for (const ref of allRefs(r)) seen.add(ref.b);
    for (const ref of r.response) seen.add(ref.b);
    for (const id of seen) {
      if (!appears.has(id)) appears.set(id, []);
      appears.get(id).push(r.key);
    }
    for (const ref of [...allRefs(r), ...r.response]) {
      const b = blobs[ref.b];
      if (b?.cat === "tool_use" && b.toolUseId) toolNameById.set(b.toolUseId, b.name);
    }
  }

  const usedTools = new Map();
  for (const r of turn.requests) {
    if (isBackground(r) && !r.agentId) continue;
    for (const ref of r.response) {
      const b = blobs[ref.b];
      if (b?.cat === "tool_use") usedTools.set(b.name, (usedTools.get(b.name) ?? 0) + 1);
    }
  }

  // Which listed skills the model reached for: a Skill tool call naming one
  // (Claude Code), or any tool call that mentions its SKILL.md (Codex and
  // Cursor read the file with an ordinary tool).
  const skills = Object.values(blobs).flatMap((b) => b.skills ?? []);
  const usedSkills = new Map();
  if (skills.length) {
    for (const r of turn.requests) {
      if (isBackground(r) && !r.agentId) continue;
      for (const ref of r.response) {
        const b = blobs[ref.b];
        if (b?.cat !== "tool_use") continue;
        const asked = b.name === "Skill" && typeof b.json?.skill === "string" ? b.json.skill.replace(/^\//, "") : undefined;
        const hit = new Set(skills.filter((sk) => sk.name === asked || (sk.path && b.text.includes(sk.path))).map((sk) => sk.name));
        for (const name of hit) usedSkills.set(name, (usedSkills.get(name) ?? 0) + 1);
      }
    }
  }

  for (const r of turn.requests) r.diff = diffOf(r, byKey.get(r.prevKey), blobs);

  return { ...turn, byKey, tokPerChar, appears, toolNameById, usedTools, usedSkills };
}

export function allRefs(r) {
  return [...r.system, ...r.tools, ...r.messages.flatMap((m) => m.refs)];
}

/**
 * For every blob a request sends: was it in the previous request of the
 * thread ("carried"), is it the model's own previous reply coming back
 * ("echo"), or is this the first time ("new")?
 */
function diffOf(r, prev, blobs) {
  const status = new Map();
  const before = new Set(prev ? allRefs(prev).map((x) => x.b) : []);
  const reply = new Set(prev ? prev.response.map((x) => x.b) : []);
  let carriedChars = 0;
  let newChars = 0;
  for (const ref of allRefs(r)) {
    const chars = blobs[ref.b]?.chars ?? 0;
    if (before.has(ref.b)) {
      status.set(ref.b, "carried");
      carriedChars += chars;
    } else if (reply.has(ref.b)) {
      status.set(ref.b, "echo");
      newChars += chars;
    } else {
      status.set(ref.b, prev ? "new" : "first");
      newChars += chars;
    }
  }
  return { status, carriedChars, newChars, hasPrev: !!prev };
}

/** Groups for the suitcase and the matrix: system, tools, then each message. */
export function groupsOf(r, blobs) {
  const size = (refs) => refs.reduce((n, x) => n + (blobs[x.b]?.chars ?? 0), 0);
  const groups = [];
  if (r.system.length) groups.push({ id: "system", title: "System prompt", cat: "system", refs: r.system, chars: size(r.system) });
  if (r.tools.length) groups.push({ id: "tools", title: `${r.tools.length} tool definitions`, cat: "tools", refs: r.tools, chars: size(r.tools) });
  r.messages.forEach((m, i) => {
    const cats = m.refs.map((x) => blobs[x.b]?.cat ?? "other");
    const lead = dominant(m.refs, blobs);
    groups.push({ id: `m${i}`, msgIndex: i, role: m.role, title: messageTitle(m, cats, blobs), cat: lead, refs: m.refs, chars: size(m.refs) });
  });
  return groups;
}

function dominant(refs, blobs) {
  const order = ["prompt", "tool_result", "tool_use", "assistant", "synthetic", "reminder", "thinking", "media", "other"];
  const cats = new Set(refs.map((x) => blobs[x.b]?.cat));
  return order.find((c) => cats.has(c)) ?? "other";
}

function messageTitle(m, cats, blobs) {
  const set = new Set(cats);
  if (m.role === "system" || m.role === "developer") return `${m.role} · injected context`;
  if (set.has("tool_result")) {
    const n = cats.filter((c) => c === "tool_result").length;
    return `${m.role} · ${n > 1 ? n + " tool outputs" : "tool output"}`;
  }
  if (set.has("tool_use")) {
    const names = m.refs.map((x) => blobs[x.b]).filter((b) => b?.cat === "tool_use").map((b) => b.name);
    return `${m.role} · calls ${[...new Set(names)].join(", ")}`;
  }
  if (set.has("prompt")) return `${m.role} · your prompt${set.has("reminder") ? " + injected context" : ""}`;
  if (set.has("synthetic")) return `${m.role} · harness prompt`;
  if (set.has("assistant")) return `${m.role} · text`;
  if (set.has("reminder")) return `${m.role} · injected context`;
  return m.role;
}

export function promptTokens(t) {
  return t ? t.input + t.cacheRead + t.cacheWrite : 0;
}

export function copyText(text) {
  try {
    navigator.clipboard?.writeText(text);
  } catch {}
}

export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};
