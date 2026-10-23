import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { claude } from "../../src/claude/index.ts";
import { codex } from "../../src/codex/index.ts";
import type { Config } from "../../src/core/config.ts";
import { connectInfo } from "../../src/core/connect.ts";
import { SharedIndex } from "../../src/core/logger.ts";
import { createProxyServer } from "../../src/core/server.ts";
import { cursor } from "../../src/cursor/index.ts";
import { createVizServer } from "../../src/viz/server.ts";
import { startMockUpstream } from "../claude/upstream.ts";
import { ccHeaders, settle } from "../helpers/harness.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

describe("connectInfo: how to point each client at its proxy", () => {
  const base = "http://127.0.0.1:9999";

  it("gives env-var clients a one-off and a whole-shell command", () => {
    const info = connectInfo(claude, base, claude.defaultUpstream);
    assert.equal(info.steps[0]!.command, `ANTHROPIC_BASE_URL=${base} claude`);
    assert.match(info.steps[1]!.command, /^export ANTHROPIC_BASE_URL=/);
    assert.ok(info.steps.some((s) => s.title.includes(".claude/settings.local.json")));
  });

  it("carries the setup a client needs before it reaches the proxy", () => {
    const info = connectInfo(cursor, base, cursor.defaultUpstream);
    assert.match(info.setup ?? "", /useHttp1ForAgent/);
    assert.doesNotMatch(info.setup ?? "", /\n/);
  });

  it("uses the provider's own invocation when there is no env var", () => {
    const info = connectInfo(codex, base, codex.defaultUpstream);
    assert.equal(info.steps.length, 1);
    assert.ok(info.steps[0]!.command.includes(`base_url="${base}"`));
  });

  it("is what the visualizer serves at /api/connect", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "arl-connect-"));
    const proxies = [connectInfo(claude, base, claude.defaultUpstream)];
    const viz = createVizServer(logDir, { connect: proxies });
    try {
      const body = await (await fetch((await listen(viz)) + "/api/connect")).json();
      assert.deepEqual(body, JSON.parse(JSON.stringify({ proxies })));
    } finally {
      await new Promise<void>((r) => viz.close(() => r()));
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("SharedIndex: several proxies, one log directory", () => {
  it("lists every proxy's sessions in index.md", async () => {
    const upstream = await startMockUpstream({});
    const logDir = mkdtempSync(join(tmpdir(), "arl-shared-"));
    const cfg = (): Config => ({
      provider: claude,
      port: 0,
      host: "127.0.0.1",
      upstream: new URL(upstream.origin),
      logDir,
      redact: true,
      rawSse: false,
      quiet: true,
    });
    const index = new SharedIndex();
    const servers = [createProxyServer(cfg(), () => {}, index).server, createProxyServer(cfg(), () => {}, index).server];
    try {
      const bases = await Promise.all(servers.map(listen));
      for (const [k, url] of bases.entries()) {
        const res = await fetch(url + "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", ...ccHeaders(`shared-session-${k}`) },
          body: JSON.stringify({ model: "claude-opus-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: `hi ${k}` }] }),
        });
        await res.text();
      }
      await settle();
      const md = readFileSync(join(logDir, "index.md"), "utf8");
      assert.match(md, /_2 sessions in/);
      assert.match(md, /session-shared-session-0/);
      assert.match(md, /session-shared-session-1/);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await upstream.close();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
