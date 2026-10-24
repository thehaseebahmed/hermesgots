# Thought rows that touch draw as one, and open until the answer

Supersedes three clauses of ADR 0038: "one row per run, and only one", the row folding the moment
its run ends, and an opened row's fade with Show more. Two thought rows stacked with nothing between
them read as a duplication, and they are not a broken run but the ordinary shape of an agent turn:
when the model calls two tools back to back with no text between them the thread draws those calls
as one group, and the run after each call lands beside the other under that group, so the rows touch.

Runs themselves are unchanged — one per contiguous stretch of thinking between tool calls, kept in
arrival order and anchored to the call that broke them, stored exactly as before with no migration.
What changed is the drawing: rows drawn with nothing between them are one row, their words joined as
paragraphs. The merge is at draw time, over the parts a reply's rows are placed as, so a reloaded,
synced or imported chat merges the same rows the live one did, and every thread gets it — a chat's, a
delegated agent's sub-thread, a coding session's. A real call between two stretches is still drawn
above them both in its group; merging says only what the reader can see, that nothing sits between
the two.

A merged row's label stays honest across the parts it holds: "Thinking…" while any of them still
thinks, "Thought for 12s" where this device measured every part with the spans added, "Thought it
through" where it did not. A sum over a stretch nobody watched would claim less time than the
thinking took, so one unmeasured part makes the whole row read the third way — 0038's honesty rule,
kept for the row that now holds several stretches.

A row opens when you watch that thinking happen and stays open: every row of a live turn stays open
while the turn works, and all of them fold together when the answer begins, or when the turn ends if
no answer comes. A row drawn from storage starts closed, a tap opens it for as long as the thread is
mounted, and nothing is written down, so the next load is closed again. Folding at each run's end,
as 0038 did, closed a row seconds after it opened — the auto-collapse users file issues against
(NousResearch/hermes-agent#53617) — while every surface folds by the time anyone reads the answer:
Hermes Desktop when the answer starts streaming, Copilot's `collapsedPreview` when non-thinking
content appears, Claude from the start.

The cap goes with that fold. `CAP`'s 30dvh, the fade and the Show more link existed so a long
working-out "must never push the answer it belongs to off the bottom"; with the rows folding at the
answer the protection sits where the risk is. While the turn runs a row follows its newest words to
the end of the thread, and a reader who opens a finished row asked for it — so an open row renders
its whole markdown, uncapped.

One switch keeps this a preference rather than an edict: **Fold thinking by default** in Appearance,
an appearance field like `steerByDefault` — carried in the settings document, default off. On,
nothing opens on its own, not even a row whose thinking is still streaming: the footer's working line
says what the turn is doing where an open row used to say it, and the folded row keeps its own
"Thinking…" label. Off, everything above applies as written.

## Considered options

- **Split the tool group so each run sits under its own call** — rejected: it never produces the
  single block the reader asked for, it stops back-to-back calls reading as one unit of work, and it
  fixes a placement the group already makes ambiguous today (both runs are drawn under both calls
  anyway).
- **Merge only where no real call sits between the rows** — rejected because the rule is about the
  drawn thread: the reader sees two rows touching, and the call is above them, not between them.
  Copilot's `withThinking`, which bundles thinking with its tool calls into one collapsible section,
  is the nearest prior art for treating them as one unit; nobody keeps one row per run in the place
  a call actually falls.
- **Fold each row when its own run ends** — rejected: a row closes seconds after it renders, so
  "open when it first renders" would be worth nothing.
- **Stay open until the reader leaves the chat** — rejected: with the cap gone, a 3,000-word
  working-out would sit above the answer the reader came for, on a phone.
- **A fixed-height scrolling panel for an open row (Copilot's default `fixedScrolling`)** —
  rejected: a second scroll context on a small screen, when the fold at the answer already bounds
  how much thinking a finished turn shows.
- **Sum the spans this device did measure** — rejected: it understates while still claiming a
  number, which is exactly what 0038's labels were written to avoid.
- **Remember the tap on the device** — rejected: a schema bump and a write per tap to persist what
  the reload is meant to undo.

## Consequences

- Storage does not move: `ReasoningRun`, `runsOf`, `carrySpans` and the Dexie schema are untouched,
  and the merge is a fold over one reply's placed parts.
- `test-thinking-line.tsx`'s back-to-back-calls case draws two rows instead of three, and every
  "one row per run" assertion becomes an assertion about rows that touch.
- With the switch on, the footer's working line shows while a turn thinks again — it was suppressed
  only because a row lay open saying the same words.
- ADR 0038 keeps its runs, their anchoring and the honesty of its labels; only the three clauses
  named above are superseded, and the glossary's **Thinking** entry is rewritten to match.
- Removing the cap is geometry, so the `thinking-line` flow in the sweep carries the assertion that
  no cap or Show more remains.
