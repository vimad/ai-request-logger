# Demo video script — ai-request-logger

**Length:** ~60 s · **Format:** 1920×1080, silent with on-screen captions (works
as a GIF / muted autoplay on GitHub) · **Recorded with:** Playwright driving
Agent X-Ray at `http://127.0.0.1:8790`, plus one terminal shot.

Captions appear as a lower-third overlay injected by the Playwright script. A
soft highlight ring (CSS outline + slow pulse) marks whatever the caption is
talking about.

---

## Scene 1 — The hook (0:00–0:05)

**On screen:** Dark title card.

**Caption (large):**
> What does your AI coding agent *actually* send to the model?

**Sub-caption:** `ai-request-logger` — zero dependencies, one command.

---

## Scene 2 — One command (0:05–0:12)

**On screen:** Terminal. `npm start` is typed, the banner prints the four
ports (claude :8787, cursor :8788, codex :8789, viz :8790).

**Highlight:** the `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` line.

**Caption:**
> A transparent proxy for Claude Code, Cursor CLI and Codex CLI.
> No install. No build. Just point your agent at it.

---

## Scene 3 — Agent X-Ray home (0:12–0:18)

**On screen:** Browser opens `:8790`. The **Connect a coding agent** panel is
open; Playwright clicks the Claude → Cursor → Codex tabs quickly, then
collapses it. Session cards are visible below.

**Highlight:** the tabs, then a session card with its model chips.

**Caption:**
> Every session, every turn — captured as you work.

---

## Scene 4 — The hero (0:18–0:24)

**On screen:** Click into a turn. The hero shows the typed prompt drawn to
scale against everything sent to the model.

**Highlight:** the tiny prompt box vs. the huge total area; then the request /
token / time totals.

**Caption:**
> You typed one line. This is what the model received.

---

## Scene 5 — The agent loop, animated (0:24–0:36)

**On screen:** Press `Space`. The loop plays *You → Claude Code → Claude API →
tool → back*. Speed up with `3`. Let 2–3 laps run.

**Highlight:** the request envelope growing each lap; the "Inside request N"
panel showing **re-sent / echoed / new** markers; the Gantt chart below.

**Caption (changes once mid-scene):**
> Think → call a tool → read the result → think again.
> …and every lap re-sends the whole conversation.

---

## Scene 6 — Every request carries everything (0:36–0:42)

**On screen:** Scroll to the tower matrix. Bands connect identical blocks
between requests.

**Highlight:** the headline with the % of bytes that were pure re-sending.

**Caption:**
> Most of the bytes on the wire are repeats. Now you can see them.

---

## Scene 7 — The inspector (0:42–0:52)

**On screen:** Scroll to the request inspector. Click through tabs, ~1.5 s
each: **System prompt** → **Tools** → **Skills** → **Conversation** (an
injected `<system-reminder>` flagged) → **Params & headers**.
Then click one block to open the side drawer.

**Highlight:** each tab as it's clicked; in the drawer, "who wrote it" and
"carried by requests …".

**Caption:**
> The full system prompt. Every tool. Every hidden reminder the harness injects.

---

## Scene 8 — It's all just files (0:52–0:57)

**On screen:** Quick cut to an editor / `tree log/ -L 3` showing
`session → turn-001__… → req-001__main__…/request.md`.

**Caption:**
> Plain JSON + Markdown on disk. Grep it, diff it, commit it.

---

## Scene 9 — Outro (0:57–1:00)

**On screen:** Title card.

**Caption:**
> github.com/<you>/ai-request-logger
> Node 22.18+ · `npm start`

---

## Recording it

```bash
cd demo && npm i && npm run record      # → demo/out/demo.webm (~74 s, 1600×900)
```

`record.ts` starts its own proxies + Agent X-Ray on spare ports (9787–9790)
against `demo/log`, so a running `npm start` is left alone, and rewrites the
ports it shows back to 8787–8790. The terminal scenes are scripted HTML pages
inside the same recording.

`demo/log` is a real Claude Code turn captured in a throwaway repo (`slugkit`),
with the email, username, account/org IDs and device ID scrubbed. It is
gitignored, along with `demo/node_modules` and `demo/out`.
