# A dictation commits words that have stopped changing, and shows them in its bar

Two rules, and they are one decision: a take's words are committed only once they have stopped
changing, and until the take ends they live in the voice bar rather than in the composer.

The commit rule is what makes the text trustworthy. Every rolling decode produces a best guess for
the whole window, and the guesses disagree at their end — the last word or two are the ones still
being spoken, or still being weighed. Committing the guess wholesale means words appear and are then
taken away and replaced, which in a field the user is reading looks like the app fighting itself.
Committing only what the newest two windows agree on means a word appears once, correct, about a
second after it is said. The word they agree on last is held back for one more window, because that
is the word the newer guess was still weighing: a word is only shown once a later window still has
it, behind a word both windows had. A phrase that closes does not wait for that window — the host
decodes the phrase's own audio whole and commits its tail from that — so the last words of a phrase
arrive with the pause rather than at the end of the take. The cost is that second, and it is the
price of the text never moving under the reader's eye.

Showing it in the bar rather than the composer is the same principle applied to the field. The
composer is a plain textarea: a live partial inside it has to be replaced on every window, has to
fight the caret, the undo stack and the draft the device is keeping, and would mean the user can type
while a stream is rewriting around them — three ways to be wrong, for text they cannot act on yet.
The bar already holds the composer's place during a dictation, so the words can arrive there and the
whole take lands in the field once, at the end, in one write that the draft, the caret and undo all
handle the way they handle a paste. It is also why typing during a take stays impossible, which is
one rule fewer than the alternative needs.

## Considered options

- **Stream the volatile guess into the composer.** What a dictation tool on the desktop can do, and
  it is the fastest-looking. Rejected: it rewrites text the user can already read, and it drags the
  composer's draft, caret and undo handling into every window.
- **Stream the stable words into the composer, from the caret.** Closer, and still rejected: a
  keystroke has to end the take or land behind the caret, and the field flickers as phrases arrive.
- **A floating overlay above the composer.** Rejected: it hides the field and the message being
  replied to, and it is a second surface to lay out at phone and tablet widths for no gain over the
  bar that is already there.
- **Show nothing until Stop, but commit faster.** The current behaviour with better numbers.
  Rejected: a second and a half of nothing is what reads as "broken" when the text is finally right.

## Consequences

- The bar becomes a reading surface, not just a level meter: it shows the committed text, scrolls
  when a take is longer than its lines, and says when it is preparing or behind.
- Commit latency is part of the feature's promise, and it is measured: a word committed later than
  about a second and a half after it was said is a regression, not a tuning knob.
- A phrase that finishes is the unit that can be cleaned up, so cleanup has to happen before the take
  ends, while the words are still in the bar (ADR 0017).
- Send is the one place that waits: it has no committed text for the tail, so it asks for the tail's
  final words and cleanup, bounded, before the message goes.
- The words committed are never replaced later, so nothing in the take needs an undo of its own — the
  composer's own undo covers the single write at the end.
