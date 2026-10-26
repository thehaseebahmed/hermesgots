# The Code list is arranged by status, and a dot marks what this device hasn't read

**Superseded in its dot sentence by [ADR 0055](./0055-a-code-rows-dot-needs-a-read-mark-before-it-can-show.md)**:
a session never opened here no longer shows the dot — the dot needs a read mark first. What this
record decides about the mark, its being device-local, the comparison and the dot's place stands.

**Superseded in its membership ordering by [ADR 0053](./0053-a-run-in-flight-is-the-code-lists-primary-claim.md)**:
a run in flight claims the row before any wait on the human.

The Code screen listed sessions in date buckets — *Waiting on you*, *Working*, then *Today* down to
*Earlier*, with *Closed* at the foot — so recency decided the order and a session waiting on the
user sank under sessions that merely happened lately. The list is now four groups in a fixed order,
**Waiting for You** > **Working** > **Idle** > **Closed**, with sticky headers that carry a count,
empty groups dropped, and *Closed* always collapsed. Membership follows the state the row already
computes, with the higher claim winning: closed first, then any wait on the human — a question, an
approval, a plan review, a host's stall, or a pull request's checks running or failing — then the
agent running with nothing waiting, then the rest. A session holding an open pull request that
needs review sits in Waiting for You as it did before; what changes is checks *running*, which
moved there from Working instead of passing for work in progress. *Closed* holds Resolved and
Discarded interleaved, told apart by their icon rather than by headings of their own.

Inside a group the order is the sort-by dropdown's — created new-to-old by default, else last
activity new-to-old, else the session's title A-Z — remembered per client. While a search query or
a project chip filters the list the headers disappear and the same order runs flat: filtering is
the list with its headers removed, never a second ordering rule.

The round state icon carries the colour while the glyph keeps saying why: yellow for any wait on
the human and for checks running or failing, green for Resolved and for an open pull request
needing nothing, grey for Idle, Working, Draft PRs, Discarded and merged or closed pull requests —
Discarded and Resolved outrank everything, then waiting, then draft, then the live-PR green, so a
draft that still owes an answer wears yellow rather than the grey its draft would give it. A blue
dot at the icon's top-right marks a session whose last activity is newer than this device's
**read mark**: the moment this client last rendered that thread, held on the device and never
synced, so a session never opened here shows the dot and opening it anywhere else does not clear
it. Rendering the thread — in the pane or on its own page — writes the mark back.

A row's trailing time is a session's **last activity**: the newest of the turn's end, its pull
request's updates and its resolve or discard, derived from moments that already exist rather than
stored as one, so no field joins sync to carry it.

The row itself is unchanged underneath all this — its second line still says the state in prose
([ADR 0045](./0045-a-skill-row-says-how-it-is-doing.md)).

## Considered options

- Keep the date buckets and only recolour the icons: rejected, because the ordering rather than
  the paint is what buried the sessions waiting on the user.
- Sync read marks with the chat fields so a dot cleared on one device cleared everywhere: rejected
  — read state is a fact about where the reader was sitting, and a synced timestamp with a merge
  rule over it buys nothing this needed.
- Store a `lastActivityAt` written by every event: rejected in favour of deriving it from fields
  that already exist (`updatedAt`, the pull request's timestamps, `resolvedAt`, `discardedAt`) —
  one timestamp with three writers is a conflict waiting to land.

## Consequences

- `AGENTS.md`'s line that a session whose pull request's checks are running groups as `working`
  changes when this ships: it groups as Waiting for You, and once checks settle it stays there
  either way.
- The waiting group's count keeps the warning tone; the other three counts stay muted, since only
  one group's number is an obligation.
- Which session auto-opens in the pane is deliberately untouched — a list ordered by status must
  not decide what the reader was last reading.
- Scope is the Code screen. The sidebar's session lists and the bot threads keep their own
  ordering until something asks for them too.
