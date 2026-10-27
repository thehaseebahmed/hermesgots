# A dictation is kept on its bot's host and mirrored on the device

A take leaves nothing behind. Its words land in the composer and the row that held its audio is
deleted, so the app has no answer to "what have I dictated" beyond what is still unsent: nothing to
list, nothing to count, and no way to tell a fast talker from a slow one. The new screen needs the
log itself, so the record has to exist somewhere. It goes on the bot that heard the take, in the
Gots plugin's store, because that is where the words were already produced and the one place that
outlives a browser profile; the device keeps a mirror, and every read the screen makes is against
that mirror. A dictation is one finished take as the log keeps it: the words exactly as they landed
in the composer, after Cleanup, with the bot that heard them, when, how many words, and how long
they took to say.

The write happens at the moment the words land, in the one path both a Stop and a Send end on
(`useChunkedDictation`'s commit), and it is never awaited by the send. The entry is written to the
mirror first and posted to the host afterwards, so a host that is away — or too old to have the
routes — costs the entry nothing: the mirror is still the log, and no error reaches the user. The row remembers
whether the host ever answered for it, so a post that failed is not a row the host refuses — it is a
row still owed, posted again the next time the mirror is reconciled and dropped from the comparison
until it is. A refusal is the one failure that is not owed: the host read the words and said no (400,
or 413 for a take over its bound), so the same bytes would be refused on every open. That row is
marked on the device and never asked about again, and it stays in the mirror, because the words are
the user's whatever one host thinks of them. A take
that is cancelled, fails, or is abandoned before any words land writes nothing; a take whose words
land and are then edited away or thrown out still wrote.

The host answers five things, all behind a `dictations` feature in `info` so an older plugin simply
has no copy: a write at commit (`POST dictations`), a delete of one entry, a clear of them all, a
paged read newest first, and the stats — the totals plus a fingerprint. The paged read is for a
device that has to fill or repair a mirror, never for drawing the screen. The stats read is both the
tab's numbers and the reconciliation's check, so one small read per bot serves both.

A take is stamped twice, because two clocks are involved and only one of them can be trusted. The
device says when the words were said — `at` — and that is what the screen draws, there being no other
record of it. The host stamps when it stored the row — `seenAt` — and that is what the log is ordered,
paged, counted and cleared by. A device's clock is exactly the thing that goes wrong: a phone just set
up, or one whose owner has travelled, can be hours or a year away from the host it posts to, and a log
ordered by it would draw a take from this morning below one from last year. Ordering by the host's
clock also gives the page walk a cursor it can trust, `(seenAt, id)`: a time alone cannot carry a walk
past two rows that share it, and a coarse clock — or a store whose rows were backfilled from one — can
make rows share it, so the id is part of the key. A take cannot claim a time after its host heard it,
so `at` is clamped to `seenAt` on the way in; nothing else on a device's clock is trusted.

A mirror is reconciled when the Dictation screen opens, once per bot, side by side, never in front of
the first paint. A row owed a post is handed over before the fingerprint is compared, and a device
upgraded from a build that kept no such mark settles its whole log in one write: that build posted as
it wrote, so a mirror which already says what its host says owes it nothing, and the rows are marked
from one read instead of a POST apiece. A backlog is handed over a few at a time rather than all at
once, and a host that moved its totals with the takes it just took is asked again rather than have
its pre-post answer cached. The check is a fingerprint, not a diff: count, newest, oldest, and a
`clearedAt` stamp. A device whose mirror agrees does nothing at all. A clear is settled without a page:
every mirror row its host held, and heard before `clearedAt`, goes, and nothing is compared row by row.
A row its host never confirmed stays: those words exist nowhere else, and a clear takes away the log a
host held rather than words it never received. What is left is a
divergence, and its shape decides its cost: an append — a count the host grew while both edges held
still, by less than a page — is the newest page, fifty entries, upserted and nothing dropped; anything
else, including a fresh device's empty mirror, a gap wider than one page and an entry deleted on
another device, walks the log back a page at a time until one comes short, writes what the host has
and drops what it no longer does. The walk never drops a row the host was never told about, and it
drops nothing on a read that disagrees with the host's own count: a host still catching up — or a
proxy in front of it answering totals before pages — would otherwise cost a take both sides still
hold. A row is taken away only once the pages served match the count the host reported. So a device
that is in step pays one small read, a device that has fallen behind catches up, and the walk only
happens when the two copies really disagree about the middle of the log.

The totals are the host's, per bot, and the app only adds them up: words spoken and the spoken
milliseconds behind them, each bot summed as its own answer reported it. The last answer is cached on
the device, so the Settings menu's subtitle and the stats tab draw from the last report while a host
is away; a bot that has never reported contributes nothing, and a bot without the routes contributes
nothing ever, because the numbers are what hosts counted. The rate is pooled — the sum of the words
over the sum of the milliseconds, pauses left out because a take's spans are measured piece by piece
as it is cut — and never an average of per-take rates, which would let a three-word take weigh as
much as a paragraph.

Clearing lives on the screen's header, not at the end of a list that lazy loading never reaches, and
it is a clear of every bot's copy at once: each host stamps its own `clearedAt`, and the mirror loses
the rows of the bots that confirmed — a host that refused keeps what the device holds, so a half-done
clear cannot reverse itself on the next open. Both stamps are the host's clock, so the comparison is
like with like: a row is older than a clear only if that host heard it earlier. Nothing is written over
a device's own time to make that hold, so a take keeps the moment it was said; what a clock that is
wrong now costs is a clamped `at` where it claimed the future, and, for the seconds or hours before a
host has answered for a row, the place it is drawn in.

Dictation is the app's name for the record, and the section, the glossary and the code say it; the
act stays Speech-to-text, and so does each bot's own settings page.

## Considered options

- **Keep it on the device only.** Rejected: a browser-data clear loses the whole log, and a second
  device has no history at all — the state a companion app is worst at, since it is exactly the one
  the user cannot repair by re-doing the work.
- **Keep it on the host only and read it from there.** Rejected: a host that is away would draw an
  empty history rather than an old one, paging would be a round trip per month, and the menu subtitle
  would need a fan-out before it could say anything.
- **Compare ids on every open.** Rejected: a full id read is proportional to the history, so the
  smart cases — nothing changed, a clear happened — would pay the same as the rare real divergence. A
  fingerprint makes the common case one tiny read, and `clearedAt` makes the one big divergence a
  comparison of a single number.
- **Sync the log through the account like bots and the appearance switches.** Rejected: it would put
  spoken text in the sync document, which is a second copy of something the host already holds for
  this device's bots, and it would not cover a bot whose host is not the account's.
- **Fold the stats on the device from the mirror.** Rejected: two devices would disagree about the
  same bot, a fresh device would show zero, and the totals would count only what this device had
  mirrored rather than what the host actually holds.

## Consequences

- **Spoken text now lives on a host.** No transcript has ever been stored on a Hermes host by Gots
  before this — messages stay in Dexie — so the copy is a new kind of data there, and the clear action
  is the only way to take it off a host from the app.
- **A bot removed from the app keeps its copy on its host.** Removing a bot deletes the app's rows for
  it, including the mirror; the plugin's store belongs to that Hermes profile and outlives the link,
  which is also what makes re-adding the bot restore the history.
- **The mirror can lag the host until the screen opens.** A dictation sent from another device arrives
  on the next open, not before; the History tab draws what the mirror holds, which is never blank for a
  want of a host.
- **Tab 1 and tab 3 can disagree for one open.** The list is the mirror (this device, reconciled), the
  totals are every host's counts; the reconciliation fills the list at the same time the stats read
  lands, so the two agree from the next paint on.
- **One small read per bot per open.** The fingerprint is a single row's worth of numbers, and per-bot
  work runs side by side, so one hung host neither stalls another bot nor the screen.
- **Nothing raises `MIN_PLUGIN_VERSION`.** A host without `dictations` keeps working: its takes are
  mirrored and listed, and only its stats and its durable copy are missing.
- The plugin's store gains a `dictations` table and a per-profile `dictation_state` for `clearedAt`
  in schema v44, the plugin's version rises in both files, and the app's Dexie moves to a new version
  for the mirror and the stats cache.
- **The host's clock arrives as a column, on data that is already there.** Schema v46 adds `seen_at`
  to `dictations` and backfills it from each row's `at`, which is the order those rows were read in
  before, so nothing moves for a store that has been running. From then on the column is stamped on
  write, and the old index on `at` gives way to one on `seen_at`. The app's Dexie moves to v26 for
  `seenAt` and `loggedAt` — the instant a row is ordered and grouped by, which is the host's where it
  has answered and the device's own until then — with the upgrade filling `loggedAt` from `at`.
- **A host that ran a build of this branch before the log was keyed per profile is rebuilt, not
  ignored.** `CREATE TABLE IF NOT EXISTS` cannot change a primary key, so schema v45 detects the old
  table by the `device` column it carried, renames it, creates the keyed one and carries every row
  over before dropping it. What it would otherwise leave behind is a store where a second profile's
  write of a shared id is dropped by `INSERT OR IGNORE` and the read after it finds nothing.
- `app/scripts/test-dictation-log.mjs` pins the pure rules — an entry's words and spoken span, the
  month a dictation falls in, the fingerprint comparison and the pooled rate —
  `app/scripts/test-dictation-mirror.tsx` drives the reconciliation over a real Dexie database and a
  scripted host: a log the previous build left settled in one write, a take a host lacked handed over
  once and kept, a take a host refused never asked about again, a read that contradicts the host's
  count taking nothing away, a take whose host never answered surviving the open, a take written on a
  clock that says 1970 placed where its host heard it, and sixty takes at one instant all read through
  the walk; `app/scripts/test-dictation-screen.tsx` renders the three tabs over a seeded mirror,
  including a take whose device clock is a month behind drawn in the month it was heard and above one
  it was said after.
  `plugin/tests/test_dictations.py` drives `plugin.dictations` over a temp store: a write, a paged
  read whose cursor carries the id, a delete, a clear that stamps `clearedAt`, stats that answer only
  their own profile, an id that belongs to each profile on its own, a take arriving after a clear kept
  and ordered after it, sixty takes at one instant all reachable, a clock in the future clamped to the
  moment the take arrived, a store without the host's clock backfilled from the device's, and a store
  in the old shape whose rows survive the rebuild with an id two profiles can then share.
- `GLOSSARY.md` gains **Dictation** and stops listing "dictation" as a word to avoid for
  **Speech-to-text**; `AGENTS.md`'s layout table gains the module rows.
