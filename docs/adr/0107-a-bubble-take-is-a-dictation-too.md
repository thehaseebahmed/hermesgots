# A Bubble take is a dictation too

History is the app's record of what a bot heard: one row per take, its words, what was heard beside
them, and what tidied them. Every row in it was written by the app at the moment a take's words landed
in the composer — which is why the Bubble's takes were absent from it, by ADR 0104's own reckoning. A
take spoken into another app's field is heard by the same bot, tidied at the same level and counted by
the same totals, and it is missing from the one place a person looks to see whether their dictation
worked.

**So a Bubble take writes the row the app would have written.** The phone already speaks the bot's own
routes with the bot's own key, so it posts the row itself, straight after the Confirm answers and
without waiting for Gots to be opened: the host's log is the durable copy, the device's mirror is
reconciled from it, and History draws a take that never touched the composer. The row carries what the
Confirm answered — both texts, the span, the level, the provider and model — and the host counts the
words rather than trusting a count, since a second copy of `countWords` on the phone is a rule that
would drift.

**The phone names the row.** It mints the id before it posts, and keeps that id on the take it holds
for the page when the post does not land: a host that is away leaves the take in the phone's handover,
the page writes it the next time it is open, and `INSERT OR IGNORE` on the host makes a row handed
over twice the same row. One take is one row however many times the wire is walked.

**A take the phone could not type is unchanged.** Its words were never typed anywhere, so the toast
still says they are saved in Gots, and the handover still carries them into the log.

## Considered options

- **Leave it as ADR 0104 had it, and call the gap a recorded asymmetry.** Cheapest, and it was
  defensible while the Bubble was a first landing — but the row is the only proof the take happened,
  and "my dictations from the Bubble are missing" is a bug report a person is right to file.
- **Write the row from the app whenever it next opens, off the phone's kept takes.** No new route, and
  the path already exists for untyped takes. Rejected as the only path: it caps History at the phone's
  twenty-take handover, drops the oldest silently once the app has been closed long enough, and gives
  the row a different id from the one the phone knew.
- **Have the plugin write the row when the Confirm answers.** It cannot: a route cannot tell a
  composer's take from a Bubble's, and a row written there would double the composer's own.
  Rejected on that alone.

## Consequences

- `BubbleNet.record` is one more route the phone speaks, and `test-bubble-wire.mjs` holds it to the
  app's own `/dictations` alongside the bounds it already compares.
- The phone and the page can both write the same row, with the same id, in the window where a post
  lands but never answers. The log keeps one row; the cost is a POST the host ignores.
- A Bubble take counts towards a bot's totals like any other, because it is one.
