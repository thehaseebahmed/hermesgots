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
was asked about as `{ prs: { <session id>: [...] }, unread: [...] }`. The app reads it for the sessions it lists
(`refreshPrsOf`), `PRS_TICK_MAX` of them a bot a tick, and keeps the single-session route for a chat,
which needs only its own.
`info` advertises `prs_batch`; a bot whose plugin predates it is read one session at a time, as
before, and a route the host answers 404 for is cooled down rather than retried before every batch.
A bot whose batch read *fails* is neither: see the backoff below.

**The host bounds its own calls, once.** Every outbound HTTP call in `github.py` waits
`READ_TIMEOUT_S` (five seconds — under the app's own fifteen) or, for a write, `WRITE_TIMEOUT_S`, and
takes one of `MAX_OUTBOUND` slots for the length of that call; the local work around it — `git remote
get-url`, `gh auth token` — keeps its own five-second bound. A slot is waited for at most
`READ_TIMEOUT_S`, whatever the call's own budget, so a write queued behind a hung dependency still
answers inside the time the app gives it, and nothing parks a thread for the length of the outage. The
batch's chains run on a pool of `MAX_OUTBOUND` workers, so its sessions queue for a thread of their own
rather than for one every route shares; the record read each session needs is taken under a semaphore of
the same size, and the batch stops waiting at a deadline, naming whatever is left in `unread` rather
than holding the request. `unread` also names a session this store doesn't know,
which is a question the host couldn't answer — never an empty list the app would write over the row.

**A host that can't answer is left alone, not asked once per session.** The app reads the batch when
the plugin advertises it, and reads the per-session route when the plugin says it hasn't got it. A
probe that couldn't be answered is a third answer, and it used to be read as the second: a host busy
with a turn (every request timing out at the client's fifteen seconds) had its nine listed sessions
asked one at a time, and those nine waits then queued in front of the transcript — which is what a
phone saw as a session taking twenty seconds to show what had just been written. So a probe with no
answer reads nothing this tick; a batch that failed leaves the rows as they are and marks that bot
for `PR_QUIET_MS`, and the per-session fallback (and the screen's worktree reads) run
`PRS_READS_AT_ONCE` at a time, and a host that answered none of the reads in hand stops the rest of
the list at that chunk — the fallback asks its bot's cooldown between chunks, and the worktree reads
ask whether their chunk answered at all. Bounded, they can still be slow; unbounded, they were the
stall.

**A tick asks a bot, not a screen.** A list can hold hundreds of rows, and every row in a batch is a
chain of GitHub calls on that bot, so one request naming all of them is answered `unread` past the
deadline and those rows never refresh. A tick therefore asks at most `PRS_TICK_MAX` (24) rows **per
bot** — each bot's rows are their own request with their own deadline — taking first the rows asked
longest ago. A row is stamped in `prsAskedAt` as it goes into the request, answered or not, so a row
the host couldn't answer is not the one the next tick takes first; the rows the cap left out keep
their older stamp, which is what puts them in front on the next tick. No row starves. A list larger than the
cap is read over several ticks — 226 rows is ten of them, and the screen's own re-read gate puts a
minute between a row's turns — which is the price of the bound rather than a gap in it.

**A closed session is not the list's to read.** A session under Closed is left alone by these reads
and read again when its own screen opens it; that is its own decision and its own record
(`0088-a-closed-sessions-row-is-its-own-screens-to-read.md`).

**A failure is remembered, not answered.** `_pr_failed` keeps the failure — its message and status —
for `PR_FAILURE_CACHE_S` (thirty seconds), so the next caller is refused at once instead of paying the
chain again, and no cached answer is ever built from it. A lenient caller still gets its empty list; only
`strict` is refused, which is what that flag promises. This reverses the earlier rule that a failure was
never cached — that rule was written for one caller and one dependency, and it is what turned a host
that couldn't reach GitHub into a retry storm from every device at once.

**The chains have workers of their own.** A batch's pull-request chains run on a
`ThreadPoolExecutor` of `MAX_OUTBOUND` threads rather than on `asyncio.to_thread`, which borrows the
executor every other route of the host shares: a slow GitHub then held the workers the transcript's
own read was waiting for, which is the shape this whole record is about. A chain still queued when
the batch answers is a future that never starts, where a thread handed the same work runs to its own
timeout with nobody reading it. The single-session route runs its chain there too, so one bound
covers both — a chat opening while a batch is out queues behind it rather than starting a fourth
chain.

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
- **A cap on how many sessions one batch answers, silently.** Rejected on review: a `[:40]` that drops
  the tail from both `prs` and `unread` leaves those rows never refreshing again with nothing said
  why. The deadline is the *host's* bound and it names what it caught. The *app* does cap a tick, at
  `PRS_TICK_MAX` a bot, and it is a different thing: the rows it leaves out are not dropped, they are
  the next tick's, and `prsAskedAt` records that they were considered.
- **Raising the plugin's thread pool, rather than giving the chains one of their own.** Rejected. The pool is shared with Hermes's own work and sized
  by the machine; a bigger pool makes a hung dependency cost more workers, not fewer.

**Consequences.** A batch answer is partial by design: `unread` is a session whose read failed, ran past
the deadline, or isn't in this host's store, and the app leaves that row's pull requests exactly as it
holds them — the app's `storePrs` is what writes, so an absent session writes nothing. The rows a batch
reads join the app's in-flight map before the request goes out, so a chat's own forced read of one of
them waits on this read rather than paying the chain again, and the map is released before any
per-session fallback so that fallback is not waiting on itself. A failed read now reads as a failure for up to thirty seconds on
every device, which is the point, and a session whose pull request opened in that window shows up on the
next read after it. The component tier asserts the shape (`app/scripts/test-prs-batch.tsx`): a host that
can't reach GitHub answers `200` with the session named in `unread`, and the pull requests the device
already knew stay. The `prs` end-to-end flow was written to assert it too and is red on `main` for a
reason this record does not own (`fixes.md`), so the component cases are what pin it today.
