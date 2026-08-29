# Testing strategy

```bash
npm test            # node --test, zero dependencies, ~1s
npx tsc --noEmit    # src/ and test/
```

## Two principles

**1. No test ever calls a real API.** Every test that needs an upstream gets a
local mock HTTP server on an ephemeral port, writing to a throwaway log
directory under the OS temp dir. Nothing touches your real `log/`, nothing
consumes tokens, and the suite runs offline. This is why the fixtures can afford
to be large and realistic — they cost nothing.

**2. Tests are split along the same seam as the source.** `test/core/` may not
know which provider is running; `test/<provider>/` is where vendor knowledge
lives.

```
test/
  core/
    proxy.test.ts       transparency: headers, host rewrite, body fidelity,
                        error relay, and that SSE is NOT buffered
    sse.test.ts         frame parsing across arbitrary chunk splits
    markdown.test.ts    atoms: nothing truncated, markup escaped, fences survive
    render.test.ts      turn/session/index rollups, via a FAKE renderer
  claude/
    turns.test.ts       turn boundaries and classification
    messages.test.ts    stream reconstruction, responseFacts
    render.test.ts      request.md and the Anthropic token split
    e2e.test.ts         a whole session through the proxy
    upstream.ts         the mock Anthropic server
    fixtures/
      real-session.json request bodies captured from a real session
  helpers/
    harness.ts          proxy + mock upstream + throwaway log dir
```

## The layers, and what each is for

### Core: contract tests

`test/core/render.test.ts` is the one to understand before adding a provider. It
drives the turn/session/index rollups with a **deliberately fake** renderer
whose usage shape is `{ in, out }` — a shape no real vendor uses:

```ts
const fake: ProviderRenderer = {
  tokens: (usage) => { const u = usage as { in?: number; out?: number }; /* … */ },
  usageTable: (t) => `TOTAL=${t.total} IN=${t.input} OUT=${t.output}`,
  request: () => "unused",
};
```

If anyone ever makes `core/render.ts` reach for `usage.input_tokens` directly,
the totals silently become zero and these tests fail. That is the enforcement
mechanism for the "core names no vendor" rule.

`test/core/proxy.test.ts` needs *some* upstream to talk to, so it borrows the
Claude mock. It only asserts provider-neutral behaviour — headers through,
bytes exact, errors relayed, SSE not buffered.

### Provider: unit tests

One test file per source file, testing pure functions with hand-written inputs.
Fast, precise, and where you should spend most of your effort. For Claude these
cover turn identity (the bulk), stream reconstruction, and rendering.

### Provider: end-to-end

`test/claude/e2e.test.ts` drives a realistic session through the real proxy —
two user turns, a tool loop, a background call, a subagent request, a
non-inference call — then asserts on the resulting log tree: turn grouping,
files written, streamed replies rebuilt, gzip decompressed, credentials redacted
in the log but *not* on the wire.

Its last check is the important one:

```ts
const before = readText(join(turnDirs(session)[0]!, "turn.md"));
await renderSessionDir(session);
const after = readText(join(turnDirs(session)[0]!, "turn.md"));
assert.equal(after, before, "the offline report must match what the proxy wrote live");
```

That is what guarantees `npm run report` stays a faithful re-render, and it only
holds while your `renderer.request()` is a pure function of the two JSON files.

## The mock upstream

[`test/claude/upstream.ts`](../test/claude/upstream.ts) is a stand-in for
`api.anthropic.com` that speaks the parts of the protocol the proxy has to
survive — not a full emulator. It covers, on purpose:

- SSE with a comment keep-alive (`: ping`) *and* a `ping` event
- tool calls whose JSON input is **split across `input_json_delta` fragments**,
  because reassembly is the thing under test
- a configurable delay between deltas, so buffering is detectable
- gzip on a non-streaming response
- a non-streaming JSON path and an error path
- a request log (`seen`) so tests can assert what the proxy forwarded

It also drives multi-request turns: it emits a tool call *unless* the client
just handed back a tool result, which is what makes the e2e tool loop terminate.

Write the equivalent for your protocol. Keep the same shape — an options bag, a
`seen` array, `origin` and `close()` — and the shared harness will accept it.

## Reusing the harness

[`test/helpers/harness.ts`](../test/helpers/harness.ts) starts the real proxy
against a mock upstream on ephemeral ports with a temp log dir, and hands back
`send()`, `logDir`, `upstream.seen` and `close()`. It already takes a provider:

```ts
const h = await startHarness({ provider: cursor });
```

Today it imports the Claude mock directly, because that is the only one that
exists. When you add a second, pass yours in the same way the provider is passed
— the intent is marked with a comment at the import.

There are helpers for walking the log tree (`sessionDir`, `turnDirs`,
`requestDirs`, `readJson`, `readText`) and a `settle()`, because the proxy
finishes writing its log *after* it has responded to the client.

## The fixture

`test/claude/fixtures/real-session.json` holds request bodies captured from an
actual Claude Code session — trimmed of local paths and file contents, with the
message *shapes* preserved.

It exists because of a real bug that synthetic tests missed: Claude Code sends a
prompt as a block array on the first request and as a bare string on the
follow-ups, which split one user turn across two directories. The fixture test
asserts the whole session collapses back into the two turns the user actually
took.

**Capture one of these for your provider.** It is the highest-value test you can
write, and it is cheap — it is a JSON file, not an API call. Trim secrets and
file contents; keep every structural quirk, especially the ones that look like
noise.

## Verifying a refactor did not change behaviour

The committed sample logs in `log/` double as a golden corpus. The renderer is a
pure function of them, so:

```bash
npm run report && git status --short log
```

Clean output means the Markdown regenerated byte-for-byte. This caught the
provider refactor end to end, including logs written before the `provider` field
existed.
