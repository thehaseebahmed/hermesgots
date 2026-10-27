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
routes — costs the entry nothing: the mirror is still the log, and no error reaches the user. A take
that is cancelled, fails, or is abandoned before any words land writes nothing; a take whose words
land and are then edited away or thrown out still wrote.

The host answers five things, all behind a `dictations` feature in `info` so an older plugin simply
has no copy: a write at commit (`POST dictations`), a delete of one entry, a clear of them all, a
paged read newest first, and the stats — the totals plus a fingerprint. The paged read is for a
device that has to fill or repair a mirror, never for drawing the screen. The stats read is both the
tab's numbers and the reconciliation's check, so one small read per bot serves both.

A mirror is reconciled when the Dictation screen opens, once per bot, side by side, never in front of
the first paint. The check is a fingerprint, not a diff: count, newest, oldest, and a `clearedAt`
stamp. A device whose mirror agrees does nothing at all. A clear is settled without a page: every
mirror row older than `clearedAt` goes, and nothing is compared row by row. What is left is a
divergence, and its shape decides its cost: an append — a count the host grew while both edges held
still — is the newest page, fifty entries, upserted and nothing dropped; anything else, including a
fresh device's empty mirror and an entry deleted on another device, walks the log back a page at a
time until one comes short, writes what the host has and drops what it no longer does. So a device
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
it is a clear of every bot's copy at once: each host stamps its own `clearedAt`, the mirror is
emptied, and a bot too old to answer has its local rows removed and keeps whatever its host holds.

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
- `app/scripts/test-dictation-log.mjs` pins the pure rules — an entry's words and spoken span, the
  month a dictation falls in, the fingerprint comparison and the pooled rate — and
  `app/scripts/test-dictation-screen.tsx` renders the three tabs over a seeded mirror.
  `plugin/tests/test_dictations.py` drives the routes over a temp store: a write, a paged read, a
  delete, a clear that stamps `clearedAt`, and stats that answer only their own profile.
- `GLOSSARY.md` gains **Dictation** and stops listing "dictation" as a word to avoid for
  **Speech-to-text**; `AGENTS.md`'s layout table gains the module rows.
