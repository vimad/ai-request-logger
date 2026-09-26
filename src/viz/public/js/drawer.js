// The slide-over that explains any single block of context.

import { code, jsonView, prose } from "./format.js";
import { CATS, catVar, chip, clear, copyText, fmt, h } from "./util.js";

const drawer = document.getElementById("drawer");
const body = document.getElementById("drawer-body");

export function closeDrawer() {
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

drawer.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeDrawer();
});

export function openPanel(...content) {
  clear(body).append(h("div", null, ...content));
  body.scrollTop = 0;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}

export function openBlob(ctx, id, fromKey) {
  const { turn } = ctx;
  const b = turn.blobs[id];
  if (!b) return;
  const meta = CATS[b.cat] ?? CATS.other;
  const hits = turn.appears.get(id) ?? [];
  const sentIn = turn.requests.filter((r) => r.messages.some((m) => m.refs.some((x) => x.b === id)) || r.system.some((x) => x.b === id) || r.tools.some((x) => x.b === id));
  const inReply = turn.requests.filter((r) => r.response.some((x) => x.b === id));

  const facts = h("div", { class: "facts" },
    h("span", null, h("b", null, fmt.n(b.chars)), " chars on the wire"),
    h("span", null, "≈ ", h("b", null, fmt.n(b.chars * turn.tokPerChar)), " tokens"),
    b.toolUseId ? h("span", { class: "mono" }, b.toolUseId) : null,
  );

  const appears = h("div", null,
    h("div", { class: "subhead" }, "Where it travels"),
    h("div", { class: "muted", style: { fontSize: "13px" } },
      inReply.length ? `Written by the model in ${inReply.map((r) => r.key).join(", ")}. ` : "",
      sentIn.length
        ? [`Sent to the model in `, h("b", null, `${sentIn.length} of ${turn.requests.length}`), ` requests shown here`,
           sentIn.length > 1 ? [` - `, h("b", null, fmt.chars(b.chars * sentIn.length)), ` in total for this one block.`] : "."]
        : "Never sent to the model in this turn."),
    h("div", { class: "appears" },
      turn.requests.map((r) => h("button", {
        class: hits.includes(r.key) ? "hit" : "",
        title: r.purpose.label,
        onclick: () => { ctx.selectRequest(r.key); },
      }, r.key + (r.key === fromKey ? " ●" : "")))),
  );

  let content;
  switch (b.cat) {
    case "tools":
      content = [
        h("div", { class: "subhead" }, "Description the model reads"),
        prose(b.text || "(no description)"),
        h("div", { class: "subhead" }, "Input schema"),
        jsonView(b.json ?? {}, 4),
      ];
      break;
    case "tool_use": {
      const result = Object.values(turn.blobs).find((x) => x.cat === "tool_result" && x.toolUseId === b.toolUseId);
      content = [
        h("div", { class: "subhead" }, `Arguments for ${b.name}`),
        code(b.text),
        result ? h("button", { class: "btn", style: { marginTop: "12px" }, onclick: () => openBlob(ctx, result.id, fromKey) }, "See what it returned →") : null,
      ];
      break;
    }
    case "tool_result": {
      const call = Object.values(turn.blobs).find((x) => x.cat === "tool_use" && x.toolUseId === b.toolUseId);
      content = [
        call ? h("button", { class: "btn", style: { marginBottom: "12px" }, onclick: () => openBlob(ctx, call.id, fromKey) }, `← The ${call.name} call that produced this`) : null,
        h("div", { class: "subhead" }, b.isError ? "Error output" : "Output"),
        code(b.text || "(empty)"),
      ];
      break;
    }
    case "thinking":
      content = [code(b.text)];
      break;
    default: {
      const rendered = prose(b.text);
      const raw = code(b.text);
      raw.hidden = true;
      const toggle = h("label", { class: "toggle" }, h("input", { type: "checkbox", onchange: (e) => { raw.hidden = !e.target.checked; rendered.hidden = e.target.checked; } }), "Show raw text");
      content = [h("div", { class: "row", style: { marginBottom: "10px" } }, toggle), rendered, raw];
    }
  }

  openPanel(
    h("div", { class: "row" }, chip(`${meta.icon} ${meta.label}`, b.cat), h("span", { class: "muted", style: { fontSize: "12px" } }, `written by ${meta.who}`)),
    h("h2", null, b.label || meta.label),
    facts,
    h("div", { class: "callout", style: { "--c": catVar(b.cat) } }, meta.about),
    content,
    appears,
    h("div", { class: "row", style: { marginTop: "18px" } },
      h("button", { class: "btn", onclick: (e) => { copyText(b.text); e.target.textContent = "Copied"; } }, "Copy text")),
  );
}
