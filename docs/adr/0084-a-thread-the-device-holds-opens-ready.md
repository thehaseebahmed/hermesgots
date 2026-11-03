# A thread the device holds opens ready, and the foot never says it is catching up

**A chat this device holds rows of opens as a thread, not as a wait.** Returning to a code session
already on the device said "Catching up…" in the thread's foot for thirteen seconds every time, and
up to twenty when the session had run elsewhere in between — over the whole thread, which the device
had drawn from its own rows before it asked the host anything. The word was true of one thing only:
the round trip to the host. It was read as the app being stuck on work it had already done, and that
is how it arrived: a defect report about a code session, on its phone, every open.

**The word measured the link, not the thread.** What an open spends is the host's answer, and
neither end of it is the device's copy. Measured here: three thousand rows of a code session's shape
load from the device in about thirty milliseconds, and the newest page of a real 2,900-row session
costs about a millisecond of SQL on the host. A phone is slower than this container and a link to a
home host is slower than loopback, so the seconds are real — but they are the network, and no
shortening of the read's work takes them out of the screen's first state.

**A thread the device holds is ready, and the host's first read is a reconcile.** Readiness is
decided where the thread is drawn, from the rows the view already holds, and not from the host's
answer: `ThreadViewProps.firstReadOut` says only that a read is out and the host is not away, and it
is a view that decides whether that is a wait — one over a thread it holds nothing of draws the
single loader in the middle of the pane (ADR 0069), and one over anything it does hold — rows, cards,
a marker — draws the thread. The store keeps its own meaning for `status`, so nothing that read it as
"the host has not answered yet" moves: a page follows a run the device left unfinished only once its
first read has landed, and the call a turn's end makes is still the read's to report. The
alternative — opening the store `ready` off its loaded copy — was tried and dropped: `Doing.status`
is also the flag those two effects read, and re-pointing it made a held chat report the reconcile as
a turn landing and start following a run before the first page was in. Nothing else about the open
changes — the newest page is still asked for at once, the older pages are still read after it, a read
that joins is still laid over the rows held, and a turn that ends still reads the whole transcript.

**"Catching up…" retires with the state it named.** A thread no longer has a loading it can say in
words, so the word, its place in the status line's rotating pool (`catching` in `busy-words.ts`) and
the `data-catching-up` mark all go. The thread's one live row (ADR 0076) is now always the reply's:
its status line while a turn works or waits, the count of subagents alone once the turn is done, and
nothing at all where a finished reply draws no line.

**What a slow or failed read still says, it says elsewhere.** A read that gets no answer at all makes
the host away and the header says so (ADR 0071) — a held thread included, and its words stay up
until an answer lands. A read the host answers with an error keeps its error banner. So a thread that
is behind is never silent about the host being unreachable; what it no longer does is claim, in the
foot of a thread it has already drawn, to be fetching rows for as long as the link takes.

## Considered options

- **Keep the word and bound it** — it stands a few seconds, then the reply's line takes over while
  the read continues. Rejected: the screen would keep a claim it then drops while the claim is still
  true, and the bound would be a number nobody can derive from anything the app knows.
- **Skip the read when the host says nothing moved**, so the word has nothing to stand for. Rejected
  as the fix here: it needs a per-session tip the plugin does not publish, and where something *did*
  move the wait comes back in full — the reported case as often as not.
- **Read only the newest page and keep the word**, on the argument that one round trip is short.
  Rejected: one round trip is what it already costs, and that is the thirteen seconds being reported.

## Consequences

- **[ADR 0066](0066-the-status-line-wears-a-rotating-word-and-a-loading-thread-says-so.md) is
  superseded in its "Catching up is the thread's, not the host's" clause**: the foot says nothing of
  a read. Its rotating words for thinking and writing, and its rule that a Main still loading draws
  no greeting, stand.
- The sentences in [ADR 0069](0069-one-working-look-and-one-chat-face.md),
  [ADR 0070](0070-the-status-line-is-muted-and-the-count-is-the-only-blue.md),
  [ADR 0075](0075-a-reply-ends-on-its-status-line-and-its-stats-stand-above-it.md) and
  [ADR 0076](0076-the-thread-decides-its-one-live-row-and-the-reply-draws-it.md) that describe the
  count riding the catch-up line, or the catch-up line standing where the reply would work, describe
  a row no screen reaches now. Their own decisions — the loader for a thread held nowhere, the count's
  home, the reply's standing, and the thread's one live row — are unchanged.
- A held thread that is behind opens without saying so. Its first read is what brings the host's
  turns in, and they arrive as any other read's rows do; a reader who wants to know the host is
  unreachable reads the header, which is where ADR 0071 put it.
- One mark names the state, in both views: `data-loading-fresh` on the loader a thread held nowhere
  draws — the app's and the dev route's alike — so a test device asking "is it still loading" reads
  the same attribute whichever markup it mounted. The dev route draws that mark with the words
  "Loading the thread…" where the app draws a spinner, since its own markup is what its tests read.
- Nothing about the host's read moved. A session whose first page is expensive on the host still
  costs that when it opens — it is simply no longer charged to the screen's first state.
