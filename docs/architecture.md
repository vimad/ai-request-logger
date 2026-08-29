# Architecture

## The split

```
                         ┌──────────────────────────────────────┐
   your AI client  ──────▶            src/core/                 │
   (claude, cursor…)     │  forward bytes · parse SSE frames    │
                         │  build the log tree · render rollups │
                         └───────────────┬──────────────────────┘
                                         │  asks, never assumes
                                         ▼
                         ┌──────────────────────────────────────┐
                         │      Provider  (core/types.ts)       │
                         └───────────────┬──────────────────────┘
                                         │  implemented by
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
              src/claude/         src/cursor/  (yours)   src/codex/  (yours)
```

`src/core/` is a transparent reverse proxy that happens to keep a very
opinionated diary. It knows about HTTP, gzip, SSE framing, directories and
Markdown. It does **not** know what a message, a tool call or a token is — every
time it needs one of those it calls the provider.

## Directory map

```
src/
  index.ts              CLI: flags, banner, signal handling
  providers.ts          the registry — the one file you edit to add a provider
  core/
    types.ts            ★ the Provider contract + on-disk record types
    config.ts           flags and env; resolves which provider is active
    server.ts           the HTTP server and its timeouts
    proxy.ts            transparent forwarding; asks the provider about payloads
    sse.ts              SSE frame parsing — transport only, no semantics
    logger.ts           the session / turn / request tree on disk
    markdown.ts         Markdown atoms: fences, scroll boxes, tables, bars
    render.ts           turn.md, session.md, index.md rollups
    report.ts           offline re-render of a captured log tree
    util.ts             slug, sha1, timestamps, preview, timing
  claude/               ← the reference provider
    index.ts            the Provider object; wires the three files below together
    turns.ts            turn detection: session ids, subagents, reminders
    messages.ts         SSE deltas → one message; usage / stop reason / tool calls
    render.ts           Anthropic content blocks, the token table, request.md
```

★ Read `src/core/types.ts` first. It is short, and it is the whole agreement.

## How one request flows

Follow [`src/core/proxy.ts`](../src/core/proxy.ts). Provider calls are marked ▸.

1. **Buffer the request body.** The whole body is read before forwarding, because
   the log wants a parsed copy and the upstream wants a byte-exact one.
2. **Parse if it claims to be JSON.** Only when `content-type` contains `json`.
3. ▸ **`isInferenceEndpoint(url)`** — does this path carry a prompt, or is it
   plumbing (token counting, a warm-up ping)?
4. ▸ **`describeRequest({ body, headers, path, isInference })`** → a
   `RequestShape`, or `undefined` when the body is not something this provider
   recognises. Unrecognised traffic is still proxied and still logged — just
   without a session or turn, under `session-non-messages-traffic/`.
5. **Open a log entry.** `LogStore.begin()` picks the session directory from
   `shape.sessionId` and the turn from `shape.kind` / `shape.turnKey`, then
   writes `request.json`.
6. **Forward.** Every header is relayed verbatim except RFC 9110 hop-by-hop
   headers; `host` is rewritten. The credential goes through untouched.
7. **Relay the response unbuffered**, teeing a decompressed copy into a sink.
   Streaming clients abort a stream that goes quiet, so nothing is held back.
8. ▸ **`reconstructMessage(events)`** — for SSE replies, rebuild the single
   message object a non-streaming call would have returned.
9. ▸ **`responseFacts(message, body)`** → `{ usage, stopReason, toolCalls }`,
   the only response facts the core rolls up.
10. ▸ **`renderer.request(...)`** writes `request.md`; ▸ **`renderer.tokens()`**
    and ▸ **`renderer.usageTable()`** feed the turn and session rollups.

Steps 1, 2, 5, 6, 7 are the same for every provider. The ▸ steps are the whole
of what a new harness must supply.

## The two seams that keep it generic

### 1. `RequestShape` carries only what the core traffics in

The core needs a session id to pick a directory, a turn key to detect a
boundary, a label to name it, and counts for the summary line. That is all
`RequestShape` holds:

```ts
sessionId, agentId?, parentAgentId?, kind, turnKey, turnLabel,
model?, stream, messageCount, userText, detail?
```

Everything else your provider wants on disk goes in **`detail`**, a free-form
bag. `logger.ts` flattens it into `request.json` alongside the core fields, and
hands the merged object straight back to *your* renderer — so from the
renderer's point of view nothing is nested and nothing is lost.

Claude puts `toolCount`, `toolNames`, `systemChars`, `thinking` and
`toolResults` there. A different harness might put a reasoning-effort setting, a
workspace id, or an attachment count. The core never looks inside.

### 2. Tokens are normalised before they are summed

Anthropic reports `input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`. Another vendor will
report something else. The rollups must add up across all of them, so every
usage object passes through `renderer.tokens()` into a neutral shape:

```ts
interface TokenBreakdown { input, output, cacheRead, cacheWrite, total }
```

`core/render.ts` sums `TokenBreakdown`s and never touches a raw usage object.
Printing is delegated straight back via `renderer.usageTable()`, so a provider
with no cache concept simply omits those rows.

This seam is enforced by a test:
[`test/core/render.test.ts`](../test/core/render.test.ts) drives the rollups with
a fake renderer whose usage shape is `{ in, out }` — deliberately unlike any
real vendor. If a rollup ever reaches for `usage.input_tokens` directly, the
totals stop adding up and the test fails.

## What the core decides, and what it asks

| Decision | Made by |
| --- | --- |
| Which bytes go on the wire | core — always verbatim |
| Which headers are dropped | core — RFC 9110 hop-by-hop only |
| Whether a response is SSE | core — from `content-type` |
| Where an event boundary is | core — `sse.ts`, blank-line framing |
| What an event *means* | **provider** — `reconstructMessage` |
| Whether a path carries a prompt | **provider** — `isInferenceEndpoint` |
| Which session a request belongs to | **provider** — `shape.sessionId` |
| Whether a request opens a new turn | core, from **provider**-supplied `kind` + `turnKey` |
| Directory naming and layout | core — `logger.ts` |
| What `request.md` looks like | **provider** — `renderer.request` |
| What `turn.md` / `session.md` look like | core — `render.ts` |
| How tokens are counted and printed | **provider** — `renderer.tokens` / `usageTable` |

## Turn grouping (generic mechanism, provider-supplied inputs)

The core opens a new turn directory when it sees a `main` request whose
`turnKey` differs from the one in flight. Two kinds never open a turn:

- **`aux`** — background calls the harness makes on its own behalf (titles,
  topic detection, compaction). They fold into the turn in flight.
- **any request with an `agentId`** — a subagent belongs to the turn that
  spawned it.

Deciding *which* requests are `main`, `aux` or `other` is the provider's job.
Claude's rule (see [`src/claude/turns.ts`](../src/claude/turns.ts)): a Messages
call carrying a tool set, whose anchoring user message is not one of the prompts
Claude Code writes to itself, is `main`; other Messages calls are `aux`;
non-Messages calls are `other`.

Because subagent requests interleave with the main thread, `logger.ts` snapshots
`prevMessageCount` **before** each request updates it, and only main-thread
requests move it. That is what makes `request.md`'s "new in this request" diff
correct when a Task is running.
