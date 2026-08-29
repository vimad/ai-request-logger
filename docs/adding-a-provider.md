# Adding a provider

Mirror [`src/claude/`](../src/claude/) — it is laid out the way a provider
should be. The examples below use `cursor` as the name; that provider is now
real, so read [cursor.md](./cursor.md) alongside this for what a second,
awkwardly-shaped harness actually took.

## 0. Capture real traffic first

Do not start from the vendor's API docs. Start from what the harness actually
sends, because the parts that matter (which header carries the session, what a
background call looks like, how the same prompt gets re-encoded between
requests) are usually undocumented.

Run the proxy with **no provider written yet**. Unrecognised traffic is still
captured verbatim:

```bash
node src/index.ts --upstream https://api2.cursor.sh --log-dir /tmp/cursor-capture
CURSOR_API_ENDPOINT=http://127.0.0.1:8787 agent
```

Then read `/tmp/cursor-capture/**/request.json`. Answer these five questions
before writing any code:

1. Which paths carry a prompt? Which are plumbing?
2. Which header (or body field) identifies a session?
3. What distinguishes the main agent loop from the harness's own background
   calls? (A tool set? A model? A flag?)
4. How is a subagent / sub-task marked, if at all?
5. What does the streaming protocol look like, and what does usage look like?

All five had surprising answers for Cursor. The session is named by neither
endpoint, the prompt travels on a different call from the reply, the stream
claims a content-type it does not honour, and "usage" is a context-window
reading rather than a billing split. **Do not assume your harness resembles the
Anthropic Messages API** — that assumption is what step 0 exists to break.

Bodies reach disk byte-exact: text when the bytes are valid UTF-8, and
`{ "__binary": true, "encoding": "base64", … }` when they are not. So a
protobuf or gzipped capture is fully recoverable with
`decodeBody()` from [`core/bytes.ts`](../src/core/bytes.ts).

## 1. Scaffold

```
src/cursor/
  index.ts       the Provider object
  turns.ts       describeRequest + session/turn identity
  messages.ts    reconstructMessage + responseFacts
  render.ts      tokens, usageTable, request  (the ProviderRenderer)
```

A binary protocol earns more files — Cursor adds `protobuf.ts` and `connect.ts`
for the wire format itself, kept separate from anything that knows what a turn
is.

Splitting into four files is convention, not a requirement — but it keeps each
piece independently testable, which is what [testing.md](./testing.md) assumes.

## 2. Write `turns.ts`

The bulk of the work. See
[provider-contract.md § describeRequest](./provider-contract.md#describerequestinput-requestshape--undefined)
for what each returned field drives, and the `turnKey` rules — that is where the
subtle bugs are.

Put anything vendor-specific in `detail`:

```ts
return {
  sessionId, kind, turnKey, turnLabel, model, stream, messageCount, userText,
  detail: { reasoningEffort, workspaceId, attachmentCount },
};
```

## 3. Write `messages.ts`

`reconstructMessage(events)` for the streaming protocol, `responseFacts()` to
pull out usage, stop reason and tool calls. Both must tolerate a truncated
stream — a cancelled request is normal traffic, not an error case.

If your reply is not SSE, add `streamFraming()` returning `"binary"` and a
`decodeStream(body, headers)` that frames it. See
[provider-contract.md](./provider-contract.md#streamframingheaders-sse--binary--none-optional).

## 4. Write `render.ts`

Export a `renderer: ProviderRenderer`. Build `request.md` out of the atoms in
[`core/markdown.ts`](../src/core/markdown.ts); do not hand-roll fences or
truncate anything.

Keep `request()` a pure function of the two JSON objects it is passed. If it
ever reads a live object, `npm run report` will stop reproducing what the proxy
wrote — which is exactly what the e2e test checks.

## 5. Assemble `index.ts`

```ts
import type { DescribeInput, Provider, RequestShape } from "../core/types.ts";
import { reconstructMessage, responseFacts } from "./messages.ts";
import { renderer } from "./render.ts";
import { describeRequest } from "./turns.ts";

const PROMPT_PATH = /\/agent\.v1\.AgentService\/RunSSE(?:\?|$)/;

export const cursor: Provider = {
  id: "cursor",
  label: "Cursor",
  defaultUpstream: "https://api.cursor.sh",
  baseUrlEnvVar: "CURSOR_API_ENDPOINT",
  clientCommand: "agent",

  isInferenceEndpoint: (path) => PROMPT_PATH.test(path),

  describeRequest(input: DescribeInput): RequestShape | undefined {
    return describeRequest(input);
  },

  reconstructMessage,
  responseFacts,
  renderer,
};

export default cursor;
```

## 6. Register it

The only edit outside your own directory —
[`src/providers.ts`](../src/providers.ts):

```ts
import { cursor } from "./cursor/index.ts";

export const providers: Provider[] = [claude, cursor];
```

`defaultProvider` stays `claude` unless you mean to change the no-flag default.

## 7. Test it

See [testing.md](./testing.md). The short version: copy
`test/claude/upstream.ts` into `test/cursor/upstream.ts` and make it speak your
protocol, then reuse the shared harness:

```ts
const h = await startHarness({ provider: cursor, startUpstream: startMockUpstream });
```

`sendRaw(path, buffer, headers)` posts bytes, for a provider whose bodies are
not JSON.

## 8. Run it

```bash
node src/index.ts --provider cursor
npm test
npx tsc --noEmit
```

The banner prints the right env var and upstream, and lists the other
registered providers.

---

## Checklist

- [ ] Captured real traffic before writing code
- [ ] `id` is lowercase, filesystem-safe, and will never change
- [ ] `isInferenceEndpoint` anchors tightly enough to exclude sub-paths
- [ ] `describeRequest` returns `undefined` (not a throw) for bodies it does not recognise
- [ ] `turnKey` survives a tool loop, ignores injected noise, is encoding-independent, and separates a repeated prompt
- [ ] Background/self-issued calls are `aux`, not `main`
- [ ] Subagent requests set `agentId`
- [ ] Vendor-only fields are in `detail`, not bolted onto `RequestShape`
- [ ] A stream that is not SSE declares `streamFraming` and `decodeStream`
- [ ] Nothing secret becomes a directory name — hash it if you key on a credential
- [ ] `tokens()` tolerates `undefined` and unknown shapes
- [ ] `renderer.request()` reads only its two arguments
- [ ] Registered in `src/providers.ts`
- [ ] `grep -rn "<your id>" src/core/` prints nothing
- [ ] `npm test` and `npx tsc --noEmit` are clean

## Anti-patterns

**Adding a field to `RequestShape` for one vendor.** That is what `detail` is
for. Every field on `RequestShape` is one more thing the next provider must
supply meaningfully.

**Reading raw usage fields in `core/render.ts`.** Go through
`renderer.tokens()`. The fake-renderer test exists to catch this.

**Importing from `src/claude/` in your provider.** If you want a helper Claude
has, promote it to `src/core/util.ts` or `core/markdown.ts` first. Providers must
not depend on each other.

**Making `renderer.request()` clever about live state.** It runs offline over
old JSON far more often than it runs live.

**Truncating anything.** The prompt bodies are the point of the log. Use
`block()`, which scroll-boxes instead of cutting.
