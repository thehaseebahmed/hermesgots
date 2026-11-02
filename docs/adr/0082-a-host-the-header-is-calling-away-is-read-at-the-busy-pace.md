# A host the header is calling away is read at the busy pace

A chat left saying "This host isn't answering" over a host that had answered seconds earlier. The
report: opening a code session says it, and opening the session two or three times clears it. The
reopen is the diagnosis — it is the only thing in the app that forces the read.

Away is set by one read that got no answer and taken back by the next read that lands (ADR 0071). The
page's own timer decides when that next read is, and while the bot's server is streaming the page's
changes the idle pace is `max(idleMs, SAFETY_MS)` — five minutes, deliberately, because the stream is
the signal and the timer is only the net under it. So a read that misses once at open, with the
stream still up, leaves the words on screen for up to five minutes after the host answered; the stream
says nothing to contradict them, because a session that has not moved produces no event. Only a read
clears the state, and a reopen is a read.

A code session is where it shows first: opening one is the moment the host is asked for the most at
once — the transcript, the session's workspace, its pull requests, its library, and a run's events if
one is in flight — so a read that loses 15 seconds there is ordinary, and a code session with no turn
running moves nothing afterwards.

**The first retry after a miss is at the busy pace, and it slows from there.** `readPace`
(`src/lib/away.ts`) answers the page's interval from the facts the page already keeps: `busy`, how many
reads in a row have got no answer (`misses`), and whether the bot's stream is open. A page with a miss
on it reads at `pollMs` — that read is the only way back, and a host that answers one tick later takes
the words with it — and each miss after that doubles the wait, capped at `idleMs`. So the first retry is
a couple of seconds, and a host that is really gone is read at the pace the page keeps anyway.

That cap is not decoration. Reads serialise — a request that arrives while one is out waits for it and
is answered by one more read after it — which bounds a host that *hangs*, but a host that refuses, or
a device that is offline, fails in milliseconds and nothing is in flight to queue behind: a flat fast
pace measured 30 reads a minute, each carrying the transcript read and the plugin's child and queue
reads, against the 4 an idle page made in the same minute. A page that is away also stops asking the
plugin for children and the queue at all: those answers were being thrown away, and on a loaded host
they are the expensive half.

**Any answer takes the words back — not only a read that lands.** They name the host, and the page has
several ways of hearing from it: a followed run's own events, the plugin's account of what is live, a
read that lands, and a read the host answers with an error (a 500 is the host answering; it is the
*failure*, not the reachability, that is wrong). This matters because a page following a run reads
nothing else until that run ends, so a page that went away while a run was joined would otherwise wear
the words for the length of the run while the run's events landed. What sets them is narrower than
what clears them: only a read that got no answer at all.

**A device with no network does not tick.** The words then say "You're offline", and no read can
succeed, so the timer keeps the app's own rule (`usePoll`): read on screen and online, and read at once
on an `online` event. The page's *first* read when it opens is the exception, and it is what earns that
wording: it goes out offline, fails at once, and that failure is how the page knows to say the device
has no network rather than the host.

Everything else about away is as ADR 0071 left it: the words stay the header's, the composer stays, a
send made while away keeps its short wait, and nothing re-sends by itself.

This amends one sentence of the spec that ordered away
(`docs/specs/away-in-the-header-and-a-refused-message-stays.md`): "Nothing else changes pace. The
periodic read keeps its intervals while away." Its other decisions stand, and ADR 0071's do too — it
never spoke about the pace. What this deliberately does not decide: whether a missed read should be
retried before the words go up at all (it should not — one miss still names the host at once, so a
dead host is named in fifteen seconds and not thirty), how long a read waits (`READ_TIMEOUT_MS` is
unchanged), and whether the plugin's stream announcing its own reconnect should clear the words (it
does not today; nothing reads that event). Nor does it move `readPace` beside the other intervals in
`freshness.ts`, or adopt it at the six places that write the same stream-else-idle shape by hand —
that is a sweep of its own, recorded in `fixes.md`.

## Considered options

- **A flat fast pace while away.** Rejected on the measurement above: 30 reads a minute forever against
  a host that refuses at once, where an idle page made 4 in that minute.
- **Capping the away pace at the stream's net (`SAFETY_MS`) instead of the idle pace.** Rejected: that
  is the bug over again in slow motion — the words would wait up to five minutes to be taken back, on
  the very pages the report came from. A page whose stream stays open is read more often than the five
  minutes it used to wait, and that is what the change is for.
- **A longer read timeout.** Rejected: it makes every read on every screen slower, and the state still
  waits on the same timer afterwards.
- **A retry before the words are drawn.** Rejected: a genuinely dead host would be named after two
  timeouts, and the words would still sit for whatever pace followed them.
- **Reading again on the stream's own word.** Rejected: the stream has nothing to say about a session
  that has not moved, which is the case the report comes from.
- **Waiting for the device's `online` event alone.** Rejected: the host can be away with the device's
  network perfectly fine, which is the whole state the header's "isn't answering" names.
- **Stopping the periodic read while away.** Rejected when away was designed, and still: the header
  could never clear itself.

## Consequences

- A chat whose host is away is read within a couple of seconds of the answer that takes the words back.
- The words can no longer outlive the host while a run is being followed, because the run's own events
  are an answer, and an away page reads over a followed run until one comes.
- A device with no network stops reading until the network is back, and reads at once when it is.
- A page whose stream is open and whose host is gone is read every 15 seconds rather than every five
  minutes. That is deliberate, and it is the one case where this change costs more reading than it
  replaces; once the stream dies the page is at the pace it always kept.
- The gates: `app/scripts/test-away.mjs` pins the rule — the ramp, its cap, and both stream cases;
  two component cases in `app/scripts/test-chat-next-mount.tsx` pin what takes the words back (a run's
  events while the transcript read still fails, and a read taken while following a silent run), and
  each was watched failing with its mechanism removed; `pnpm e2e away` and `pnpm e2e idle-requests`
  hold the header's words and the request budget. What no test covers is the timer being rebuilt on
  each miss, so that the period follows the ramp rather than staying where it was armed.
