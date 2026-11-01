# A session closes at the tap, and the host finishes the close

Status: grilled 2026-10-31 against the code, the glossary and the ADRs it touches; every decision
below is settled and recorded in ADR 0075. Nothing here is built yet.

## Goal

Delete and Discard end the session at the tap. The row leaves the chat list, or moves to Discarded,
before any host work has run: the AFK claim released, the worktrees removed (keeping those with
uncommitted or unpushed work), each repository's open pull request closed and its pushed branch
deleted on GitHub all happen on the host afterwards, recorded as a **session close** the app reads
back as a **close report**. A kept worktree, a refused branch delete, or a removal that failed is
told once per device — the device that pressed the button when it is there to hear it, and the
device that next opens Code when it is not.

That is the whole change. A chat that is not a project session, a session whose worktree this
device never read, and the two dialogs' own copy change as little as they can.

## What this is not

- **Not a new session state.** A close still running does not make a session working: ADR 0053
  holds that Closed is for sessions nothing runs for, and the host's cleanup of an ended session is
  not the session doing something. The row keeps the state it closed with, and the Code list's
  groups are untouched.
- **Not a notification.** The sixteen push kinds stay sixteen; the report is a toast, on the
  devices that read it.
- **Not a retry of kept work.** A tree is kept because its work is uncommitted or unpushed, which
  no host-side retry can change. The report names the tree and why; the session record survives on
  the host (`sessions.remove` keeps it) so a later close can try again once the work is pushed.
- **Not the project's own delete.** Deleting a project still deletes its sessions locally and lets
  `projects/{id}/remove` remove the project's work; it asks for no close (the sessions' pull
  requests are the project's to leave).
- **Not a second close path in the app.** A plugin without `closes` gets the synchronous close,
  bounded, exactly as today; the app never derives a close it could have asked the host for.

## Decisions

1. **The close leaves the request.** `POST sessions/{id}/closes` writes the close row and answers
   `202` with its state; a daemon thread runs `afk.release_session`, `sessions.remove`,
   `sessions._clear_cwd` and `ship.close`, then writes what it ended with onto the row. `GET
   sessions/{id}/closes` reads one close; `GET closes` reads the recent ones, which is how a device
   hears about a session it has already deleted.
2. **The close is recorded before it runs, with its own snapshot of the repositories.** A
   successful removal deletes the session record, so the close row keeps the project and each
   repository's name, root and branch; the close is resumable and reportable after the session row
   is gone.
3. **A close is owed until it ends.** A row still `closing` when the process starts is run again at
   boot, once, the way a clone and a wake are resumed. Asking for a close of a session whose close
   is already running answers that close rather than starting a second one.
4. **The row moves at the tap, and never waits.** Delete stops the run, asks for the close and
   deletes the conversation (its tombstone included) in that order; Discard stops the run, asks for
   the close and sets `discardedAt`. Both dialogs close at once. Stop still comes first (ADR 0051).
5. **The report is a fact on the host, told once per device.** The app keeps a device-local mark
   per close — the same shape as the read mark — so a report is told once on each device, and a
   device that was closed when the close ended tells it when it next opens Code.
6. **The report is read while the button's device is there, and on Code's own screen.** After
   asking, the app reads that session's close every couple of seconds for a bounded while, and
   tells it the moment it ends; Code reads `GET closes` for each bot it lists as the screen opens,
   telling whatever it holds no mark for.
7. **An older plugin keeps the old close.** The synchronous `POST sessions/{id}/close` stays, and
   the app falls back to it when the host doesn't advertise `closes` — bounded at
   `WRITE_TIMEOUT_MS`, which it never was. An older app that meets a newer plugin calls the old
   route and gets today's answer.
8. **The words change with the work.** The dialogs stop promising the GitHub work is done: they say
   the host is closing the session now, that a worktree with uncommitted or unpushed work is kept
   and reported, and that Hermes keeps its own copy of a deleted session.
9. **The removal's own failure is reported.** The plugin's top-level `error` — a worktree that
   couldn't be removed, a git that refused — reaches the close report and the toast; today
   `closeSession` drops it.

## Where it lives

