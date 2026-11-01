# A close is the host's work, and the row closes before it ends

Delete and Discard used to do their host work inside the tap: the app awaited `POST
sessions/{id}/close`, and that one request released the AFK claim, removed the worktrees (keeping
those with uncommitted or unpushed work) and then closed each repository's open pull request and
deleted its pushed branch on GitHub, one repository after another. Four GitHub calls at 15 s each
per repository, two or three git subprocesses at 60 s each, all behind a dialog whose button kept
spinning, and the request carried no timeout at all — the only write in `hermes.ts` without one.
What the close ended with — the trees it kept, the per-repository errors, the removal's own failure
the app never even read — was told once, as a toast, and then forgotten: the app that closed, or
that was killed mid-close, left the user with no report and no way to ask again.

A close now leaves the request. `POST sessions/{id}/closes` records what the close is for — the
session's repositories, snapshotted, because a successful removal deletes the session record — and
answers `202` before any of it runs; a daemon thread does the release, the removal and the GitHub
work, and writes what it ended with onto that same row. `GET sessions/{id}/closes` reads one, and
`GET closes` reads the recent ones, which is how a device learns the report of a session it has
already deleted. A row still `closing` when the process starts is run again at boot, so a close is
owed until it ends, not until the response was written (the shape ADR 0052 settled for a wake).

The row moves first and does not wait. Delete removes the chat at once (and its tombstone), Discard
sets `discardedAt` at once, and the close runs on beside them. That is not a licence to read the
session as working: ADR 0053 holds that Closed is for sessions nothing runs for, and the host shutting
down work the user already ended is not the session doing something. So a closing session keeps the
`discarded` state and the Closed group it had, and the owed close is a fact about the host's cleanup
rather than a fourth value for Session state.

## Considered options

- **Fire and forget from the app, no plugin change.** The cheapest, and it would have hidden the
  spinner: aiohttp does not cancel a handler when the client disconnects, so the work already
  finishes on the host. Rejected because nothing survives the answer: a request killed before it was
  sent (a phone losing the network as the dialog closes) leaves the close never asked for and no one
  to ask again, and the report — the kept tree, the refused branch delete — is lost exactly when the
  app is closed, which is the case the report is most needed in.
- **Keep the close in the request and let the app stop waiting, reporting through the chat list.**
  Rejected: the chat list carries what the app wrote, so a deleted chat has no row to carry anything,
  and a close that fails after the tap would be invisible on every device.
- **Read the owed close off `runs/live`, as an owed wake is read (ADR 0057).** Rejected: `runs/live`
  answers what something is running for, and `sessionState` reads it as `working`; an owed close
  would put every closed session back in Working, against ADR 0053.
- **Push the report as a notification.** Rejected: the sixteen kinds are fixed
  (`docs/specs/notification-settings.md`), and a close finishing is not news worth a tray entry; the
  app tells it as a toast, once per device.
- **Retry a close that kept a tree, automatically.** Rejected: a tree is kept because its work is
  uncommitted or unpushed, and no host-side retry can change that; the report says which tree and
  why, and the session record survives on the host (`sessions.remove` keeps it) for a later close
  once the work is pushed.

## Consequences

- The plugin grows a feature name, `closes`, beside `close`; the synchronous route stays for an app
  that predates this, and an app that meets a plugin without `closes` keeps the synchronous close —
  now bounded at `WRITE_TIMEOUT_MS`, as every other write is.
- `memento.db` reaches schema 49 with `session_closes`: one row per close, carrying the snapshot of
  its repositories, so `sessions.remove` deleting the session row cannot take the report with it.
- The app keeps a device-local mark of the reports it has told (like the read mark), so a device
  tells each close once, and a close learned on one device is still told on another — the same
  "marks, not watermarks" rule as ADR 0052.
- The Code screen reads the reports a bot has ended while it is open, which is how a Delete whose
  app closed mid-close still reaches the user.
- The two dialog sentences stop promising that the GitHub work is already done; they say it happens
  now, on the host, and that a kept tree will be reported.
- A close keeps the plugin's own clock out of it: `Last activity` (ADR 0046) reads the discard, not
  the report, so a close finishing days later moves no row.
