# CLAUDE.md

Zero-dependency TypeScript reverse proxy that logs AI coding-agent API traffic as
a **session → turn → provider request** tree. No build step; runs on Node's
built-in TypeScript support. Node 22.18+.

```bash
node src/index.ts        # run the proxy   (npm start)
npm test                 # node --test, ~1s, no network
npx tsc --noEmit         # typecheck src/ and test/
npm run report           # re-render a captured log tree
```

## Architecture in one line

`src/core/` is a provider-agnostic proxy; everything vendor-specific sits behind
the `Provider` interface in `src/core/types.ts` and lives in `src/<provider>/`.
`src/claude/` is the reference implementation.

## Adding support for a new AI harness

**Read [`docs/`](./docs/) before writing code.** That is the whole point of that
directory.

| Start here | For |
| --- | --- |
| [docs/README.md](./docs/README.md) | Orientation |
| [docs/architecture.md](./docs/architecture.md) | What is generic vs. provider-specific, and how a request flows |
| [docs/provider-contract.md](./docs/provider-contract.md) | Every `Provider` member, with the Claude answer as reference |
| [docs/adding-a-provider.md](./docs/adding-a-provider.md) | The step-by-step recipe and checklist |
| [docs/testing.md](./docs/testing.md) | How the suite is split; what to write for a new provider |
| [docs/log-format.md](./docs/log-format.md) | The on-disk records and the rules renderers must obey |

The recipe in short: capture real traffic first with the proxy running and no
provider written, write `src/<name>/{index,turns,messages,render}.ts`, register
it in `src/providers.ts`, mirror the tests under `test/<name>/`.

## Invariants — do not break these

1. **`src/core/` must never import from a provider directory.**
   `grep -rn "claude" src/core/` prints nothing. Keep it that way.
2. **Vendor fields go in `RequestShape.detail`,** never as new top-level fields
   on `RequestShape`. The logger flattens `detail` into `request.json`.
3. **Token counts go through `renderer.tokens()`** into the neutral
   `TokenBreakdown`. Core rollups never read a raw usage object.
   `test/core/render.test.ts` enforces this with a fake renderer.
4. **`renderer.request()` is a pure function of `request.json` + `response.json`.**
   The e2e test asserts the offline re-render equals what the proxy wrote live.
5. **Never truncate logged content.** Use `block()` from `core/markdown.ts`.
6. **The proxy is transparent.** Headers forwarded verbatim apart from RFC 9110
   hop-by-hop; credentials relayed untouched and redacted only in the log.

## Notes

- `log/` is gitignored — nothing under it is tracked.
- Tests never call a real API; they run against a local mock upstream on an
  ephemeral port. Fixtures can be large and realistic because they are free.
- Verifying a render refactor: render the same log tree with the old and new
  code into two copies and `diff -rq` them. `git status log` proves nothing,
  because `log/` is ignored.
