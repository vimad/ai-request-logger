import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ccHeaders, settle, startHarness, TOOLS, type Harness } from "../helpers/harness.ts";

describe("proxy transparency", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  it("forwards anthropic-* and credential headers verbatim", async () => {
    await h
      .send(
        { model: "m", stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] },
        ccHeaders("hdr-session", { "anthropic-workspace-id": "ws_1", "x-custom-thing": "keep-me" }),
      )
      .then((r) => r.text());

    const seen = h.upstream.seen.at(-1)!;
    // No allowlist: new beta capabilities must survive a proxy that has never
    // heard of them.
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.match(seen.headers["anthropic-beta"]!, /fine-grained-tool-streaming/);
    assert.equal(seen.headers["authorization"], "Bearer sk-ant-oat-FAKE-TOKEN");
    assert.equal(seen.headers["anthropic-workspace-id"], "ws_1");
    assert.equal(seen.headers["x-custom-thing"], "keep-me");
    assert.equal(seen.headers["x-claude-code-session-id"], "hdr-session");
  });

  it("rewrites host and drops hop-by-hop headers", async () => {
    await h.send({ model: "m", messages: [] }, ccHeaders("hop-session")).then((r) => r.text());
    const seen = h.upstream.seen.at(-1)!;
    assert.equal(seen.headers["host"], new URL(h.upstream.origin).host);
    assert.equal(seen.headers["transfer-encoding"], undefined);
    assert.equal(seen.headers["keep-alive"], undefined);
  });

  it("forwards the request body byte for byte", async () => {
    const body = { model: "m", messages: [{ role: "user", content: "exact ✅ bytes" }] };
    await h.send(body, ccHeaders("body-session")).then((r) => r.text());
    assert.deepEqual(h.upstream.seen.at(-1)!.body, body);
  });

  it("proxies non-Messages paths and methods too", async () => {
    // count_tokens, the /api/hello warm-up, and anything a future release adds.
    await fetch(h.base + "/api/hello", { method: "HEAD" });
    await settle(80);
    assert.ok(h.upstream.seen.some((s) => s.url === "/api/hello" && s.method === "HEAD"));
  });

  it("relays upstream errors as the upstream wrote them", async () => {
    const res = await h.send({ model: "m", messages: [] }, ccHeaders("err-session"), "/unauthorized");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { type: "error", error: { type: "authentication_error" } });
  });

  it("returns 502 with a JSON error when the upstream is unreachable", async () => {
    const dead = await startHarness();
    await dead.upstream.close();
    const res = await dead.send({ model: "m", messages: [] }, ccHeaders("dead-session"));
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as any).error.type, "proxy_error");
    await dead.close();
  });
});

describe("streaming", () => {
  let h: Harness;
  before(async () => {
    // A deliberate gap between deltas, so buffering would be visible.
    h = await startHarness({ deltaDelayMs: 25 });
  });
  after(async () => {
    await h.close();
  });

  it("relays SSE progressively rather than buffering to the end", async () => {
    const res = await h.send(
      { model: "m", stream: true, tools: TOOLS, messages: [{ role: "user", content: "go" }] },
      ccHeaders("stream-session"),
    );
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const t0 = Date.now();
    const arrivals: number[] = [];
    const decoder = new TextDecoder();
    for await (const chunk of res.body as any) {
      const text = decoder.decode(chunk as Uint8Array, { stream: true });
      for (const line of text.split("\n")) if (line.startsWith("event:")) arrivals.push(Date.now() - t0);
    }

    assert.ok(arrivals.length > 5, `expected several events, got ${arrivals.length}`);
    const spread = arrivals.at(-1)! - arrivals[0]!;
    // Claude Code aborts a stream that goes quiet, so events must arrive as
    // they are produced, not in one lump at the end.
    assert.ok(spread > 50, `events arrived in a single lump (spread ${spread}ms) - proxy is buffering`);
  });

  it("passes keep-alive comments through to the client", async () => {
    const res = await h.send(
      { model: "m", stream: true, tools: TOOLS, messages: [{ role: "user", content: "go" }] },
      ccHeaders("ping-session"),
    );
    assert.match(await res.text(), /^: ping$/m);
  });
});
