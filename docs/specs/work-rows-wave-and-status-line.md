# A working row waves and the status line types itself

## Problem Statement

A reply says it is working with a spinner — the same turning ring on the thought row while its
thinking arrives, on the tool group's row while a call runs, and on the status line under the reply.
A thread is otherwise words, so the one thing moving in it is an icon that belongs to none of them,
and a spinning ring is the sign a screen wears when it has nothing to show rather than a sign of work
a reply can name. The status line's own words — "Thinking", "Writing", "Running bash" — sit still
beside the ring, so the sentence that says what the turn is doing is the least alive thing on the line.

## Solution

A work row keeps the label it already names and the label itself carries the wave: a light travelling
left to right through the words, a lap every 1.4 seconds, and the icon slot goes. The status line under
a reply loses its spinner and types the words it is saying, a character every 26ms, backspacing to the
first character two labels do not share at 12ms when the label changes, and then growing its ellipsis a
dot at a time. Waiting lines appear whole with no dots, a line halfway through typing is cleared the
moment a thought row above takes over the naming of thinking, reduced motion turns both off, and
nothing new is installed to do any of it.

## User Stories

1. As someone watching a bot work, I want the row that says what it is doing to move, so the thread
   shows me it is alive without an icon that belongs to no words.
2. As someone watching a bot work, I want the thinking row's words to carry the movement, so the label
   I am reading is the thing that tells me the turn is still at it.
3. As someone watching a bot work, I want the tool group's row to move the same way while a call runs,
   so the two rows a reply draws for its work read as one block.
4. As someone reading a reply before a word of thinking has arrived, I want the row that has nothing to
   open yet to move as well, so the turn is visibly working from its first moment.
5. As someone reading a reply, I want the chevron and a failed call's mark to stay exactly where they
   were, so a row that is working still reads as a row I can open.
6. As someone whose turn changes what it is doing, I want the status line to change with it visibly, so
   I can tell "Writing" from "Running bash" at a glance rather than by re-reading the line.
7. As someone whose turn changes what it is doing, I want the line to keep what two labels share rather
   than empty itself, so the change reads as the turn moving on rather than starting over.
8. As someone who has waited on a long turn, I want the line to keep moving once it has said its word,
   so "Writing" sitting there for half a minute doesn't look like a stall.
9. As someone whose bot is waiting on me, I want "Waiting for your answer" to appear whole and still, so
   the line does not claim something is progressing when the bot is waiting for me.
10. As someone reading a bot's own words for what it is doing, I want those words typed like any other,
    so the host's own status is not the one line that snaps into place.
11. As someone whose turn starts thinking mid-line, I want the half-typed line to go at once, so the
    thread never says the turn is thinking in two places.
12. As someone who asked for reduced motion, I want both animations off, so the row still reads what the
    turn is doing and the line still says it.
13. As a screen reader user, I want the line announced once as a label rather than a character at a
    time, so a label arriving doesn't flood my ears.
14. As someone watching the line, I want the subagent count beside it to stay put while the label types,
    so nothing on the line slides on every keystroke.
15. As someone reading a chat in the dark or on a phone at 390px, I want both to read the same, so
    neither animation depends on a colour or a width.
16. As someone reading an old or synced chat, I want nothing extra in the thread, so a finished reply
    draws no wave and no typing.
17. As someone opening a call's details, I want the sheet's step list unchanged, so a list of calls reads
    as it did.
18. As a maintainer, I want no new dependency on the chat route, so a session's startup stays what it is.
19. As a maintainer, I want the rules as pure functions with their own tests, so the typing and the dots
    are checked without a screen.

## Implementation Decisions

- **The wave is a decoration on the row's label.** A work row's label span carries a class that runs a
  keyframe (a light travelling left to right through the text, 1.4s a lap) while the row is working, and
  the row stops drawing the spinner it drew ahead of the label. The wave covers the label's words only:
  the chevron, a failed group's reason line and the label's truncation are untouched, and the row's
  accessible name does not change.
- **The row keeps its shape.** The 29px height, the reply's inset, the pair meeting and the sheet each
  row opens are ADR 0058's and ADR 0050's; this changes only the sign a row wears while it works.
