# A working row waves and the status line loads

**Status:** built, then reversed. The wave and the mark-free work row shipped in pull request #647 and
were taken out by [ADR 0064](adr/0064-a-work-row-turns-a-spinner-and-wears-its-mark-again.md); the
status line the same work left behind stands. Its tickets are #639 and #640.

**Amended 2026-10-27:** the status line's typing is reversed. It turns a loader beside words that
stand whole again, both in the accent colour, and drops the loader while the turn waits on the
reader ([ADR 0062](adr/0062-a-work-row-wears-no-mark-and-the-status-line-loads.md)). The typed line's
stories, rules and tests go with it.

**Reversed 2026-10-28:** the wave and the mark-free row are reverted
([ADR 0064](adr/0064-a-work-row-turns-a-spinner-and-wears-its-mark-again.md)). A work row turns a
spinner ahead of its label again, hidden from assistive tech, and a failed group wears its X with the
reason dented under it. Everything struck through below is the passage that shipped and came out.

## Problem Statement

~~A reply says it is working with a spinner — the same turning ring on the thought row while its
thinking arrives, on the tool group's row while a call runs, and on the status line under the reply.
A thread is otherwise words, so the one thing moving in it is an icon that belongs to none of them,
and a spinning ring is the sign a screen wears when it has nothing to show rather than a sign of work
a reply can name. The status line's own words — "Thinking", "Writing", "Running bash" — sit still
beside the ring, so the sentence that says what the turn is doing is the least alive thing on the line.~~

ADR 0064 reverses the premise: a work row's words are what the reader is reading, so the sign that
the row is at work belongs beside them rather than in them, and a spinner in its own slot says it
without moving a letter. The status line keeps the movement that a row's words could not.

## Solution

~~A work row keeps the label it already names and the label itself carries the wave: a light
travelling left to right through the words, a lap every 1.4 seconds, and the icon slot goes.~~ A work
row keeps its icon slot: a spinner turns there while the row is at work, and a group whose calls
failed wears its X there with the reason dented under the words. The status line under a reply turns
a loader beside words that stand whole, both in the accent colour; while the turn waits on the reader
no loader turns and the words stand muted. Reduced motion leaves the ring drawn and still. Nothing new
is installed to do any of it.

## User Stories

~~1. As someone watching a bot work, I want the row that says what it is doing to move, so the thread
   shows me it is alive without an icon that belongs to no words.~~

~~2. As someone watching a bot work, I want the thinking row's words to carry the movement, so the label
   I am reading is the thing that tells me the turn is still at it.~~

~~3. As someone watching a bot work, I want the tool group's row to move the same way while a call runs,
   so the two rows a reply draws for its work read as one block.~~

~~4. As someone reading a reply before a word of thinking has arrived, I want the row that has nothing to
   open yet to move as well, so the turn is visibly working from its first moment.~~

~~5. As someone reading a reply, I want the chevron and a failed call's mark to stay exactly where they
   were, so a row that is working still reads as a row I can open.~~

6. As someone whose turn changes what it is doing, I want the status line to change with it visibly, so
   I can tell "Writing" from "Running bash" at a glance rather than by re-reading the line.
7. As someone who has waited on a long turn, I want a loader to keep turning beside the words, so
   "Writing" sitting there for half a minute doesn't look like a stall.
8. As someone whose bot is waiting on me, I want "Waiting for your answer" to appear whole and still
   with no loader beside it, so the line does not claim something is progressing when the bot is waiting
   for me.
9. As someone reading a bot's own words for what it is doing, I want a loader beside those words like any
   other, so the host's own status is not the one line with nothing moving beside it.
10. As someone who asked for reduced motion, I want the ring drawn without turning, so the row and the
    line still say they are working without anything moving.
11. As a screen reader user, I want the line announced when its words change rather than as a loader, so
    nothing floods my ears.
12. As someone watching the line, I want the subagent count beside it to stay put while the loader turns,
    so nothing on the line slides.
13. As someone reading a chat in the dark or on a phone at 390px, I want the row's sign and the line to
    read the same, so neither depends on a colour or a width.
14. As someone reading an old or synced chat, I want nothing extra in the thread, so a finished reply
    draws no spinner and no loader.
~~15. As someone whose call failed, I want the failure said in the row's own name and its reason standing
    flush under the label, so a row wears no mark of its own.~~
16. As someone opening a call's details, I want the sheet's step list unchanged, so a list of calls reads
    as it did.
17. As a maintainer, I want no new dependency on the chat route, so a session's startup stays what it is.
18. As someone watching a bot work, I want a spinner turning beside the row's label, so the thread shows
    me it is at work without the words I am reading being the thing that moves.
19. As someone whose call failed, I want the failed row marked at its head, so I can see which row went
    wrong before I read why.
20. As a screen reader user, I want the row's spinner left out of its name, so the row says what it is
    doing once.
21. As someone reading a reply before a word of thinking has arrived, I want the row with nothing to open
    yet to carry the same sign, so the turn is visibly working from its first moment.

## Implementation Decisions

