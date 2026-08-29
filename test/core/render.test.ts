import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderIndex, renderSession, renderTurn } from "../../src/core/render.ts";
import type { ProviderRenderer, TurnRecord } from "../../src/core/types.ts";

/**
 * A stand-in provider renderer. The rollups must work off nothing but the
 * `ProviderRenderer` contract, so this deliberately uses a token shape no real
 * provider has - if a rollup ever reaches for `usage.input_tokens` directly,
 * these numbers stop adding up.
 */
const fake: ProviderRenderer = {
  tokens: (usage) => {
    const u = (usage ?? {}) as { in?: number; out?: number };
    const input = u.in ?? 0;
    const output = u.out ?? 0;
    return { input, output, cacheRead: 0, cacheWrite: 0, total: input + output };
  },
  usageTable: (t) => (t ? `TOTAL=${t.total} IN=${t.input} OUT=${t.output}` : "none"),
  request: () => "unused",
};

const turn: TurnRecord = {
  turn: 2,
  session: "s1",
  label: "do the thing",
  startedAt: "2026-08-29T00:00:00.000Z",
  requests: [
    { n: 1, dir: "req-001__main", kind: "main", model: "m", status: 200, stopReason: "tool_use", durationMs: 100, messageCount: 1, toolCalls: ["Bash"], usage: { in: 10, out: 5 } },
    { n: 2, dir: "req-002__main", kind: "main", model: "m", status: 200, stopReason: "end_turn", durationMs: 50, messageCount: 3, toolCalls: [], usage: { in: 20, out: 7 } },
  ],
};

describe("turn.md", () => {
  it("totals the turn through the provider's token reader alone", () => {
    const md = renderTurn(turn, "do the thing", fake);
    assert.match(md, /# Turn 2 — do the thing/);
    assert.match(md, /\*\*2 provider requests\*\*/);
    assert.match(md, /TOTAL=42 IN=30 OUT=12/, "10+5+20+7, read via the provider");
    assert.match(md, /\[001\]\(\.\/req-001__main\/request\.md\)/);
  });

  it("narrates what each request did", () => {
    const md = renderTurn(turn, "do the thing", fake);
    assert.match(md, /1 message in · 100 ms → called Bash/);
    assert.match(md, /3 messages in · 50 ms → answered the user/);
  });

  it("does not claim a background call answered the user", () => {
    const md = renderTurn(
      { ...turn, requests: [{ n: 1, dir: "d", kind: "aux", status: 200, stopReason: "end_turn", durationMs: 10, messageCount: 1, toolCalls: [] }] },
      "x",
      fake,
    );
    assert.match(md, /returned its result/);
  });

  it("shows what was asked", () => {
    assert.match(renderTurn(turn, "do the thing", fake), /## What was asked/);
  });
});

describe("session.md", () => {
  it("adds every turn up, background included", () => {
    const md = renderSession(
      { session: "s1", turns: 1, providerRequests: 2 },
      [{ meta: turn, dir: "turn-002__do-the-thing" }],
      fake,
    );
    assert.match(md, /# Session `s1`/);
    assert.match(md, /TOTAL=42/);
    assert.match(md, /\[2\]\(\.\/turn-002__do-the-thing\/turn\.md\) \| do the thing \| 2 \| 150 ms \| 42 \|/);
  });

  it("labels turn 0 as background rather than by its label", () => {
    const md = renderSession(
      { session: "s1" },
      [{ meta: { turn: 0, label: "background", requests: [] }, dir: "turn-000__background" }],
      fake,
    );
    assert.match(md, /\| background \|/);
  });
});

describe("index.md", () => {
  it("lists sessions newest first", () => {
    const md = renderIndex(
      [
        { dir: "2026-01-01T00-00-00__session-a", turns: 1, requests: 2, ms: 10, tokens: 5 },
        { dir: "2026-02-01T00-00-00__session-b", turns: 3, requests: 4, ms: 20, tokens: 9 },
      ],
      "/tmp/log",
    );
    assert.ok(md.indexOf("session-b") < md.indexOf("session-a"), "newest session first");
    assert.match(md, /_2 sessions in `\/tmp\/log`\._/);
  });
});
