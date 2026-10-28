# A working row waves and the status line types itself

**Superseded in its status-line sentence by [ADR 0062](0062-a-work-row-wears-no-mark-and-the-status-line-loads.md)**: the status line no longer types what it says — it turns a loader beside words that stand whole, in the accent colour, and drops the loader while the turn waits on the reader. Everything said here about the wave stands.

A reply says it is working with a spinner. `Loader2Icon` turns on a thought row while its thinking
still arrives, on the tool group's row while a call runs, and on the status line under the reply. The
same glyph in three places, and the one thing moving in a thread the reader watches — which is mostly
words — is an icon that belongs to none of them. A spinning ring also says *wait* rather than *here is
what I am doing*: it is the sign a screen wears while it has nothing to show, not the sign of work a
reply can name.

Two things change, and they are one decision: a working row's label carries a wave, and the status
line types the words it is saying.

**A working row waves its own words.** The row keeps the label it already names — "Thinking…" while
the thinking arrives, the tool group's phrases while a call runs — and a light travels left to right
through those words, a lap every 1.4 seconds, in the label's own colour rather than a colour of its
own. The icon slot goes: `before` is what a row draws ahead of its label, and the spinner was all it
ever held in these two rows. Nothing else moves — the chevron stays, the tool group's failure mark
stays, the label still truncates — because the wave belongs to the words and the row's shape belongs
to ADR 0058. The wave is decoration over words the reader can already read: the row's accessible name
is unchanged, and nothing announces it.

**The status line types itself.** The line under a reply loses its spinner and types the words it is
saying, a character every 26ms. When the label changes it backspaces to the first character the two do
not share, at 12ms, and types the rest: a turn's "Writing" becoming "Running bash" rubs out what the
two do not share instead of emptying the line, because emptying it reads as the turn starting over. The
ellipsis is not typed with the label — a label arrives as words, and the line then grows its dots a
step at a time, one every 500ms, and back to nothing — so a turn that sits on "Writing" for half a
minute still moves. A line that waits on the reader — "Waiting for your answer", "Waiting for your
approval…" — is not typed and carries no dots: nothing is progressing, and a moving line would say
something is. A line the host itself words is typed like any other, since it is the same statement about
the same work.

Why not the typewriter the request pointed at: Motion's `Typewriter` is a Motion+ component, paid and
built with an access token, and the app has no motion dependency at all. What it does is a rule of tens
of lines — backspace to the point of difference, then type — so it lives here as one pure rule module,
one component and one keyframe, driven by `node --test` without a screen, rather than as a dependency
on the chat route every session loads.

**The typed text is not the text announced.** Characters arriving one at a time are a screen reader's
worst case: the typed span is `aria-hidden` and the whole label sits beside it for assistive tech, so the
line's `aria-live="polite"` announces the label once when it changes and never a character at a time.
The line holds the width of the label it is typing instead of growing with it — an invisible copy of the
whole label is what holds the box — so the subagent count beside it does not slide on every keystroke.

**A thought row that takes over clears the line at once.** A thought row is the one place the thread
names thinking, and the status line never says "Thinking…" beside it (ADR 0050). Halfway through typing
a label, a thought row arriving above clears the line rather than finishing a word it no longer has.

**Reduced motion turns both off.** The row's label is plain — it still reads what the turn is doing —
and the status line's label appears whole with a still ellipsis. The app's `prefers-reduced-motion` rule,
applied to a row rather than to a bot.

## Considered options

- **Keep the spinner and add the wave beside it.** Rejected: two loaders on a 29px line, and the row
  the reader scans as one passage of work would carry two claims that it is working.
- **A wave glyph — short bars bouncing in the icon slot.** Rejected: it is a spinner with a different
  picture, and it leaves the words still while the row's own label is the thing that says what the
  turn is doing.
- **Add `motion` and animate the characters ourselves.** Rejected: what it would animate is a string
  arriving a character at a time, which is a timer, and the dependency would land on the chat route
  that every session loads.
- **Add Motion+ for its `Typewriter`.** Rejected: paid, and an access token in the build for an effect
  this repo writes in one file.
- **Type every label from empty when it changes.** Rejected: "Thinking" to "Writing" would empty and
  retype in a flicker that reads as the turn restarting; backspacing to the difference keeps what the
  two statements share.
- **Keep a caret.** Rejected: the status line is not a text field, and a block caret under a reply
  reads as one.
- **Cycle the dots on waiting lines too.** Rejected: waiting on the reader is not work in progress, and
  the dots are the sign that something is moving.
- **Let the line grow character by character.** Rejected: the subagent count beside it is the one datum
  on that line, and it would slide on every keystroke.

## Consequences

- `src/lib/typing.ts` holds the rules as pure functions — the label without its ellipsis, the next
  characters to show given the line and its target, and the dots a step at a time — so
  `scripts/test-typing.mjs` drives them without a screen. `src/components/chat/typed-line.tsx` is what
  runs them on a clock, and the wave is a keyframe in `index.css` with its class on the label span.
- ADR 0058's shape and ADR 0050's sheet are untouched: the row is still 29px, still opens what it
  opens, and this ADR is only the sign it wears while it works.
- `scripts/test-thinking-line.tsx` and `scripts/e2e/thinking-line.mjs` assert a row is working by its
  wave slot rather than `[data-slot=spinner]`; the pending row and the running tool row both carry it.
- The tool details sheet's step list keeps its spinner: it is a list of calls inside a pop-up, not the
  reply's own account of its work, and every line in it is already named.
- `GLOSSARY.md` gains **Work row**, **Wave** and **Status line**, and the **Thinking** entry stops
  saying spinner; AGENTS.md's layout table gains the new module.
