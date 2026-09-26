# Agent X-Ray: the visualizer

An animated, clickable replay of one captured turn, built for **teaching how a
coding agent works**. It reads the log tree and nothing else, never writes to
it, and has no dependencies or build step.

```bash
npm start                                      # terminal 1: the proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude # terminal 2: do a task
npm run viz                                    # terminal 3: http://127.0.0.1:8790
```

| Flag | Env | Default |
| --- | --- | --- |
| `--log-dir` | `LOGGER_LOG_DIR` | `log` |
| `--port` | `VIZ_PORT` | `8790` |
| `--host` | | `127.0.0.1` |

The home page polls the log directory, so turns show up as you capture them.
A turn page that is still growing offers a reload instead of rebuilding under
you mid-explanation.

**Claude Code only, for now.** Sessions from other providers are listed but
cannot be opened.

## What the page shows

1. **The hero.** The prompt you typed, drawn to scale by area against
   everything that was sent to the model for it. Request, token and time
   totals, with model time split from time spent on your machine.
2. **The agent loop** (animated). *You → Claude Code → Claude API*, with a
   terminal for tools and an arc for background calls. Each lap shows the
   request envelope (sized and coloured by what it carries), the model reading
   it (cached and fresh tokens), the streamed reply, the tool running locally,
   and the conversation growing. Narration explains each step in plain
   language, with the real numbers. Next to the stage, **"Inside request N"**
   lists the request's contents to scale and marks every block as re-sent,
   echoed or new. Under it, a real-time Gantt chart: time to first byte, then
   streaming, with gaps on your machine in green and long idle stretches cut
   short.
3. **Every request carries everything.** Every request as a to-scale tower.
   Bands join blocks that are byte-identical to the previous request on the
   same thread. The model's reply hangs under its tower and flows into the
   next one. The headline gives the share of bytes that were pure re-sending.
4. **The request inspector.** A filmstrip of requests and six tabs:
   *Conversation* (role-coloured, with injected context collapsed and flagged
   as such), *System prompt* (outline and search), *Tools* (grouped by
   built-in or MCP server, sized, with the ones used this turn highlighted),
   *Response* (token split and stream timeline), *Params & headers* (beta
   flags explained, rate-limit headers highlighted) and *Raw JSON*.

Clicking any block, anywhere, opens a drawer with its full text, who wrote it,
and every request that carried it.

### Presenting

| Key | |
| --- | --- |
| `Space` | play / pause |
| `←` `→` | step |
| `1`–`4` | speed |
| `N` | narration on/off |
| `F` | stage full-screen |
| `T` | light / dark |

## How it works

```
src/viz/
  server.ts      static files + /api/sessions, /api/turn, /api/raw
  digest.ts      one turn directory → the model the page draws
  public/        vanilla ES modules, no build
    js/main.js       routing, home page, hero
    js/theater.js    the animated loop, the suitcase, the Gantt
    js/matrix.js     every request as a tower
    js/inspector.js  the tabs
    js/drawer.js     the block inspector
```

The one idea in `digest.ts` is a **content-addressed blob store**. Every system
block, tool definition and message content block is normalised, hashed and
stored once. Normalising means dropping the `cache_control` breakpoint that
moves every request, and the `caller` the API adds to a reply that the client
leaves out when it re-sends it. Requests then hold references. That one choice
drives most of the page:

- "re-sent", "echoed" and "new" are set comparisons between a request and the
  previous one on its thread;
- the model's reply in request N and its re-send in request N+1 hash the same,
  which is what the bands in the matrix follow;
- a 10-lap turn that sends ~3 MB over the wire digests to a few hundred KB.

Every block gets a **category** for who wrote it: `system`, `tools`, `prompt`
(you), `reminder` (injected by Claude Code: `<system-reminder>` blocks and
role-`system` messages), `synthetic` (a whole prompt the harness wrote to the
model, like the title call or suggestion mode), `assistant`, `thinking`,
`tool_use`, `tool_result`.

Every request gets a **purpose**: agent loop, subagent, quota check, session
title, next-prompt suggestion, topic detection, compaction. Each comes with a
one-paragraph explanation that the narration and the drawer use. The rules are
in `purposeOf()`, and as with turn detection, a wrong guess costs a label and
nothing more.

`turn-000__background` requests made before the turn (the startup quota probe,
the title call your prompt triggers) are pulled into the first turn's view,
because that is where they belong in the story.

### Rules it keeps

- **Read-only.** The server has no write path. `/api/raw` serves four known
  file names from directories whose names match `[\w.:@-]+`, resolved inside
  the log directory. `test/viz/server.test.ts` tries the obvious escapes.
- **Nothing from a log becomes HTML.** Log text is escaped before the small
  Markdown renderer touches it.
- **No truncation of the record.** The UI clips long blocks for layout but
  always offers the full text, and *Raw JSON* is the file itself.
- **`src/core/` is untouched.** The visualizer depends on core and on
  `src/claude/`, never the other way round.

## Adding another provider

Write a digest that produces the same `VizTurn` shape (categories and purposes
are the vocabulary the front end speaks), dispatch on `session.json.provider`
in `server.ts`, and flip `supported` in `listSessions()`. The front end should
not need to change.
