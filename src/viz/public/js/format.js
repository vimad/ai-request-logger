// Text rendering: a small, safe Markdown subset for prompts, and a JSON tree.
// Everything is escaped first; nothing from a log is ever inserted as HTML.

import { esc, h } from "./util.js";

function inline(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/&lt;(\/?[a-zA-Z][\w-]*)((?:\s[^&]*?)?)&gt;/g, '<span class="xml">&lt;$1$2&gt;</span>');
}

/**
 * Markdown-ish to HTML. Returns `{ html, headings }` so the system prompt tab
 * can build an outline; headings get ids `${idPrefix}-${n}`.
 */
export function markdown(text, idPrefix = "h") {
  const lines = String(text ?? "").split("\n");
  const out = [];
  const headings = [];
  let list = null;
  let para = [];
  let fence = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      fence = [];
      continue;
    }
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hd) {
      flushPara();
      flushList();
      const level = hd[1].length;
      const id = `${idPrefix}-${headings.length}`;
      headings.push({ id, level, text: hd[2], offset: i });
      out.push(`<h${level} id="${id}" class="sys-section">${inline(hd[2])}</h${level}>`);
      continue;
    }
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const kind = /^\s*\d+\./.test(line) ? "ol" : "ul";
      if (list !== kind) {
        flushList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line);
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
  flushPara();
  flushList();
  return { html: out.join("\n"), headings };
}

export function prose(text, { plain = false } = {}) {
  const el = h("div", { class: plain ? "prose plain" : "prose" });
  if (plain) el.textContent = text;
  else el.innerHTML = markdown(text).html;
  return el;
}

export function code(text) {
  return h("pre", { class: "code" }, text);
}

/** Highlight every case-insensitive occurrence of `q` inside `root`'s text. */
export function highlight(root, q) {
  const marks = [];
  if (!q) return marks;
  const needle = q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    if (at < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (at >= 0) {
      frag.append(text.slice(last, at));
      const m = h("mark", null, text.slice(at, at + q.length));
      marks.push(m);
      frag.append(m);
      last = at + q.length;
      at = lower.indexOf(needle, last);
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return marks;
}

/* ------------------------------------------------------------ JSON tree */

const CLIP = 600;

function leafValue(v) {
  if (typeof v === "string") {
    const el = h("span", { class: "str" });
    if (v.length <= CLIP) el.textContent = JSON.stringify(v);
    else {
      el.textContent = JSON.stringify(v.slice(0, CLIP)).slice(0, -1) + "…";
      const more = h("span", { class: "more", onclick: () => { el.textContent = JSON.stringify(v); } }, ` show all ${v.length.toLocaleString()} chars`);
      return h("span", null, el, more);
    }
    return el;
  }
  if (typeof v === "number") return h("span", { class: "numv" }, String(v));
  return h("span", { class: "lit" }, String(v));
}

export function jsonTree(value, depth = 2, key) {
  const label = key !== undefined ? [h("span", { class: "key" }, JSON.stringify(key)), ": "] : [];
  if (value === null || typeof value !== "object") return h("div", { class: "leaf" }, label, leafValue(value));
  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const summary = h("summary", null, label, h("span", { class: "cnt" }, isArr ? `[${entries.length}]` : `{${entries.length}}`));
  const d = h("details", depth > 0 ? { open: true } : null, summary);
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    for (const [k, v] of entries) d.append(jsonTree(v, depth - 1, isArr ? k : k));
  };
  if (depth > 0) fill();
  else d.addEventListener("toggle", fill, { once: true });
  return d;
}

export function jsonView(value, depth = 2) {
  return h("div", { class: "jt" }, jsonTree(value, depth));
}
