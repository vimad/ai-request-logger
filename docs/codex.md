# The Codex CLI provider

What `src/codex/` knows about the `codex` CLI, and how it was found out — by
running the proxy with no provider written, then driving the real `codex` CLI
against it (`codex exec "…"`), against a live ChatGPT-authenticated account.
Every quirk below was read off that capture, not off OpenAI's public API docs
— Codex's actual wire traffic differs from the documented Responses API in
several ways that matter.

## Running it

```bash
npm run start:codex                          # or: npm run dev:codex
codex -c model_providers.local.name="local" \
      -c model_providers.local.base_url="http://127.0.0.1:8787" \
      -c model_providers.local.wire_api="responses" \
      -c model_provider="local"
```

`npm start -- --provider codex` and `LOGGER_PROVIDER=codex npm start` do the
same thing; the script is just the short form.

**There is no base-URL environment variable.** Codex refuses outright to let
you repoint its built-in `openai` provider:

```
Error loading config.toml: model_providers contains reserved built-in
provider IDs: `openai`. Built-in providers cannot be overridden.
```

So the only way in is to define a *new* named provider and select it, on every
invocation, with the three `-c` overrides above. `Provider.baseUrlEnvVar` has
nothing truthful to hold in this case, so `banner.invocation` (a `BannerNotes`
field added for this provider) replaces the whole `$ENV=url client` line the
banner would otherwise print. Whatever auth mode is already active — ChatGPT
login (`codex login`) or an API key — is picked up by the new provider entry
automatically; nothing about auth changes.

## The one endpoint that matters

Everything the agent loop does goes through a single endpoint:

| Path | Carries |
| --- | --- |
| `POST /responses` | the whole conversation, replayed in full on every request — model, system/developer prompt, tool declarations, and the transcript so far |

`GET /models`, and other plumbing, are unary JSON and carry no conversation;
`describeRequest` returns `undefined` for anything that is not `/responses`,
so they land in `session-non-messages-traffic/`.

## The wire format

`/responses` is OpenAI's public Responses API shape — `input: [...]` items in,
`response.output_item.*` / `response.output_text.*` SSE events back — but two
things about how Codex actually drives it are not in the public docs:

**No `content-type` header on the streaming reply.** The response is real SSE
(`event: response.created\ndata: {...}\n\n`, blank-line framed) but the
backend never sends `content-type: text/event-stream`, or any `content-type`
at all. The core's default stream-framing sniff (`content-type` includes
`text/event-stream`) finds nothing, so this provider's `streamFraming` ignores
`content-type` entirely and returns `"sse"` for anything that is not
`application/json` — `/models` is the one endpoint that *does* declare
`application/json`, which is the one signal available to tell the two apart.

**The final `response.completed` event ships an empty `output: []`.** The
request carries `x-openai-internal-codex-responses-lite: true`; under this
"lite" streaming mode the real content only ever appears in the per-item
`response.output_item.done` events along the way, never duplicated into the
terminal event. `reconstructMessage` therefore treats the accumulated items,
not `response.completed.response.output`, as the source of truth — falling
back to the latter only when it is genuinely non-empty, for a non-lite
backend.

**Tools arrive as one `additional_tools` input item, not a top-level `tools`
array**, and nest a `collaboration` sub-agent namespace inside it
(`spawn_agent`, `send_message`, …) — so `toolNamesOf` walks one level of
nesting rather than mapping a flat list. Tool *calls* come back as
`custom_tool_call` items named `exec`: Codex routes every tool through one
JS-orchestration tool rather than one function per tool, so `toolCalls` in
practice is almost always just `["exec"]`.

## The abort that isn't one

**A client that has what it needs disconnects immediately** — before the
proxy's own connection to the upstream has formally ended. This is not a
Codex-only failure mode (any client racing an early disconnect against a
lingering upstream socket can hit it), but it was Codex that exposed it: three
of four live captures against the real backend during development ended with
`up.on("error")` firing `"aborted"` *after* the entire SSE stream, including
`response.completed`, had already arrived and been written to `stream.jsonl`.

The original core behaviour discarded the whole capture on this path — no
`usage`, no `stopReason`, no reconstructed body — even though the transport
layer had recorded everything. `src/core/proxy.ts`'s `up.on("error")` handler
now finishes the same way a clean `end` would (draining the sink, decoding
whatever events arrived, reconstructing the message) and only *labels* the
result with the error, rather than throwing the facts away. This is
core-level and framing-agnostic — it benefits every provider that streams SSE,
not just this one — but Codex is what surfaced it, because it disconnects far
more eagerly than an interactive Claude Code or Cursor session does.

## Identity: what names a session, and what names a turn

**The session id is the `session-id` (and matching `thread-id`) header**,
repeated inside the body at `client_metadata.session_id` /
`client_metadata.thread_id` and again as `prompt_cache_key` — any of the four
works as a fallback if a client only sets one.

**The turn is anchored on the last `input` item with `type: "message"` and
`role: "user"`.** Unlike Claude Code, Codex cleanly separates its own injected
noise from what the user typed: the *first* request of a session carries an
extra `role: "user"` item ahead of the real one, bundling
`<recommended_plugins>` and `<environment_context>` — but it is a distinct
array element, not merged into the real prompt's content the way Claude Code's
`<system-reminder>` blocks are. So "last user-role message item" always lands
on the real prompt with no stripping required; the turn key is a straight hash
of its text, index-prefixed so the same prompt asked twice still opens two
turns.

**Whether a request is `main` or `aux` is a header, not a guess.**
`x-codex-turn-metadata` carries `request_kind` as JSON (repeated inside the
body at `client_metadata` too) — the only value observed so far is `"turn"`
for a real user-driven turn. `kind` is `"main"` exactly when `request_kind ===
"turn"`; anything else, including a missing header, degrades to `"aux"` and
just folds into the turn in flight, per the provider contract's "being wrong
here is cheap" rule.

**Sub-agents are inferred from `x-codex-window-id`** (`<thread_id>:<window>`,
root window `0`) — unconfirmed against a real spawned sub-agent capture, since
producing one live would have meant spending more of a real account's quota
than this investigation justified. Same rule applies: a wrong guess here just
folds the request into the turn in flight rather than losing it.

## Tokens

The usage object is close to, but not quite, the standard Responses API shape:

```json
{
  "input_tokens": 10973,
  "input_tokens_details": { "cached_tokens": 9984, "cache_write_tokens": 0 },
  "output_tokens": 10,
  "output_tokens_details": { "reasoning_tokens": 0 },
  "total_tokens": 10983
}
```

`cache_write_tokens` alongside `cached_tokens` is Codex's own addition.
`input_tokens` already *counts* cached tokens rather than being additional to
them, so `tokens()` splits it — `input = input_tokens - cached_tokens` — the
same way Claude's fresh/cache-write/cache-read split works, so the two
providers' `usageTable()` rollups read the same way.

## Terms of use

This reads traffic from an account you are signed into, on your own machine,
and changes nothing on the wire — the real credential (ChatGPT OAuth bearer
token or API key) is forwarded verbatim; only the copy on disk is redacted.
Every request captured against the real backend during development was a
short, deliberate, single-turn `codex exec` call.
