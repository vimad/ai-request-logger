import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createVizServer } from "../../src/viz/server.ts";

describe("viz server: read-only and confined to the log directory", () => {
  let root: string;
  let server: Server;
  let base: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "arl-viz-"));
    const logDir = join(root, "log");
    const req = join(logDir, "s1", "turn-001__hi", "req-001__main");
    mkdirSync(req, { recursive: true });
    writeFileSync(join(logDir, "s1", "session.json"), JSON.stringify({ session: "s1", provider: "claude" }));
    writeFileSync(join(logDir, "s1", "turn-001__hi", "turn.json"), JSON.stringify({ turn: 1, label: "hi", requests: [] }));
    writeFileSync(join(req, "request.json"), JSON.stringify({ at: "2026-01-01T00:00:00Z", request: 1, shape: { kind: "main" }, body: { messages: [] } }));
    // A file just outside the log directory that must never be served.
    writeFileSync(join(root, "secret.json"), "{}");

    server = createVizServer(logDir);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the app and the session listing", async () => {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent X-Ray/);
    const list: any = await (await fetch(base + "/api/sessions")).json();
    assert.equal(list.sessions[0].turns[0].dir, "turn-001__hi");
  });

  it("digests a turn and serves its raw files", async () => {
    const turn = await fetch(`${base}/api/turn?session=s1&turn=turn-001__hi`);
    assert.equal(turn.status, 200);
    assert.equal(((await turn.json()) as any).requests.length, 1);
    const raw = await fetch(`${base}/api/raw?session=s1&turn=turn-001__hi&req=req-001__main&file=request.json`);
    assert.equal(raw.status, 200);
  });

  it("refuses anything that climbs out of the log directory", async () => {
    const attempts = [
      "/api/turn?session=..&turn=secret.json",
      "/api/turn?session=s1&turn=..%2F..",
      "/api/raw?session=..&turn=..&req=..&file=request.json",
      "/api/raw?session=s1&turn=turn-001__hi&req=req-001__main&file=..%2F..%2F..%2Fsecret.json",
      "/api/raw?session=s1&turn=turn-001__hi&req=req-001__main&file=session.json",
      "/..%2F..%2F..%2Fsecret.json",
    ];
    for (const path of attempts) {
      const res = await fetch(base + path);
      assert.equal(res.status, 404, path);
    }
  });
});