- **Which rows wave.** The thought row while its thinking still arrives, the pending thought row before a
  word arrives, and the tool group's row while any of its calls runs. A finished row is still.
- **The wave has a test slot** so the component test and the browser flow can tell a working row from a
  finished one without reading a class name.
- **The status line's rules are pure and tested without a screen**: the label a line types (the words
  without a trailing ellipsis), the next text to show given what is shown and the label it is heading
  for (backspace to the first character the two do not share, then type), and the dots at a step (none,
  one, two, three, then none again).
- **The line's clock is one component**, holding what is shown, stepping the rules at 26ms a character
  and 12ms a backspace, and cycling the dots every 500ms while the turn works. Nothing about it is
  written to the device or the store.
- **Waiting is passed in, not sniffed.** The line is told it is waiting on the reader — the approval or
  the question the reply already knows about — and a waiting line draws its words whole with no dots. No
  string is matched to decide it.
- **The typed text is not the text announced.** The typed span is hidden from assistive tech and the
  whole label sits beside it, so the line's polite live region announces the label once when it changes
  and never a character at a time. The dots are hidden the same way.
- **The line holds its target's width.** An invisible copy of the whole label holds the box the typed
  label draws into, so the subagent count beside it does not move while the label types.
- **The typing state belongs to the line.** A line that goes away — a thought row taking over the naming
  of thinking, or the turn ending — takes its half-typed label with it, and one that comes back types
  from nothing.
- **Reduced motion turns both off**: the row's label is plain and the line's label appears whole with a
  still ellipsis.
- **No dependency, no plugin, no schema.** The typing is a timer over a string and the wave is a
  keyframe, so nothing is added to the app's dependencies, the plugin, the API or the device's store,
  and `MIN_PLUGIN_VERSION` is unchanged.

## Testing Decisions

- A good test here drives what the reader sees: a row that is working carries the wave and no spinner, a
  finished one carries neither, and the line reads what its rules say at a given moment. It does not
  assert class names beyond the one slot each keeps for the purpose.
- **Unit** (the new rule module's own test): the label without its ellipsis, the next text toward a label
  (a shared prefix kept, the rest backspaced, then typed), a label with no ellipsis, an empty line, and
  the dots wrapping after three.
- **Component** (`app/scripts/test-thinking-line.tsx` and a new test for the line): a working row carries
  the wave slot and no spinner; a finished row carries neither; the line types over fake timers, changes
  label by backspacing to the difference, grows its dots, draws a waiting label whole with no dots, and
  clears when it is told a thought row above has taken over.
- **End to end** (`pnpm e2e thinking-line`, extended): the flow's existing stalled turn already draws the
  status line, so it samples the working row for the wave instead of the spinner and measures the line
  while its label types — the width holding still is geometry a DOM without layout cannot reach
  (ADR 0019). The flow keeps its row in `docs/e2e-flow-audit.md`.
- Prior art: `app/scripts/test-thinking-line.tsx` for the component seam over a seeded device database,
  and `app/scripts/e2e/thinking-line.mjs` for the browser leg.

## Out of Scope

- The tool details sheet's step list, which keeps its spinner: it is a list of calls inside a pop-up, not
  the reply's account of its work.
- The spinners elsewhere in the app that say a request is in flight — the subagent line, list rows, the
  archive reach, sheets.
- Any change to what a label says: the activity wording, the host's own status text and the thinking
  labels stay as they are.
- A wave over the whole row, a per-word ripple, or a caret on the line.
- Adding `motion`, Motion+ or any other animation dependency.

## Further Notes

- ADR 0061, `docs/adr/0061-a-working-row-waves-and-the-status-line-types-itself.md`, is the decision this
  spec builds.
- `GLOSSARY.md` gains **Work row**, **Wave** and **Status line**, and the **Thinking** entry stops saying
  spinner; AGENTS.md's layout table gains the new rule module.
- The app's gates before a commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Tickets

- #639 — feat(chat): a working row waves instead of spinning (blocked by: none.)
- #640 — feat(chat): the status line types what the turn is doing (blocked by: #639.)
