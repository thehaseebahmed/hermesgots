# A Code row's dot needs a read mark before it can show

Supersedes one sentence of ADR 0046: "A blue dot at the icon's top-right marks a session whose last
activity is newer than this device's **read mark**: the moment this client last rendered that thread,
held on the device and never synced, so a session never opened here shows the dot and opening it
anywhere else does not clear it." The read mark, its being device-local and never synced, the
comparison against last activity, the dot's place and its liveness all stand; what goes is reading an
absent mark as "older than everything".

A reader reported every session they had never opened on their phone carrying a dot that nothing on
that device could clear — Closed most of all, since a resolve or a discard moves a session's last
activity too, so the foot of the list was a wall of blue. A dot on every row flags nothing: it stops
being a signal about the session and becomes a fact about the device, which the reader already knows.

The dot now means what a reader can act on — **new since you last looked**. It shows where this
device holds a read mark and the session's last activity is newer than that mark. A session with no
mark draws no dot at all: never opened here, or evicted from a full store. The mark arrives when the
thread renders (in the pane or on its own page), and from then on the comparison is exactly what 0046
defined — activity newer than the mark dots the row, activity at or behind it does not.

## Considered options

- Sync read marks so a session read on any device counts as read here: still rejected, for 0046's
  own reason — read state is a fact about where the reader was sitting. A dot that goes quiet on the
  phone because the desktop read it is a claim this device cannot make.
- Seed a mark from something the app already remembers (the pane's last-opened record, a session's
  creation here): rejected — it writes a read the reader never did, covers one session rather than
  the list, and leaves every other row dotted for the same reason.
- Drop the dot from Closed only: rejected — the symptom is the absent mark, not the group; the same
  session reads differently the moment it is reopened.
- Keep the rule and tell the reader what the dot means: rejected — no copy explains a dot that sits
  on every row, and AGENTS.md forbids explanatory copy anyway.

## Consequences

- `isUnread` is the only code that changes: a missing (or zero) mark answers "not unread" rather
  than joining the comparison at zero.
- A session created on another device shows no dot on this one until its thread is rendered here
  once — the list says what it holds, not what this device has missed.
- An evicted mark (the store keeps five hundred) stops dotting its row instead of re-dotting it,
  which is the same rule read as never opened.
- A session read before it was closed still dots the moment a resolve, a discard, a turn or a pull
  request moves its last activity past the mark: last activity's derivation is untouched.
- The rule's own tests, the browser flow's seeded marks, `docs/specs/code-list-by-status.md`'s
  decision 5 and edge, and `docs/e2e-flow-audit.md`'s row for `code-list` move with it.