| Path | What it is |
| --- | --- |
| `plugin/closes.py` | The close: `start` (snapshot, record, spawn), `run` (release, remove, cwd, pull requests), `read`, `recent`, `resume`, and the report it writes |
| `plugin/store.py` | Schema 49: `session_closes`, one row per close, with the snapshot and the report |
| `plugin/__init__.py` | `POST`/`GET sessions/{id}/closes`, `GET closes`, `closes` advertised, `closes.resume` at boot; the synchronous route kept for older apps |
| `plugin/events.py` | The close's end noted on the change stream, so an open app re-reads |
| `app/src/lib/hermes.ts` | `startSessionClose`, `getSessionClose`, `getSessionCloses`; a bound on the synchronous `closeSession` and `removeWorkspace` |
| `app/src/lib/workspace.ts` | `closeSessionWork` asks the host and returns at once, or takes the synchronous path on a plugin without the feature |
| `app/src/lib/close-reports.ts` | Which reports this device has told, the words they are told in, and the bounded wait after asking |
| `app/src/lib/code.ts` | `useCloseReports`, read as Code opens for each bot it lists |
| `app/src/components/chat/chat-actions.tsx` | Delete and Discard at the tap; the dialogs' words |
| `app/scripts/mock-hermes.mjs` | The close routes, a kept tree, and a slow close to watch |
| `docs/adr/0075-a-close-is-the-hosts-work-and-the-row-closes-before-it-ends.md` | The decision |
| `GLOSSARY.md` | **Session close**, **Close report**; **Session state** amended |
| `AGENTS.md` | The close paragraph and the layout rows it names |

## Edges

- **The app closes between the tap and the close ending.** The host finishes it (aiohttp does not
  cancel a handler when the client disconnects, and now nothing depends on that), the row keeps the
  report, and the next Code open tells it.
- **The plugin restarts mid-close.** The row is still `closing`, so boot runs it again; the removal
  is idempotent (a tree already gone is skipped) and the pull-request work is too (a closed pull
  request is closed, a missing ref is a 404 the delete already swallows).
- **A second tap, or two devices discarding at once.** One row per session: the second ask answers
  the close already running instead of starting another.
- **A session the host never had.** The ask answers `done` with nothing to report, so a delete of a
  session that only ever existed on the device ends the same way.
- **A tree is kept.** The row says which tree and why, the session record survives on the host, and
  both dialogs' promises are kept by the report rather than by silence.
- **A pull request's branch is gone already.** `ship.close` skips it; a repository with neither an
  open pull request nor a pushed branch is absent from the report, as today.
- **A plugin without `closes`.** The app closes synchronously, now bounded; a slow host shows the
  failure as a toast rather than holding the dialog.
- **A session discarded on another device.** That device's close runs there; this one reads the
  report off the host when it next opens Code, so both are told, each once.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit (plugin)** — `plugin/tests/test_closes.py`: the ask answers `closing` without waiting for
  the work (the thread's collaborator recorded, not run); the close writes its report when it ends,
  kept trees and per-repository errors included; a `closing` row is resumed at boot and a `done` one
  is not; a second ask does not start a second close; a session the host never had answers `done`.
- **Unit (app)** — `app/scripts/test-close-reports.mjs`: a report is told only when it has ended and
  this device holds no mark at or past its start; the words of a kept tree, a refused branch and a
  failed removal.
- **Component** — `app/scripts/test-session-close.tsx`: Delete from the header's menu removes the
  conversation while the host's close is still running (the request held open), the dialog is gone,
  and the report lands as a toast once the host answers; Discard sets `discardedAt` the same way;
  Main still has neither.
- A mock switch for a slow close (`MOCK_CLOSE_MS`), so a browser flow can watch a row move before
  its close ends; the component test holds the ask itself with a request it controls.
- No browser flow: the behaviour is "the row moved before the host answered", which a component
  test over a seeded device and a held request reaches; geometry, a reload and a real host are not
  part of it.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Then `pnpm e2e code-list` for
the Closed group's rows. From the root: `python3 -m unittest discover -s plugin/tests -t .`.

## Build order

1. `feat(plugin): keep a session's close as a record the app reads back` — `closes.py`, the schema,
   the routes, `closes` advertised, resume at boot.
2. `feat(app): close a session at the tap and read the report` — the client calls, `closeSessionWork`
   returning at once, the reports module, Delete and Discard, the copy.
3. `feat(app): tell a close report where the sessions are listed` — `useCloseReports` on Code.
4. `test(plugin)` / `test(app)` — the tiers above, and the mock's switch.

## Risks

- **A newer plugin with an older app** keeps the old route and behaves as today: no report, no
  resume, nothing broken. The app is the PWA that updates itself; an APK lags and lands here.
- **A close that never ends** (a GitHub call that hangs at its 15 s socket timeout, a git at 60 s)
  ends eventually; the row stays `closing` and a restart resumes it. Nothing in the app waits on it.
- **Reports outlive their sessions**, so the table grows by one row per closed session. Rows are
  pruned with the same shape as the events table (a count and an age), and a report is small.
