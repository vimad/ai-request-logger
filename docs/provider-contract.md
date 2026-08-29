# The `Provider` contract

Defined in [`src/core/types.ts`](../src/core/types.ts). Implemented for Anthropic
in [`src/claude/index.ts`](../src/claude/index.ts), which is deliberately thin —
it wires together three files that do the real work.

```ts
export interface Provider {
  id: string;
  label: string;
  defaultUpstream: string;
  baseUrlEnvVar: string;
  clientCommand: string;
  banner?: BannerNotes;

  isInferenceEndpoint(path: string): boolean;
  describeRequest(input: DescribeInput): RequestShape | undefined;
  streamFraming?(headers): "sse" | "binary" | "none";
  decodeStream?(body: Buffer, headers): SseEvent[];
  reconstructMessage(events: SseEvent[]): Record<string, unknown> | undefined;
  responseFacts(message, body): ResponseFacts;

  renderer: ProviderRenderer;
}
```

Each member below lists **what the core does with it**, then the Claude answer.

---

## `id`

Lowercase, stable, filesystem-safe. Selected with `--provider <id>` /
`LOGGER_PROVIDER`, and written into `session.json`, `request.json` and
`index.jsonl` so [`report.ts`](../src/core/report.ts) can re-render an old log
with the right renderer, even in a directory holding several providers.

Never change it after logs exist in the wild.

> **Claude:** `"claude"`

## `label`

Free text for the startup banner only.

> **Claude:** `"Claude Code / Anthropic Messages API"`

## `defaultUpstream`

Where traffic goes when neither `--upstream` nor `LOGGER_UPSTREAM` is set.
Resolved in [`config.ts`](../src/core/config.ts), so `--provider cursor` alone is
enough to point the proxy somewhere else.

> **Claude:** `"https://api.anthropic.com"`

## `baseUrlEnvVar`

The env var the *client* reads to find this proxy. Used only to print a correct
copy-paste line in the banner.

> **Claude:** `"ANTHROPIC_BASE_URL"`
> **Cursor:** `"CURSOR_API_ENDPOINT"`

## `clientCommand`

The command the user types to start this client. Banner only — it is what makes
the copy-paste line say `agent` rather than `claude`.

> **Claude:** `"claude"` · **Cursor:** `"agent"`

## `banner`  *(optional)*

The parts of the startup banner only you can fill in. The core prints the
shape; **anything you leave unset drops its section**, because a banner that
guesses is worse than a shorter one.

```ts
interface BannerNotes {
  setup?: string;          // something the user must do first
  projectConfig?: string;  // a project-scoped file that can carry the variable
  credentials?: string;    // what happens to their existing login
  backgroundTurn?: string; // what you file under turn-000__background/
}
```

> **Claude:** a `.claude/settings.local.json` env block, and turn 0 holds
> "titles, topic detection, compaction".
>
> **Cursor:** `setup` warns that the CLI needs `useHttp1ForAgent` or it bypasses
> the proxy silently; there is no per-project config file, so that section is
> simply absent.

If you find yourself wanting to special-case your provider inside
[`src/index.ts`](../src/index.ts), add a field here instead — the banner is the
one place vendor text kept leaking back into the generic half.

---

## `isInferenceEndpoint(path): boolean`

Does this path carry a prompt worth structuring, as opposed to plumbing? The
result is passed to `describeRequest` as `isInference`, which normally turns it
into `kind: "other"` for plumbing.

The path is the raw request URL including any query string. Match narrowly —
`/v1/messages/count_tokens` must **not** match a rule meant for
`/v1/messages`.

> **Claude:**
> ```ts
> const MESSAGES_PATH = /\/v1\/messages(?:\?|$)/;
> ```
> The `(?:\?|$)` anchor is what keeps `count_tokens` out.

---

## `describeRequest(input): RequestShape | undefined`

The most important method. Everything about how traffic is grouped comes from
here.

```ts
interface DescribeInput {
  body: unknown;      // parsed JSON, or undefined if not JSON
  bodyBuf: Buffer;    // the request body verbatim
  headers: Record<string, string>;   // lowercased
  path: string;
  isInference: boolean;              // your own isInferenceEndpoint(path)
}
```

`body` is only populated when `content-type` contains `json`. A provider with a
binary wire format reads `bodyBuf` instead — that is what
[`src/cursor/turns.ts`](../src/cursor/turns.ts) does, gunzipping it and walking
it as protobuf.

Return `undefined` when the body is not something you recognise. That is not an
error: the request is still proxied and still captured, it just lands in
`…__session-non-messages-traffic/turn-000__background/` with `kind: "raw"`.

### What each field drives

| Field | What the core does with it |
| --- | --- |
| `sessionId` | Picks/creates the session directory. Must be stable for a whole session. |
| `kind` | `"main"` can open a turn; `"aux"` and `"other"` never do. |
| `turnKey` | A new turn opens when a `main` request's key differs from the one in flight. |
| `turnLabel` | Slugged into the turn directory name and used as its heading. |
| `agentId` | Non-empty means "subagent" — folds into the turn in flight, and appears in the request directory name. |
| `parentAgentId` | Logged only. |
| `model` | Request directory name, summary tables. |
| `stream` | Shown in `request.md` as the transport. |
| `messageCount` | Drives the "new in this request" diff and the console line. |
| `userText` | Written to `user-input.txt` and shown as "What was asked". |
| `detail` | Merged verbatim into `request.json`; handed back to your renderer. |

### Getting `turnKey` right

This is where the subtle bugs live. A turn key must be:

- **stable across the whole agent loop** — a tool call, its result, and the
  follow-up request are all one turn;
