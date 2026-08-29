# ai-request-logger

A zero-dependency TypeScript reverse proxy that sits between Claude Code and the
Anthropic API and writes every request and response to `log/`, organised the way
you actually debug them:

> **session → turn → provider request**

One thing you ask Claude is a **turn**. Answering it usually takes several calls
to the model — think, run a tool, read the result, think again. Those are the
**provider requests**, and they are numbered inside the turn they belong to.

No npm install, no `node_modules`, no build step. It runs straight off Node's
built-in TypeScript support.

## Requirements

Node **22.18+** (24.x recommended). Nothing else.

## Run it

```bash
node src/index.ts          # or: npm start
```

It prints the exact command to start Claude Code against it. The short version:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

To stop logging, drop the env var. Nothing about your install changes.

### Options

| Flag | Env | Default |
| --- | --- | --- |
| `--port` | `LOGGER_PORT` | `8787` |
| `--host` | `LOGGER_HOST` | `127.0.0.1` |
| `--upstream` | `LOGGER_UPSTREAM` | `https://api.anthropic.com` |
| `--log-dir` | `LOGGER_LOG_DIR` | `log` |
| `--redact=false` | `LOGGER_REDACT=0` | redaction on |
| `--raw-sse=true` | `LOGGER_RAW_SSE=1` | off |
| `--quiet=true` | `LOGGER_QUIET=1` | off |

Point `--upstream` at Bedrock, Vertex, or another gateway and it forwards there
instead.

## What lands on disk

```
log/
  index.md                                 ← start here: every session, linked
  index.jsonl                              one line per provider request, greppable
  2026-08-29T08-41-10__session-<id>/
    session.md                             turns, totals, links      ┐ human view
    session.json                           the same data as JSON     ┘
    turn-001__list-the-files-in-this-repo/
      turn.md                              what was asked, what each request did
      turn.json
      user-input.txt                       the prompt that opened this turn
      req-001__main__claude-opus-5/
        request.md                         ← the readable view of this one call
        request.json                       headers (redacted) + full request body
        response.json                      status, timing, usage, final message
        stream.jsonl                       one JSON line per SSE event, timestamped
      req-002__main__claude-opus-5/        ← the tool-result hop of the same turn
      req-003__aux__claude-haiku-4-5/      ← background call, folded into the turn
      req-004__main__agent-77__.../        ← a subagent's request
    turn-002__now-explain-what-you-found/
    turn-000__background/                  session-level calls with no turn open
```

`response.json` holds a **reconstructed message** for streamed replies: the SSE
deltas are reassembled (text, thinking, and `input_json_delta` fragments parsed
back into real tool inputs) so the body has the same shape a non-streaming
response would have had. `stream.jsonl` keeps the raw event sequence with
millisecond offsets when you need to debug the stream itself.

## The Markdown view

Every `.json` file has a `.md` sibling, written as the proxy runs. Open
`log/index.md` and click down: session → turn → request. Nothing to install, and
it renders in any editor, on GitHub, or in a Markdown previewer.

**`request.md`** — one provider call:

- a **summary table**: status, latency and time-to-first-byte, stop reason,
  transport, how much context went up, whether it was the main loop, a
  background call, or a subagent;
- a **token table**: fresh input, cache write, cache read (with the cache-hit
  percentage of the prompt), output, total;
- the **response** first, because that is usually what you came to read —
  assistant text, thinking (collapsed), and tool calls with their parsed inputs;
- the **conversation**, split into *earlier history* (collapsed) and
  **new in this request** — so on hop 7 of a turn you see the two messages that
  actually changed, not the 40 you have already read;
- system prompt, tool list, parameters and headers, each collapsed.

**`turn.md`** — the whole turn: what you asked, the token cost of answering it,
a table of every provider request with duration bars, and a plain-language
timeline (*"called Bash" → "answered the user"*).

**`session.md`** — turns, totals, model time.

**Nothing is ever truncated.** The prompt bodies are the reason the log exists,
so every block carries its full content. Anything long (over ~1,200 characters
or 24 lines) is placed in a fixed-height box that scrolls, captioned with its
line and character count, so a 200k-token system prompt is fully there without
burying the rest of the page. Long lines scroll sideways rather than wrapping.

Short blocks stay ordinary fenced code — with the fence sized to outlast
whatever backtick runs your prompts contain — so the raw `.md` is still
pleasant to read in a plain editor. Inside a scroll box the content is
HTML-escaped exactly, so text that looks like markup (`<system-reminder>`,
nested ``````js fences) survives verbatim.

