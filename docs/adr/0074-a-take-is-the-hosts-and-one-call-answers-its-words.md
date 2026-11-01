# A take is the host's, and one call answers its words

The device ran the dictation. It cut the recording into Pieces at pauses, sent each Piece as a request
of its own and was answered with that Piece's words, decided when a take had waited long enough, and
then sent the joined text to a second route to be tidied. The host never knew that a group of clips was
one dictation: Pieces were joined only by a `first=1` and a `last=1` query parameter, and a cloud take's
audio sat in a buffer keyed by profile. Everything that needs the whole take — one decode, one Cleanup,
one budget, one failure — was assembled by the thing that cannot hear audio.

Three of the costs were real rather than hypothetical. The client copied the host's budget:
`STOP_WAIT_MS` is 12 s against a High Cleanup the host itself bounds at 12 s, so a Stop with a Piece
still in flight could never fit its cleanup, and the host paid for a model call whose answer was thrown
away. The drain was one request after another behind the profile's dictation lock, so a slow host's
Pieces queued while the user kept talking. And a cloud take left alone for more than a minute lost what
was said before that point in silence: the next Piece started a fresh hold, the take was uploaded short,
and half a dictation read as a short one.

**The app uploads audio and nothing else.** A Piece is still cut at a pause or at its length cap,
because a Piece is the unit the wire can re-send — its own container, addressed by its index — and not
because a host could not plan a cut of its own — but from there it is audio: it carries the Take id
the app minted when the recording started, its index within the take, the bot's Vocabulary and the
hint, and the host answers it with nothing at all. No words come back, and the
`first`/`last` framing goes with them.

**The take is the host's, under the app's id.** One registry entry per profile and Take id, holding
what the host has heard so far, what it still owes, and when it was last touched; one take at a time
per bot stays as it is. The entry expires after a window the host states, and Cancel is an explicit
delete rather than a wait for that window to pass, so a cancelled take's audio leaves the host at once.

