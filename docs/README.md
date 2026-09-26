# Architecture docs

This directory explains how `ai-request-logger` is put together, and — the point
of it — **how to teach it a new AI harness** (Aider, an internal gateway, …)
without touching the proxy itself.

The repo started as a Claude-Code-only proxy. It is now a generic proxy plus
three *providers*. Claude is not privileged; it is the worked example that
every doc here points at. Cursor is the one to read when your harness does not
speak JSON. Codex is the one to read when your harness speaks JSON but lies
about its own transport (no `content-type` on a real SSE stream, a client that
disconnects the moment it has what it needs).

## Read in this order

| Doc | What it answers |
| --- | --- |
| [architecture.md](./architecture.md) | What is generic, what is provider-specific, and how a request flows through both |
| [provider-contract.md](./provider-contract.md) | Every member of the `Provider` interface, with the Claude implementation as the reference answer |
| [adding-a-provider.md](./adding-a-provider.md) | The step-by-step recipe, start to finish |
| [testing.md](./testing.md) | How the suite is split, and what to write for a new provider |
| [log-format.md](./log-format.md) | The on-disk tree, and which parts a provider controls |
| [cursor.md](./cursor.md) | The Cursor CLI provider: its protocol, and what it took to read it |
| [codex.md](./codex.md) | The Codex CLI provider: its protocol, and what it took to read it |
| [visualizer.md](./visualizer.md) | Agent X-Ray: the animated, clickable turn replay for teaching |

## The one-paragraph version

`src/core/` is a transparent reverse proxy. It relays bytes, parses SSE frames,
groups requests into a session → turn → request tree on disk, and renders the
rollups. It names no vendor. Everything that knows what a *message* or a *token*
is lives behind the `Provider` interface in
[`src/core/types.ts`](../src/core/types.ts), implemented for Anthropic in
[`src/claude/`](../src/claude/). Adding a harness means writing one object and
registering it in [`src/providers.ts`](../src/providers.ts).

## The rule that keeps it honest

> **`src/core/` must never import from `src/claude/` or any other provider
> directory.**

The dependency arrow points one way: providers depend on core, core depends on
the `Provider` contract. You can check it in one command:

```bash
grep -rn "claude\|cursor" src/core/    # should print nothing
```

If that ever returns a hit, a vendor detail has leaked into the generic half and
the next provider will have to work around it.
