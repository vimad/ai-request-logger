# The Cursor CLI provider

What `src/cursor/` knows about the Cursor CLI (`agent`), and how it was found
out. None of this comes from vendor documentation — Cursor's agent protocol is
private and undocumented, so every field number below was read off traffic
captured through this proxy.

## Running it

```bash
npm run start:cursor                          # or: npm run dev:cursor
CURSOR_API_ENDPOINT=http://127.0.0.1:8787 agent
```

`npm start -- --provider cursor` and `LOGGER_PROVIDER=cursor npm start` do the
same thing; the script is just the short form.

**You must put the CLI on HTTP/1.1 first.** Add this to
`~/.cursor/cli-config.json`:

```json
{ "network": { "useHttp1ForAgent": true } }
```

By default the agent stream is HTTP/2, which a `node:http` reverse proxy cannot
carry. With the default left in place the CLI still *works* — it just never
reaches the proxy, and the log directory stays empty. That silence is the
symptom to recognise.

`--endpoint http://127.0.0.1:8787` on the command line does the same job as the
environment variable. There is no other base-URL override: the flag and the
variable are the whole of it.

## The two endpoints that matter

Cursor splits one conversation across two calls, which is what makes it
different from a request-per-turn API like Anthropic's.

| Path | Carries |
| --- | --- |
| `/aiserver.v1.BidiService/BidiAppend` | the client pushing events **up** — the user's prompt, tool results, cancellations. One unary call per event. |
| `/agent.v1.AgentService/RunSSE` | one long-lived response carrying the model's side of the **whole run** |

Everything else — `DashboardService/*`, `AnalyticsService/*`,
`AiService/AvailableModels`, `/v1/traces` — is plumbing. `describeRequest`
returns `undefined` for it, so it lands in `session-non-messages-traffic/` and
is still captured verbatim.

## The wire format

Both endpoints are protobuf.

- **`BidiAppend`** is `application/proto`: one bare message, gzipped whole when
  `content-encoding: gzip` is set (which is how a large prompt arrives).
- **`RunSSE`** is `application/connect+proto` going up. Coming back it
  announces `content-type: text/event-stream` **and is not SSE** — it is
  Connect envelopes, `[1 byte flags][4 byte big-endian length][payload]`, with
  bit 0 meaning the payload is gzipped on its own and bit 1 marking the JSON
  trailer. This is why the provider sets `streamFraming` to `binary`: the
  core's SSE parser finds no `data:` lines and yields nothing.

There are no published `.proto` files, so `protobuf.ts` walks the wire format
without a schema and the rest of the provider names the fields it recognises.
Every read is optional — a miss costs a label, never the capture.

### The quirk that will catch you

Inside a `BidiAppend`, field 1 is the event blob **as a hex string**, not as
nested bytes. Read it as bytes and it decodes to nothing at all. `hexMessage()`
is what decodes through it.

Counts and timestamps are decimal strings rather than varints, throughout —
hence `numeric()`, which accepts both.

### Field numbers, as observed

```
BidiAppend {
  1: hex string of the event blob
  2: { 1: conversation id }
  3: sequence number, as a string
}

event {
  1: present only on a user turn {
       2: { 1: { 1: { 1: prompt text, 2: prompt id } } }
       5: run id
       9: { 1: selected model }        // e.g. "auto-smart", "composer-2-fast"
      14: repeated available model
      25: conversation id
     }
  2, 3, 5, 7: tool results, acks, cancels — anything but a turn boundary
}
```

The `RunSSE` reply's frames are keyed by their first field number:

| Field | Meaning |
| --- | --- |
| 1 | run control events |
| 2 | run start — carries the real run id at `10.2` |
| 3 | state snapshot, including the context-window reading at field 5 |
| 4 | one message appended to the transcript |

A field-4 frame carries the message as **JSON** at `3.2` — `{"role": "system" |
"user" | "assistant" | "tool", "content": …}`, assistant content being an array
of `text` / `reasoning` / `tool-call` parts. That JSON is the whole reason this
provider is worth having: the entire prompt, every rule, skill and tool
definition, and the model's replies are all in there.

## Identity: what names a session, and what names a turn

**The session is neither endpoint's own id.** `RunSSE`'s body carries only the
id of the HTTP request that opened it, and the conversation id appears only on
`BidiAppend`. The one value both send, and that one CLI process keeps for its
lifetime, is the `x-blob-encryption-key` header — so that is the session key,
**hashed**, because it is a key and must never become a directory name. The
real run and conversation ids are recorded in `detail` instead.

**Turns are opened by the user's prompt**, which lives in a `BidiAppend`. The
turn key is the prompt's own id, which is unique per message, so the same
question asked twice opens two turns. Every other client event is `aux` and
folds into the turn in flight.

### The one wart

`RunSSE` opens *before* the first prompt is sent, so it cannot name the turn it
belongs to. It is `aux`, and in a one-shot `agent -p …` run it therefore lands
in `turn-000__background/` — which is where the model transcript ends up, while
`turn-001__<the prompt>/` holds the client-side events.

That is the honest mapping given that a turn directory is created when its
first request arrives. In an interactive session with several prompts, later
runs fold into the turn already in flight and it reads correctly. `session.md`
links turn 0 like any other, so nothing is hidden.

## Tokens

Cursor does not report a billing split on this channel. What it reports is how
full the context window is, broken down by what filled it:

| | |
|---|---|
| System prompt | 531 tokens · 1.9k chars |
| Tool definitions | 10,239 tokens · 36.8k chars |
| Rules | 2,910 tokens · 10.5k chars |
| Skills | 1,482 tokens · 5.3k chars |
| **Total** | **16,960** of 256,000 |

So `tokens()` puts the context reading in `input` and leaves `output`,
`cacheRead` and `cacheWrite` at zero rather than inventing them. Note the
consequence for rollups: `turn.md` and `session.md` **sum** these, and summing
successive readings of a growing context window is not a meaningful total. The
per-request number is the one to read.

The totals live at field 5 of a state frame and the component breakdown one
level further in, at `5.3.3` — field 5 repeats its own totals alongside the
components. Later frames report a running total and drop the breakdown, so
`reconstructMessage` keeps the last breakdown that actually had one.

## Terms of use

The agent protocol is private. This reads traffic from an account you are
signed into, on your own machine, and changes nothing on the wire. Cursor may
change or restrict the protocol without notice, and these field numbers will
break when it does — which is why every read degrades to a missing label rather
than a failed capture.
