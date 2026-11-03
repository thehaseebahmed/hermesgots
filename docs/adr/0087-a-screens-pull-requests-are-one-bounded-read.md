---
status: accepted
---

# A screen's pull requests are one bounded read, and a failure is remembered

A pull request read is the only app read that leaves the host: `github.pull_requests` runs `git remote
get-url origin`, resolves a token, asks GitHub for the branch's pulls and then asks twice more per open
pull request for its checks — each call waiting up to fifteen seconds, all of it inside one worker
thread. The Code screen asked that question once per session it lists, so opening it with nine sessions
was nine requests, nine threads and a chain of outbound calls each, and a dozen sessions doubled it.
Nothing capped any of it: the plugin's blocking handlers share one default executor with Hermes's own,
so a dependency that hangs takes the host down rather than the request (`plugin/__init__.py`).

Three things change.

**One read for the list.** `GET /api/plugins/memento/prs?session=…&session=…` answers every session it
was asked about as `{ prs: { <session id>: [...] }, unread: [...] }`. The app reads it for every session
it lists (`refreshPrsOf`) and keeps the single-session route for a chat, which needs only its own.
`info` advertises `prs_batch`; a bot whose plugin predates it — or one whose batch read fails — is read
one session at a time, as before, and a route the host answers 404 for is cooled down rather than
retried before every batch.

**The host bounds its own calls, once.** Every outbound HTTP call in `github.py` waits
`READ_TIMEOUT_S` (five seconds — under the app's own fifteen) or, for a write, `WRITE_TIMEOUT_S`, and
takes one of `MAX_OUTBOUND` slots for the length of that call; the local work around it — `git remote
get-url`, `gh auth token` — keeps its own five-second bound. A slot is waited for at most
`READ_TIMEOUT_S`, whatever the call's own budget, so a write queued behind a hung dependency still
answers inside the time the app gives it, and nothing parks a thread for the length of the outage. The
batch holds a semaphore sized from that same limit, so its sessions queue for a slot rather than for a
thread, with the record read inside the slot, and stops waiting at a deadline, naming whatever is left
in `unread` rather than holding the request. `unread` also names a session this store doesn't know,
which is a question the host couldn't answer — never an empty list the app would write over the row.

**A failure is remembered, not answered.** `_pr_failed` keeps the failure — its message and status —
for `PR_FAILURE_CACHE_S` (thirty seconds), so the next caller is refused at once instead of paying the
chain again, and no cached answer is ever built from it. A lenient caller still gets its empty list; only
`strict` is refused, which is what that flag promises. This reverses the earlier rule that a failure was
never cached — that rule was written for one caller and one dependency, and it is what turned a host
that couldn't reach GitHub into a retry storm from every device at once.

**Considered options.**

- **Only the open session's PRs, the rest drawn from the cache.** Rejected. A row's pill and its
  "checks running" state are what the list is for; a list that reads only the chat you opened shows
  another device's pull request a minute late, which is exactly the case the Code screen exists for.
- **Checks only for the open session.** Not taken yet, and worth taking next if the list's reads stay
  hot: checks are two of the three outbound calls one session costs, and a row could draw its state
  from the pulls call alone. It needs the row to say its checks are stale, so it is its own change.
- **A batch that reads its sessions one after another on one thread.** Rejected. It saves the requests
  and spends the time: nine sessions times the chain is minutes on a slow day, in a request the client
  has already given up on.
- **A cap on how many sessions one batch answers.** Rejected on review: a silent `[:40]` dropped the
  tail from both `prs` and `unread`, so those rows never refreshed again and nothing said why. The
  deadline is the bound; a session it catches is named.
- **Raising the plugin's thread pool.** Rejected. The pool is shared with Hermes's own work and sized
  by the machine; a bigger pool makes a hung dependency cost more workers, not fewer.

**Consequences.** A batch answer is partial by design: `unread` is a session whose read failed, ran past
the deadline, or isn't in this host's store, and the app leaves that row's pull requests exactly as it
holds them — the app's `storePrs` is what writes, so an absent session writes nothing. The rows a batch
reads join the app's in-flight map before the request goes out, so a chat's own forced read of one of
them waits on this read rather than paying the chain again, and the map is released before any
per-session fallback so that fallback is not waiting on itself. A failed read now reads as a failure for up to thirty seconds on
every device, which is the point, and a session whose pull request opened in that window shows up on the
next read after it. The `prs` e2e flow asserts the shape: a host that can't reach GitHub answers `200`
with the session named in `unread`, and the pull requests the device already knew stay.