The scroll boxes need a renderer that honours inline styles — VS Code's preview,
Obsidian, most Markdown viewers. GitHub strips the `style` attribute, so there
the boxes render at full height: still complete, just not scrollable.

### Re-parsing existing logs

The renderer is a pure function of the JSON, so you can re-run it any time —
over logs captured before you had it, or after you tweak the format:

```bash
npm run report                 # the whole log/ tree
npm run report -- log/<session>          # one session
npm run report -- log/<session>/turn-003__.../   # one turn
```

### How turns are detected

Every request carries the whole conversation. The turn is anchored on the **last
user message that is not a tool-result hand-back** — a message containing a
`tool_result` block is a continuation, never a new turn, even when Claude Code
staples a `<system-reminder>` text block onto it. When that anchor changes, a new
turn directory opens.

Two kinds of request deliberately never open a turn:

- **`aux`** — Claude Code's background calls (conversation titles, topic
  detection, compaction summaries). They carry no tool set, so they are folded
  into the turn in flight.
- **subagent requests** — identified by `x-claude-code-agent-id`, they belong to
  the turn that spawned the Task.

Sessions come from `x-claude-code-session-id`, falling back to `metadata.user_id`
and then to a hash of the conversation prefix.

## Tests

```bash
npm test          # node --test, no dependencies
```

Run against a mock upstream on an ephemeral port, writing to a throwaway log
directory — nothing touches your real `log/`.

| Suite | What it holds the line on |
| --- | --- |
| `turns.test.ts` | Turn boundaries: tool loops stay one turn, reminders and Claude Code's own prompts never open one |
| `proxy.test.ts` | Header pass-through, host rewrite, body fidelity, error relay, and that SSE is **not** buffered |
| `sse.test.ts` | Event parsing across arbitrary chunk splits; rebuilding a message from deltas |
| `markdown.test.ts` | Nothing is truncated, markup is escaped, fences outlast their content |
| `e2e.test.ts` | A whole session through the proxy: turn grouping, files written, credentials redacted in the log but not on the wire, and the offline report matching the live output |

`test/fixtures/real-session.json` holds request bodies captured from an actual
Claude Code session — trimmed of local paths and file contents, but with the
message *shapes* preserved. That fixture exists because of a real bug: Claude
Code sends a prompt as a block array on the first request and as a bare string
on the follow-ups, which split one turn across two directories. Synthetic tests
had missed it.

## Why it doesn't break anything

This is a transparent reverse proxy, not a rewriting gateway:

- **Every header is forwarded verbatim**, apart from RFC 9110 hop-by-hop headers
  and `host`. That matters: `anthropic-beta` is an open-ended list that carries
  new capabilities with each release — and, on a claude.ai login, the OAuth
  capability itself. Stripping it would 401 you or silently disable features.
  There is no allowlist here by design.
- **Credentials pass through untouched**, so `/login`, Pro/Max OAuth, API keys
  and custom headers all keep working. They are redacted in the *logs* only.
- **Nothing is buffered.** Response headers are flushed immediately and every
  upstream chunk — including keep-alive `ping` events and `: ping` comments — is
  relayed the instant it arrives. Claude Code aborts a stream that goes quiet
  during a long think, so the log gets its own decompressed copy via a tee
  rather than sitting in the data path.
- **All paths and methods are proxied**, not just `/v1/messages`: token counting,
  the `HEAD /api/hello` warm-up, and anything a future release adds go through
  untouched. Compressed (`gzip`/`br`) bodies are relayed as-is and decompressed
  only for the log.
- **No socket timeouts.** A turn can think for minutes; nothing here cuts it off.

### What this proxy cannot see

By design, some Claude Code traffic does not use `ANTHROPIC_BASE_URL` and goes to
Anthropic directly — it will not appear in `log/`:

- OAuth token refresh (`platform.claude.com`)
- feature-flag and fast-mode availability checks
- telemetry (disable with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`)
- the WebFetch domain safety check
- claude.ai-hosted MCP connectors, and auto-update downloads

Local MCP servers are unaffected — they never touched the API path.

## A note on the logs

Request bodies contain your full conversation: prompts, file contents, tool
output. Credential headers are replaced with a length and hash by default
(`--redact=false` to keep them), but the bodies are verbatim. `log/` is
gitignored; treat it as sensitive.