**The host hears each Piece as it lands.** A worker per take, off the request path, decodes a Piece in
the order it arrived and keeps the words; a local host drops the audio as soon as it has them. A host
resolving a cloud provider keeps the take's audio and uploads the whole of it at the Confirm, and still
sends no Hearing prompt — a vendor decode reads the audio alone and the Cleanup carries the bot's names
(ADR 0069's provider rule stands unchanged).

**One call answers the take, and it is the only call that carries words.** The Confirm names how many
Pieces the take has. A host holding fewer answers 409 naming the indexes it is missing, the app sends
those once more and confirms again, and a second miss fails the take — that recovery is the only path
with a second Confirm. On a complete take the host drains its queue, runs Cleanup at the bot's level,
and answers in one payload: the landed text, the words as Heard, the take's spoken ms, and the level,
`cleaned`, provider and model behind them.

**A take lands whole or not at all.** Every upload being answered with nothing is what buys this: there
is no partial text to land, so a take that cannot be finished is a take that was never said twice. Both
Send and Stop hold the bar for one number the host states, `info.dictation.wait_ms` — the time its own
queue and its Cleanup at the bot's level can take between the Confirm arriving and the answer leaving
— so a fifth level or a slower provider moves the client's wait without an app release, and the client
no longer splits one clock between two halves it does not own. Past that bound the app aborts the
Confirm, fails the take and keeps its audio; the host is not interrupted, runs to its own deadline and
drops the answer when the take expires, so a slow host wastes one decode and the device loses nothing.
Retry mints a fresh Take id and re-uploads what the device still holds, so a late Piece from the dead
take can never join the new one.

**The dictation row keeps what tidied it.** The log's row grows `level`, `cleaned`, `provider` and
`model` beside the two texts — on the device's own row and on the bot's host, whose record grows the
same fields and needs a migration. The sheet can then say what tidied a take and whether it changed
anything, which the two texts alone could never tell: identical texts cover a Cleanup that found
nothing to change and one that never ran.

**What goes.** `POST dictation`'s text answer, `POST dictation/cleanup`, the `first` and `last` flags,
`keptText` and the replay path it existed for, `SEND_WAIT_MS`, `STOP_WAIT_MS` and `TIDY_MS`, and the
drain that waited on words. `MIN_PLUGIN_VERSION` rises with the wire, as the streaming routes did in
ADR 0038, and the mock and its flows grow the second contract so the app is never tested against a
fiction.

## Considered options

- **One call at Stop, carrying the whole take's audio.** Literally one request, no Take id, no held
  buffer, and it deletes the most. Rejected: hearing would start only after the user stops, so a local
  host would decode the whole take in front of a waiting composer, and it gives up the overlap between
  speech and decode that a take exists to exploit.
- **Uploads during the take, but the host hears everything at the Confirm.** The simplest plugin: no
  worker, no queue, no per-take text. Rejected for the same reason one step milder — at Stop the user
  waits the take's length again on a local model, which is the slowness this work exists to remove.
- **Pieces that answer their own words, so a dead host still lands half a take.** It keeps today's
  partial landing. Rejected: the partial landing is precisely what forces the client to own the
  ending — to decide what a failure leaves, what the bar has heard and which text is final — and it is
  the one thing an all-or-nothing take buys back.
- **The host mints the Take id.** One fewer thing for the app to own. Rejected: every upload would wait
  for the first answer, ordering the wire around a round trip, and a Retry's identity would move under
  the app rather than with it.
- **The bot's Vocabulary becomes host state, read by the plugin.** It would take the list off every
  upload and put it where the Cleanup level already lives. Rejected for now rather than for good: it is
  host state that has to sync, and it buys nothing the vocabulary riding on an upload does not already
  do. Worth revisiting if a second reader of the list appears.
- **Keeping the old wire beside the new one.** Rejected: two implementations of one take kept green
  for an app that is refused anyway, which is the rot ADR 0038 already declined.

## Consequences

- Stop now waits for one Piece's decode plus a Cleanup instead of a Piece's words arriving as it
  closes — the last Piece and the Cleanup are all that is left, which is what `wait_ms` says.
- A wedged host lands nothing where it used to land half the words. That is the trade all-or-nothing
  makes; the take keeps its audio, and Retry is one tap.
- The host holds the take's audio only where it must: never on a local host, and on a cloud one only
  until the Confirm uploads it, with Cancel taking it away immediately.
- A cloud take's words still arrive only when the user stops, and the recording UI still looks like
  recording rather than talking.
- `wait_ms` is read with `info`, which the device caches for five minutes, so a bot whose level just
  changed can hold a stale bound until the next read; a Confirm that misses it fails a take the host
  would have finished.
- The plugin's take registry is memory, keyed by profile and id, exactly as the old buffer was: a host
  restart mid-take loses the take's Pieces, and the app's Retry re-uploads them.
- `dictations.py` grows four fields and a migration, and an older plugin answering the mirror without
  them is refused rather than read as a row with nothing tidied.
- The app's dictation module loses its orchestration and gains an upload queue, which is a smaller
  thing in the same place.

What holds it: the plugin's take registry and Confirm are pinned by the dictation suite's take cases
(state keyed by id, expiry, the 409 and its indexes, the payload's fields, a cancel that leaves nothing
held); the app's ending is pinned by its ending cases (an upload retried twice, a Confirm that misses
its bound, a Retry minting a fresh id, a Cancel that deletes); the mock answers in the same two shapes
so the flows test the real wire; and the row's four new fields are pinned on the device row and on the
mirror.

Supersedes ADR 0038's clauses on how a take's Pieces are orchestrated and tidied — the client draining
Pieces, the one end-of-take `dictation/cleanup` call, and the `first`/`last` framing — and ADR 0069's
clause on the held buffer. Everything else ADR 0038 decided stands: Pieces cut at pauses, no words on
the bar, one text landed when the take ends, and the bounded waits.
