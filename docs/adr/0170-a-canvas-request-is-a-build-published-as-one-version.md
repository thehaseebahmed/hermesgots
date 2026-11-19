# A canvas request is a build on a fresh session, published as one version

**Amends [ADR 0113](0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md) and
[ADR 0130](0130-a-canvas-has-two-screens-and-each-has-its-address.md)** (2026-11-19, planned in
`docs/plans/2026-11-19-canvas-builds.md`; not built yet).

A canvas was one long-lived Hermes session whose every `canvas_write` was a version the reader saw.
That made a request's context the whole chat, froze the guide at the session's start, and showed
half-built pages. **Each request now opens a build: a fresh `canvas-…` session seeded with the page,
the canvas's memory and the newest build summaries.** A request sent while a build is open is queued
on that build's session. The build plans first — the agent judges whether its plan waits for the
reader's Approve, and a message sent while it waits revises it — writes into a draft in the canvas's
folder, and publishes the draft as **one version** when its run ends with nothing queued, carrying
every request it took and its final reply as the summary. Undo undoes a build. A failed or
interrupted run publishes nothing and keeps the draft; Stop ends a build with nothing published.

The canvas's chat record stays as the request inbox — its model pin, drafts, start files, mute and the
outbox's queue — and the outbox routes its items into builds, so no second send path is built. The
document is now changed only by the canvas's builds, one open at a time, which replaces 0113's "only
by its own session". The lane draws builds (request, summary, check flag, version) rather than the
transcript, which stays behind Details. Build sessions are outside the `gots-` names, so progress
reminders and the daily sweep ignore them; the plan-waiting and build-finished pushes are given to
them explicitly.

The path is gated on an `info` feature, `canvas_builds`, and an app that predates it keeps the
one-session path, because the plugin ships ahead of the app.

## Considered and rejected

- **One session, history cut at each request.** Keeps one transcript, but the guide stays frozen at
  the session's start and the cut leaves Hermes's own lineage hard to read.
- **A chat record per build.** Every build would be a row a list must hide, and the send path would be
  rebuilt per build.
- **Every write a version.** Today's shape: the reader sees half-built pages, and Undo steps back a
  write rather than a request.

## Consequences

- An existing canvas starts its first build with empty memory and no summaries.
- A build costs more model calls than today's one turn.
- The one-session path stays until the app floor passes `canvas_builds`.
