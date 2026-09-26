// "Every request carries everything": each request as a to-scale tower, with
// bands joining the blocks that were sent again. The model's reply hangs under
// its tower, and a band carries it into the next request, where it comes back
// as input.

import { openBlob } from "./drawer.js";
import { CATS, allRefs, catVar, fmt, h, isBackground, purposeColor, s, store } from "./util.js";

export function matrix(ctx) {
  const { turn } = ctx;
  let showTools = store.get("xray-matrix-tools", true);
  let selected;

  const reqs = turn.requests;
  const totalSent = reqs.reduce((n, r) => n + r.sentChars, 0);
  const unique = new Set(reqs.flatMap((r) => allRefs(r).map((x) => x.b)));
  const uniqueChars = [...unique].reduce((n, id) => n + (turn.blobs[id]?.chars ?? 0), 0);

  const holder = h("div", { class: "matrix-scroll" });
  const toggle = h("label", { class: "toggle" },
    h("input", { type: "checkbox", checked: showTools, onchange: (e) => { showTools = e.target.checked; store.set("xray-matrix-tools", showTools); draw(); } }),
    "Include tool definitions (turn off to zoom in on the conversation)");

  function segmentsOf(r) {
    // System and tools are one segment each: they are the same bytes in every
    // lap, and 70 hairline slivers would say less than one solid block.
    const segs = [];
    const grp = (refs, cat, label) => {
      if (!refs.length) return;
      const chars = refs.reduce((n, x) => n + (turn.blobs[x.b]?.chars ?? 0), 0);
      segs.push({ id: cat + ":" + refs.map((x) => x.b).join(","), cat, chars, label, group: cat, blob: undefined });
    };
    grp(r.system, "system", `System prompt · ${r.system.length} blocks`);
    if (showTools) grp(r.tools, "tools", `${r.tools.length} tool definitions`);
    for (const m of r.messages) {
      for (const x of m.refs) {
        const b = turn.blobs[x.b];
        segs.push({ id: x.b, cat: b?.cat ?? "other", chars: b?.chars ?? 0, label: `${CATS[b?.cat]?.label}: ${b?.label}`, blob: x.b, status: r.diff.status.get(x.b) });
      }
    }
    return segs;
  }

  function draw() {
    holder.replaceChildren();
    const colW = 60;
    const gap = 74;
    const left = 58;
    const top = 64;
    const H = 360;
    const perReq = reqs.map((r) => ({ r, segs: segmentsOf(r) }));
    const maxChars = Math.max(1, ...perReq.map((p) => p.segs.reduce((n, sg) => n + sg.chars, 0)));
    const unit = H / maxChars;
    const minH = 1.2;

    // Lay out every tower top-down, in the order the API reads it.
    const pos = new Map();
    let maxReply = 0;
    perReq.forEach((p, k) => {
      const x = left + k * (colW + gap);
      let y = top;
      p.x = x;
      p.at = new Map();
      for (const sg of p.segs) {
        const hh = Math.max(minH, sg.chars * unit);
        sg.y = y;
        sg.h = hh;
        p.at.set(sg.id, sg);
        y += hh;
      }
      p.bottom = y;
      p.reply = [];
      let ry = y + 18;
      for (const x2 of p.r.response) {
        const b = turn.blobs[x2.b];
        const hh = Math.max(3, (b?.chars ?? 0) * unit);
        p.reply.push({ id: x2.b, cat: b?.cat ?? "assistant", y: ry, h: hh, label: `${CATS[b?.cat]?.label}: ${b?.label}` });
        ry += hh + 1;
      }
      maxReply = Math.max(maxReply, ry - top - H);
      pos.set(p.r.key, p);
    });

    const width = left + perReq.length * (colW + gap);
    const tokY = top + H + Math.max(40, maxReply + 30);
    const height = tokY + 64;
    const svg = s("svg", { class: "matrix", width, height, viewBox: `0 0 ${width} ${height}` });

    // Axis
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const y = top + H * f;
      svg.append(s("line", { x1: left - 8, x2: width - 10, y1: y, y2: y, class: "grid" }));
      svg.append(s("text", { x: left - 12, y: y + 3, class: "axis", "text-anchor": "end" }, fmt.k(maxChars * f)));
    }
    svg.append(s("text", { x: 4, y: top + H + 16, class: "axis" }, "chars sent"));

    // Bands first, so towers sit on top of them.
    const bands = s("g");
    svg.append(bands);
    for (const p of perReq) {
      const prev = p.r.prevKey ? pos.get(p.r.prevKey) : undefined;
      if (!prev) continue;
      for (const sg of p.segs) {
        const from = prev.at.get(sg.id);
        const echo = prev.reply.find((x) => x.id === sg.id);
        const src = from ?? echo;
        if (!src) continue;
        const x1 = prev.x + colW;
        const x2 = p.x;
        const mid = (x1 + x2) / 2;
        const d = `M${x1},${src.y} C${mid},${src.y} ${mid},${sg.y} ${x2},${sg.y} L${x2},${sg.y + sg.h} C${mid},${sg.y + sg.h} ${mid},${src.y + src.h} ${x1},${src.y + src.h} Z`;
        bands.append(s("path", { d, class: "band", fill: catVar(sg.cat), style: echo && !from ? "opacity:.45" : "" }));
      }
    }

    for (const p of perReq) {
      const r = p.r;
      const col = s("g");
      const isSel = selected === r.key;
      col.append(s("rect", { x: p.x - 8, y: 6, width: colW + 16, height: height - 10, rx: 10, class: isSel ? "col-sel" : "col-hit", onclick: () => ctx.selectRequest(r.key) }));
      const bg = isBackground(r);
      col.append(s("text", { x: p.x + colW / 2, y: 22, class: "lbl", "text-anchor": "middle" }, r.key));
      col.append(s("text", { x: p.x + colW / 2, y: 37, class: "sub", "text-anchor": "middle", style: `fill:${purposeColor(r.purpose)}` }, short(r.purpose.label)));
      col.append(s("text", { x: p.x + colW / 2, y: 51, class: "sub", "text-anchor": "middle" }, r.status >= 400 ? `HTTP ${r.status}` : r.stopReason ?? ""));
      if (bg) col.append(s("rect", { x: p.x - 3, y: top - 3, width: colW + 6, height: p.bottom - top + 6, rx: 5, fill: "none", stroke: purposeColor(r.purpose), "stroke-dasharray": "3 3" }));

      for (const sg of p.segs) {
        const isNew = r.diff.hasPrev && (sg.status === "new" || sg.status === "echo");
        const rect = s("rect", {
          x: p.x, y: sg.y, width: colW, height: sg.h, fill: catVar(sg.cat), class: "seg" + (isNew ? " new" : ""),
          style: "cursor:pointer",
          onclick: (e) => {
            e.stopPropagation();
            if (sg.blob) openBlob(ctx, sg.blob, r.key);
            else ctx.selectRequest(r.key, sg.group === "system" ? "system" : "tools");
          },
        }, s("title", null, `${sg.label} · ${fmt.chars(sg.chars)}${isNew ? (sg.status === "echo" ? " · echoed from the previous reply" : " · new in this request") : r.diff.hasPrev ? " · re-sent" : ""}`));
        col.append(rect);
        if (sg.h > 16 && sg.group) {
          col.append(s("text", { x: p.x + colW / 2, y: sg.y + sg.h / 2 + 4, "text-anchor": "middle", style: "font:700 10px var(--sans);fill:#0b1020;pointer-events:none" }, sg.group === "tools" ? "tools" : "system"));
        }
      }
      if (p.reply.length) {
        col.append(s("text", { x: p.x + colW / 2, y: p.bottom + 12, class: "sub", "text-anchor": "middle" }, "reply ↓"));
        for (const rp of p.reply) {
          col.append(s("rect", {
            x: p.x + 6, y: rp.y, width: colW - 12, height: rp.h, rx: 2, fill: catVar(rp.cat), stroke: "var(--text)", "stroke-dasharray": "2 2", "stroke-width": 0.8,
            style: "cursor:pointer", onclick: (e) => { e.stopPropagation(); openBlob(ctx, rp.id, r.key); },
          }, s("title", null, `Model's reply · ${rp.label}`)));
        }
      }

      // Tokens: what the API actually billed for this request.
      const t = r.tokens;
      if (t) {
        const parts = [["cacheRead", "var(--c-cache)"], ["cacheWrite", "var(--c-system)"], ["input", "var(--c-prompt)"], ["output", "var(--c-assistant)"]];
        const sum = Math.max(1, parts.reduce((n, [k]) => n + t[k], 0));
        let x = p.x;
        for (const [k, c] of parts) {
          const w = (t[k] / sum) * colW;
          if (w > 0) col.append(s("rect", { x, y: tokY, width: Math.max(0.8, w), height: 10, fill: c }, s("title", null, `${k}: ${fmt.n(t[k])}`)));
          x += w;
        }
        col.append(s("text", { x: p.x + colW / 2, y: tokY + 26, class: "sub", "text-anchor": "middle" }, `${fmt.k(t.input + t.cacheRead + t.cacheWrite)} in`));
        col.append(s("text", { x: p.x + colW / 2, y: tokY + 40, class: "sub", "text-anchor": "middle" }, `${fmt.k(t.output)} out`));
        if (t.cacheRead) col.append(s("text", { x: p.x + colW / 2, y: tokY + 54, class: "sub", "text-anchor": "middle" }, `${Math.round((t.cacheRead / Math.max(1, t.input + t.cacheRead + t.cacheWrite)) * 100)}% cached`));
      }
      svg.append(col);
    }
    svg.append(s("text", { x: 4, y: tokY + 9, class: "axis" }, "tokens"));
    holder.append(svg);
  }

  function short(text) {
    return text.length > 12 ? text.slice(0, 11) + "…" : text;
  }

  draw();

  const el = h("section", { class: "section" },
    h("div", { class: "section-head" },
      h("span", { class: "kicker" }, "02 · Stateless by design"),
      h("h2", null, "Every request carries everything"),
      h("p", null,
        "Each column is one request, drawn to scale and read top to bottom as the API reads it. Bands join blocks that are ",
        h("b", null, "byte-for-byte identical"), " to what the previous request on the same thread sent. The dashed block under a column is the model's reply, and you can follow it into the next column, where it is sent back as input. Outlined columns are background calls.")),
    h("div", { class: "panel matrix-wrap" },
      h("div", { class: "matrix-tools" },
        h("span", null, "Across ", h("b", null, `${reqs.length} requests`), " Claude Code sent ", h("b", null, fmt.chars(totalSent)), ". Only ", h("b", null, fmt.chars(uniqueChars)), ` of that was distinct: the other `, h("b", null, totalSent ? `${Math.round((1 - uniqueChars / totalSent) * 100)}%` : "0%"), " was re-sending."),
        h("span", { class: "spacer" }), toggle),
      holder,
      h("div", { class: "legend", style: { marginTop: "8px" } },
        h("span", null, h("i", { class: "dot", style: { "--c": "var(--c-cache)" } }), "cache read"),
        h("span", null, h("i", { class: "dot", style: { "--c": "var(--c-system)" } }), "cache write"),
        h("span", null, h("i", { class: "dot", style: { "--c": "var(--c-prompt)" } }), "fresh input"),
        h("span", null, h("i", { class: "dot", style: { "--c": "var(--c-assistant)" } }), "output"),
        h("span", null, "· white outline = new in this request"))));

  return {
    el,
    select(key) {
      selected = key;
      draw();
    },
  };
}
