# Thinking opens in a sheet, and its row says the turn is working

A reply's thinking no longer folds open in the thread: its row opens the working-out in the same
pop-up the tool row opens (a bottom sheet on a phone and tablet, a side drawer from 1024px), and the
row takes over the footer's working line — it carries the spinner from the first moment the turn is
working, before a word of thinking arrives, and the footer never says "Thinking…" again. This
supersedes the rest of ADR 0049's fold rules: the latch, the fold at the answer, and the "Fold
thinking by default" switch in Appearance, which is retired — from the settings document, the synced
appearance record and every device's row (Dexie v22 deletes the key). Runs, their anchoring and ADR
0038's label honesty are untouched.

Two places said "Thinking…" at once — a row and the footer's line under it — and the row was only
interesting while its words grew in the thread, where they either pushed the answer down the screen
(0049's fold) or hid behind a switch. The sheet puts the working-out where a reader who wants it
taps for it, in the same form as a call's details, and the spinner on the row says the turn is
thinking exactly where the tool row's spinner says it is running.

A live run opened in the sheet lands on its newest words and follows them while they arrive,
stopping when the reader scrolls up inside the sheet; a run already written opens at the top, where
its working-out starts. The sheet never closes itself — when the thinking ends, the row's label
reads the span and the reader closes the sheet when they want it gone. A reply that never thinks
loses its spinner row the moment the answer's first word lands, so the row exists only where
thinking is happening or happened.

## Considered options

- **A fixed-height scrolling panel for an open row (Copilot's `fixedScrolling`)** — 0049 rejected
  this as "a second scroll context on a small screen"; the sheet is exactly that context, taken now
  because the thing it was an alternative to is gone: the fold that bounded an open row inline. A
  sheet is dismissed by the reader, bounds the thinking without competing with the answer, and is
  the pop-up the thread's other unit of work already opens.
- **The inline fold, with a sheet as an extra** — rejected: two places to read one run, and the
  inline fold is what pushed the answer off the bottom of a phone.
- **Keeping "Fold thinking by default" for the sheet era** — rejected: nothing opens on its own
  now, so the switch would govern nothing; a dead field is worse than none.
- **Closing the sheet when the answer begins** — rejected: the reader opened it deliberately, and a
  sheet that closes under them is worse than a label that updates under it.
- **Keeping the footer's line while the row spins** — rejected: two places saying "Thinking…", or a
  footer claiming "Writing…" while the reply is still silent, is the duplication this replaced.

## Consequences

- `foldThinkingByDefault` is gone from `Settings`, `APPEARANCE_FIELDS`, `DEFAULT_SETTINGS` and the
  pushed appearance record; Dexie v22 deletes the key from every device's settings row, and
  `adoptAppearance` goes on ignoring the name should another device still push it.
- The thread's latch, its tap map and the fold moment are gone with the fold: openness is the row's
  own sheet state, nothing is written down, and `test-thinking-line.tsx` asserts the sheet instead.
- The spinner row is drawn wherever the footer's line used to say "Thinking…" — while the reply is
  silent with nothing of its own yet, and behind the model's last call — but never while a call is
  running, which is its own row's to say.
- 0049's geometry consequence changes with it: an open run needs no cap and no Show more because it
  is no longer inline; the sheet renders the whole markdown.
