// The "connect a harness" panel on the home page: one tab per running proxy,
// with the exact commands that route that client through it.

import { h } from "./util.js";

const NAMES = { claude: "Claude Code", cursor: "Cursor CLI", codex: "Codex CLI" };

function copyButton(text) {
  const btn = h("button", { class: "btn copy", title: "Copy to clipboard" }, "Copy");
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Select and copy";
    }
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  };
  return btn;
}

function tabBody(p) {
  return h("div", { class: "connect-body" },
    h("p", { class: "connect-route" },
      h("span", { class: `chip harness-${p.id}` }, NAMES[p.id] ?? p.id),
      " proxy listening on ", h("code", null, p.base), " → ", h("code", null, p.upstream)),
    p.setup ? h("div", { class: "warn" }, h("b", null, "Before you start: "), p.setup) : null,
    p.steps.map((step, k) => h("div", { class: "connect-step" },
      h("div", { class: "connect-title" }, `${k + 1}. ${step.title}`),
      h("div", { class: "connect-cmd" }, h("pre", null, step.command), copyButton(step.command)))),
    h("p", { class: "muted connect-foot" }, "Then ask it something: the turn appears below within a few seconds. ", p.stop),
    p.credentials ? h("p", { class: "faint connect-foot" }, p.credentials) : null);
}

/** The panel, or null when no proxies are running alongside the visualizer. */
export function connectPanel(proxies) {
  if (!proxies.length) return null;
  const tabs = h("div", { class: "tabs" });
  const body = h("div", null);
  const select = (id) => {
    for (const t of tabs.children) t.classList.toggle("on", t.dataset.id === id);
    body.replaceChildren(tabBody(proxies.find((p) => p.id === id)));
    try { localStorage.setItem("xray-connect-tab", id); } catch {}
  };
  for (const p of proxies) {
    tabs.append(h("button", { class: "tab", "data-id": p.id, onclick: () => select(p.id) },
      h("i", { class: `dot harness-${p.id}` }), NAMES[p.id] ?? p.id));
  }
  let saved;
  try { saved = localStorage.getItem("xray-connect-tab"); } catch {}
  select(proxies.some((p) => p.id === saved) ? saved : proxies[0].id);

  return h("details", { class: "panel connect" },
    h("summary", null,
      h("span", null, "Connect a coding agent"),
      h("span", { class: "muted" }, ` · ${proxies.length} prox${proxies.length === 1 ? "y" : "ies"} running: ${proxies.map((p) => NAMES[p.id] ?? p.id).join(", ")}`)),
    tabs, body);
}