~~- **The wave is a decoration on the row's label.** A work row's label span carries a class that runs a
  keyframe (a light travelling left to right through the text, 1.4s a lap) while the row is working, and
  the row stops drawing the spinner it drew ahead of the label. The wave covers the label's words only:
  the chevron, a failed group's reason line and the label's truncation are untouched, and the row's
  accessible name does not change.~~

~~- **Which rows wave.** The thought row while its thinking still arrives, the pending thought row before a
  word arrives, and the tool group's row while any of its calls runs. A finished row is still.~~

~~- **The wave has a test slot** so the component test and the browser flow can tell a working row from a
  finished one without reading a class name.~~

~~- **A failed group wears no mark.** Its failure rides in the row's own accessible name, and its reason
  stands flush under the label rather than a gap below it, in `WorkNote` (ADR 0062).~~

~~- **Reduced motion leaves out the wave and stills the loader**: the row's label is plain, and the ring
  stays drawn without turning.~~

- **The row's sign is a spinner in its slot.** `WorkRow` carries `before` again: a spinner ahead of the
  label on a thought row while its thinking arrives, on the row a turn wears before a word arrives, and
  on the tool group's row while any of its calls runs — and the X on a group that failed, in the same
  slot the spinner leaves. The sign is `aria-hidden`: the row's own name and its label already say what
  it is doing.
- **The reason line takes its dent back.** A line under a row's label stands under the words, past the
  mark (`WORK_LABEL_DENT`), so the failure's reason lines up with the label it explains.
- **The row keeps its shape.** The 29px height, the reply's inset, the pair meeting and the sheet each
  row opens are ADR 0058's and ADR 0050's; this spec is only the sign a row wears.
- **The status line turns a loader beside whole words.** One spinner stands at the line's head while the
  turn works, and the words beside it are the words the turn is saying — nothing is typed, held or
  backspaced. The row and the loader both take `--primary`, the colour this project calls the accent.
- **Waiting is passed in, not sniffed.** The line is told it is waiting on the reader — the approval or
  the question the reply already knows about — and a waiting line draws its words whole and muted with no
  loader. No string is matched to decide it.
- **The words are what is announced.** The loader is hidden from assistive tech, so the line's polite
  live region announces its words when they change and never the animation beside them.
- **Reduced motion stills the loader and the row's spinner**: both are drawn and neither turns
  (`motion-safe:animate-spin`), so the sign survives the preference.
- **The subagent line is blue wherever it lands**, loader included, so a delegated job never reads as the
  reply's own work.
- **No dependency, no plugin, no schema.** The spinner is the one the app already draws, so nothing is
  added to the app's dependencies, the plugin, the API or the device's store, and `MIN_PLUGIN_VERSION`
  is unchanged.

## Testing Decisions

- A good test here drives what the reader sees: a row that is working carries a spinner, a finished one
  carries none, a failed group wears its mark, and the line draws a loader beside the words it is
  saying. It does not assert class names beyond the slots each keeps for the purpose.
- **Component** (`app/scripts/test-thinking-line.tsx`, `test-tool-row-words.tsx` and
  `test-subagent-line.tsx`): a working row carries the spinner and no wave; a finished row carries
  neither; a failed group wears its mark and carries its failure in its name; the status line draws a
  loader beside whole words in the accent colour; a waiting line draws no loader and stands muted; the
  subagent line is blue wherever it lands.
- **End to end** (`pnpm e2e thinking-line`): the rows are sampled for the spinner a working row carries,
  and the status line for its loader and the accent colour on both — colour is what a DOM without layout
  cannot reach (ADR 0019). The flow keeps its row in `docs/e2e-flow-audit.md`.
- Prior art: `app/scripts/test-thinking-line.tsx` for the component seam over a seeded device database,
  and `app/scripts/e2e/thinking-line.mjs` for the browser leg.

## Out of Scope

- The tool details sheet's step list, which keeps its spinner: it is a list of calls inside a pop-up, not
  the reply's account of its work.
- The spinners elsewhere in the app that say a request is in flight — list rows, the archive reach,
  sheets. The subagent line's is in scope only for its colour.
- Any change to what a label says: the activity wording, the host's own status text and the thinking
  labels stay as they are.
- Any animation over a row's own words — a wave, a per-word ripple — or a caret on the line.
- Adding `motion`, Motion+ or any other animation dependency.

## Further Notes

- ADR 0061, `docs/adr/0061-a-working-row-waves-and-the-status-line-types-itself.md`, was the decision
  this spec built; [ADR 0064](adr/0064-a-work-row-turns-a-spinner-and-wears-its-mark-again.md) supersedes
  it, and ADR 0062 is the one the status line still follows.
- `GLOSSARY.md` gains **Work row**, **Status line** and **Subagent line** and keeps the **Thinking**
  entry saying spinner; **Wave** is gone. AGENTS.md's layout table gains nothing: the sign lives in
  `work-row.tsx`.
- The app's gates before a commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Tickets

~~- #639 — feat(chat): a working row waves instead of spinning (blocked by: none.)~~

- #640 — feat(chat): the status line types what the turn is doing (superseded by ADR 0062: the line
  turns a loader beside words that stand whole, in the accent colour, instead).