- **insensitive to noise the harness injects** — anything whose content changes
  request-to-request must be stripped before hashing;
- **insensitive to encoding** — the same prompt sent as a string and as a block
  array must hash identically;
- **different for the same prompt asked twice** — so include a position.

> **Claude:** anchors on the last user message that is *not* a tool-result
> hand-back, strips `<system-reminder>` blocks, normalises block-array and bare-
> string content to the same fingerprint, and prefixes the anchor's index:
> ```ts
> turnKey: `${anchorIndex}:${sha1(anchorFingerprint(anchor?.content)).slice(0, 16)}`
> ```
> Two of these rules exist because of real captured bugs — see
> [testing.md](./testing.md#the-fixture).

### Classifying `kind`

> **Claude:** non-Messages → `"other"`. Otherwise: carries a tool set **and**
> the anchoring prompt is not one Claude Code writes to itself (`[SUGGESTION
> MODE:…`, `[No response requested…`) → `"main"`; everything else → `"aux"`.
>
> Being wrong here is cheap and deliberately so: a misclassified request is
> still logged, just folded into the turn in flight instead of opening its own.

---

## `streamFraming(headers): "sse" | "binary" | "none"`  *(optional)*

How the core should read its copy of the response body. Omit it and the core
uses `sse` when `content-type` says `text/event-stream` and `none` otherwise,
which is what a JSON+SSE provider wants.

Return `binary` when the body is framed some other way. The core then buffers
its **own copy** and hands the whole thing to `decodeStream` at the end; the
relay to the client stays unbuffered either way, so a streaming client still
sees bytes the moment they arrive.

> **Cursor:** `binary` for the agent stream, which announces
> `text/event-stream` and then sends Connect envelopes rather than `data:`
> lines. Without this the core's SSE parser would find nothing and
> `response.json` would have no body.

## `decodeStream(body, headers): SseEvent[]`  *(required with `binary`)*

Frame a whole response body into events. Same `SseEvent` shape the SSE parser
produces, so `stream.jsonl` and `reconstructMessage` do not care which framing
produced them.

Because the body arrives all at once there is no per-frame arrival time; set
`at` to 0 and carry the ordering in the data, as Cursor does with its sequence
numbers.

> **Cursor:** splits Connect envelopes, gunzips any frame flagged compressed,
> and walks each payload as protobuf. A truncated tail becomes a `truncated`
> event rather than an exception — a cancelled run is normal traffic.

## `reconstructMessage(events): object | undefined`

Turn a stream of SSE events into the single object a non-streaming call would
have returned, so `response.json` has one shape either way.

The core has already done the transport work: `SseEvent` is
`{ at, event, data }` where `at` is ms since the request was sent and `data` is
parsed JSON (or the raw string if it would not parse). You only handle
semantics.

Return `undefined` if the stream never carried a message — the core then leaves
`response.json` without a body rather than inventing one.

> **Claude:** [`src/claude/messages.ts`](../src/claude/messages.ts) walks
> `message_start` → `content_block_start` → `content_block_delta` →
> `content_block_stop` → `message_delta`, accumulating text, `partial_json` and
> thinking deltas per block index. Unparseable tool JSON is preserved as
> `{ __unparsed_partial_json: "…" }` rather than dropped.

## `responseFacts(message, body): ResponseFacts`

```ts
interface ResponseFacts { usage?: unknown; stopReason?: string; toolCalls?: string[]; }
```

Called with the reconstructed `message` for streamed replies and with the parsed
`body` for non-streamed ones — handle both. These three facts are all the core
surfaces in the console line, `turn.md` and `index.jsonl`.

`usage` stays opaque here; it is normalised later by `renderer.tokens()`.

> **Claude:** reads `usage`, `stop_reason`, and the `name` of every `tool_use`
> content block, from whichever of the two objects it was given.

---

## `renderer: ProviderRenderer`

```ts
interface ProviderRenderer {
  tokens(usage: unknown): TokenBreakdown;
  usageTable(t: TokenBreakdown | undefined): string;
  request(req: unknown, res: unknown, opts: RenderRequestOptions): string;
}
```

### `tokens(usage)`

Normalise your vendor's usage object into
`{ input, output, cacheRead, cacheWrite, total }`. Must tolerate `undefined` and
garbage — it runs over old logs. Zero-fill anything your vendor does not report.

`total` is yours to define; it is what `index.md` and the session table show.

> **Claude:** `total = input + output + cacheRead + cacheWrite`.

### `usageTable(breakdown)`

Render the token table shown in `request.md`, `turn.md` and `session.md`. It is
handed a `TokenBreakdown`, never a raw usage object, so the same function serves
a single request and a summed rollup. Return something sensible for `undefined`.

> **Claude:** splits the prompt into fresh / cache-write / cache-read and shows
> the resulting cache-hit rate, hiding the cache rows when nothing was cached.
> Returns `_No usage reported._` for `undefined`.

### `request(req, res, opts)`

The whole of `request.md`. `req` is the parsed `request.json`, `res` the parsed
`response.json` — **not** live objects. This matters: it is what lets
`npm run report` regenerate identical Markdown from disk months later. Keep it a
pure function of its two arguments, and be defensive, because it will meet logs
written by an older version of itself.

`opts.prevMessageCount` is how many messages the previous main-thread request in
this turn carried — use it to show only what is new.

Compose from the atoms in [`core/markdown.ts`](../src/core/markdown.ts)
(`block`, `details`, `table`, `json`, `bytes`, `duration`, `num`, `bar`) rather
than hand-rolling. `block()` in particular never truncates: it promotes long
content into a fixed-height scroll box with escaped HTML, which is why a 200k
prompt does not bury the page.
