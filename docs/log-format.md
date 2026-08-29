# The log format

Written by [`src/core/logger.ts`](../src/core/logger.ts), re-rendered offline by
[`src/core/report.ts`](../src/core/report.ts). The **tree and the JSON keys are
core** — every provider produces the same layout. Only `shape.detail`, the
`usage` blob, and the Markdown inside `request.md` are provider-shaped.

> `log/` is **gitignored**. Nothing under it is tracked; treat it as scratch.

## The tree

```
log/
  index.md                                  landing page: every session, linked
  index.jsonl                               one line per provider request, append-only
  <stamp>__session-<id>/
    session.md  session.json                turns, totals, model time
    turn-000__background/                   folded calls: titles, topics, compaction
    turn-001__<slug-of-what-you-asked>/
      turn.md  turn.json                    what was asked + every request in it
      user-input.txt                        the prompt that opened the turn
      req-001__main__<model>/
        request.json                        the capture
        response.json                       the capture
        request.md                          the readable view (provider-rendered)
        stream.jsonl                        one line per SSE event, with timings
        stream.raw.txt                      only with --raw-sse=true
```

Directory names come from `RequestShape`:

| Path segment | Source |
| --- | --- |
| `session-<id>` | `shape.sessionId`, slugged to 40 chars |
| `turn-NNN__<slug>` | turn index + `shape.turnLabel`, slugged to 40 chars |
| `req-NNN__<kind>[__agent-<id>][__<model>]` | request number, `shape.kind`, `shape.agentId`, `shape.model` |

`turn-000__background` is the fallback bucket: `aux` and subagent requests land
in the turn in flight, or here if none has opened yet. Traffic the provider
could not describe at all lands in `…__session-non-messages-traffic/` with
`kind: "raw"`.

## `request.json`

```jsonc
{
  "at": "2026-08-29T11:27:23.627Z",
  "provider": "claude",          // which Provider captured this
  "session": "e07540ef-…",
  "turn": 1,
  "request": 1,
  "method": "POST",
  "path": "/v1/messages?beta=true",
  "upstream": "https://api.anthropic.com/v1/messages?beta=true",
  "client": "127.0.0.1",

  "shape": {                     // core fields, then detail, flattened
    "kind": "main",
    "model": "claude-opus-5",
    "stream": true,
    "messageCount": 2,
    // ── everything below came from shape.detail ──
    "toolCount": 59,
    "toolNames": ["Agent", "Bash", "..."],
    "systemChars": 12043,
    "thinking": false,
    "toolResults": []
  },

  "headers": { /* credentials redacted unless --redact=false */ },
  "body":    { /* the parsed request body, verbatim */ }
}
```

### Bodies that are not text

`body` is the parsed JSON when the request claimed to be JSON, and the body as
text otherwise — but only when the bytes are valid UTF-8. When they are not,
they are stored losslessly instead:

```jsonc
"body": { "__binary": true, "encoding": "base64", "bytes": 4586, "data": "H4sIA…" }
```

`Buffer.toString("utf8")` replaces every invalid sequence with U+FFFD and there
is no way back, so a protobuf or gzipped body would be silently destroyed by
the text path. `decodeBody()` in [`core/bytes.ts`](../src/core/bytes.ts) reads
either form back. The same rule applies to `response.json`'s `body`.

**The flattening is deliberate.** `RequestShape.detail` is spread into `shape`
rather than nested, so your renderer reads `shape.toolCount`, not
`shape.detail.toolCount`. The core writes the first block and never inspects the
second.

`agentId` and `parentAgentId` appear here too when the provider sets them.

## `response.json`

```jsonc
{
  "at": "…", "status": 200,
  "error": undefined,                       // set if the proxy itself failed
  "timing": { "ttfbMs": 412.3, "durationMs": 3180.7 },
  "sseEvents": 214,                         // streamed replies only
  "headers": { /* redacted */ },

  "usage":      { /* opaque to core; your tokens() reads it */ },
  "stopReason": "end_turn",
  "toolCalls":  ["Bash"],

  "body": { /* for a stream, the object reconstructMessage rebuilt */ }
}
```

`usage`, `stopReason` and `toolCalls` are exactly what your `responseFacts()`
returned. `body` is the reconstructed message for SSE and the parsed response
for everything else — the point being that both look the same downstream.

`usage` may be far richer than `tokens()` reads; Anthropic nests
`cache_creation`, `iterations` and more in there. The whole blob is kept, and
your `tokens()` picks out the four numbers the rollups need.

## `turn.json` and `session.json`

`turn.json` holds a `requests[]` of `TurnRequestSummary` — the row type the
rollups render. `session.json` records the provider id and an index of turns.
Both are typed in [`core/types.ts`](../src/core/types.ts).

**`session.json.provider` is what makes offline re-rendering work.**
`report.ts` reads it per session and picks the matching renderer, so a log
directory holding several providers regenerates correctly. Unknown or missing
ids fall back to the default provider, which is what lets logs captured before
the field existed still render.

## `index.jsonl`

One append-only line per provider request — the thing to grep or pipe into `jq`:

```json
{"at":"…","provider":"claude","session":"non-messages-traffic","turn":0,
 "request":1,"path":"/api/hello","n":1,"dir":"…/req-001__raw","kind":"raw",
 "status":200,"durationMs":294.9,"messageCount":0}
```

## `stream.jsonl`

One line per event: `{ at, event, data }`, where `at` is milliseconds since the
upstream request was sent. For SSE this is the transport-level record, written
before any provider interprets it, so it survives a `reconstructMessage` that
gets something wrong.

A provider using `binary` framing produces these from `decodeStream` once the
body is complete, so it has no per-frame arrival time and writes `at: 0`. Order
is still the line order.

## Rules for renderers

`request.md` is regenerated from `request.json` + `response.json` alone, months
after capture, by a possibly newer version of your renderer. So:

- **Read only the two arguments.** No live state, no filesystem, no clock.
- **Be defensive.** You will meet logs missing fields you now assume.
- **Never truncate.** Use `block()` from `core/markdown.ts`, which promotes long
  content into a scroll box with escaped HTML instead of cutting it.
- **Distinguish "absent" from "zero".** A request that reported no usage renders
  `-`; one that genuinely used nothing renders `0`. Zero-filling an error row
  claims the request was free.

The end-to-end test asserts a live-written `turn.md` equals the offline
re-render of the same data. Break purity and that test fails.
