# Settings › Dictation

## Problem Statement

Gots can hear a take but remembers nothing about it. Once a take's words land in the composer its
audio row is deleted and no trace of the take remains, so the app cannot answer what has been
dictated, when, on which bot, or how much. Someone who talks to their bots all day has no record of
it, cannot re-read a phrase they spoke an hour ago, and cannot tell whether dictation is speeding up
the way they type.

Each bot's dictation settings are also scattered behind the bot's own editor, three taps and a
per-bot list away, with nothing that gathers them.

## Solution

A new Settings section, Dictation, sits under Appearance. It has three tabs. History lists every
dictation newest first, grouped by month under a month heading, one card of rows per month, drawing
the first twenty entries and appending more as the reader reaches the end; a row shows the words and
a muted line of the bot and the word count, and opens a sheet headed by the time it landed, over the
whole text, the bot, the count and how long the words took, with Delete and a Copy side by side. Bots
draws the Settings menu's own row for each bot, saying what its host hears on — or the host's own
reason it cannot — and opening that bot's Speech-to-text page. Stats is one card with the words spoken across every bot and the
pooled words per minute behind them, each row carrying the line that says what it counts.

A dictation is written at the moment a take's words land, kept on the bot that heard it by the Gots
plugin, and mirrored on the device. Every read the screen makes is against the mirror; the host
answers a write, a delete, a clear, a paged read and the stats. A fingerprint reconciles the mirror
on each open, and the last stats answer per bot is cached so the menu row draws offline.

## User Stories

1. As someone who dictates daily, I want a history of what I have dictated, so I can find and re-read
   something I said instead of saying it again.
2. As someone who dictates daily, I want that history grouped by month, so a long log reads as
   something I can scan rather than one endless list.
3. As someone who dictates daily, I want the list to load as I scroll, so opening it is instant even
   after months of dictation.
4. As someone who dictates daily, I want a row to open and give me the whole text with a Copy, so I
   can take a phrase somewhere else.
5. As someone who dictates daily, I want to delete one dictation, so a private slip can go.
6. As someone who dictates daily, I want to clear the whole history from the screen's own header, so
   clearing is reachable without scrolling through the log first.
7. As someone with several bots, I want to see how many words I have spoken in total, so the habit is
   visible.
8. As someone with several bots, I want a words-per-minute figure across all of them, so I know how
   fast I speak and whether it is changing.
9. As someone with several bots, I want one place that links to each bot's Speech-to-text settings,
   so I do not have to walk the bot list to change a vocabulary or a model.
10. As someone whose host is old or away, I want the screen to still list what I have dictated, so a
    missing route is never an empty screen.
11. As someone who uses a second device, I want the history to be the bot's, not the device's, so the
    log is there when I open the app elsewhere.

## Implementation Decisions

- **The host is the durable copy; the device is a mirror.** The entry is written to the mirror first
  and posted afterwards, never awaited on a send path.
- **One entry per take whose words landed.** The text is what landed in the composer (after Cleanup),
  the words are counted on whitespace, and the spoken span is the sum of the take's piece spans, so
  pauses are left out. Those spans ride on the pieces, so a take restored after a reload still reports
  its own minutes; a take that lands in parts writes a row per part, each with its own span. A take
  cancelled or failed before any words landed writes nothing.
- **The plugin gains five routes behind a `dictations` feature**: `POST dictations`,
  `DELETE dictations/<id>`, `DELETE dictations`, `GET dictations?before&limit`, and
  `GET dictations/stats` returning the totals plus count, newest, oldest and `clearedAt`. The paged
  read serves a mirror that has to be filled or repaired, never the draw path.
- **The stats route does two jobs**: it is the numbers tab 3 draws and the fingerprint the mirror is
  reconciled against. The app sums each bot's last answer and caches it on the device, so the Settings
  menu's subtitle reads "1,204 words" — or a generic line until a host has answered once. The totals
  move only when a host answers: a take counts once its own bot has it.
- **Reconciliation is fingerprint first.** On opening the screen, once per bot and side by side, a
  matching fingerprint does nothing; `clearedAt` drops every mirror row older than it without a
  row-by-row compare; an append that fits one page reads that page; any other divergence walks the
  log back a page at a time and writes what the host has and drops what it no longer does. A row the
  mirror holds and the host does not is only dropped when the host has been told about it: a take
  whose post never answered is re-posted before the host is asked, so an offline take survives. That
  drop also needs a read that agrees with the host's own count, so a host still catching up — or a
  proxy in front of one — cannot cost a take both sides hold. A device upgraded from a build that kept
  no posted mark settles its whole log in one write when the mirror already says what its host says,
  rather than one POST per take the host already holds, and a backlog is handed over a few at a time.
- **A take its host refuses is kept, not retried.** A 400 or a 413 on the words is the host reading
  them and saying no, so the row is marked on the device and never posted again; the words stay in
  the mirror, so History still shows what was said.
- **Nothing sits below a clear's stamp on the host.** A row that arrives with an `at` at or below the
  stamp is stored at the stamp, so a write that raced a clear cannot bring cleared history back.
- **Clearing is one action over every bot**, on the screen's header, behind a confirmation, each host
  stamping its own `clearedAt`. Only the bots whose host confirmed are cleared on the device: a host
  that refused keeps what the mirror holds, so a half-done clear cannot undo itself on the next open.
- **A bot that cannot answer contributes nothing to the totals**, and a bot whose host cannot dictate
  is still listed in Bots, with the host's own reason in place of a status.
- **A bot's row says what its host hears on**, `On · <model>` or `Off`, `Checking…` until the read
  answers and a word of its own where the read failed; the model is a cached fact on the bot written
  whenever a host's speech settings are read, so the row answers at once and refreshes behind it.
- **Tabs live inside the one section screen** (the `Tabs` component), so back leaves Dictation.
- **The screen is a component, not routes**; the section is one entry under Appearance and
  `/settings/dictation` opens it.
- Nothing raises `MIN_PLUGIN_VERSION`; the plugin's version rises in `plugin.yaml` and
  `dashboard/manifest.json`, and the plugin store's schema moves one version for the two new tables.
  A store that ran a build of the branch before the log was keyed per profile is rebuilt in the next
  schema version with its rows carried over, since `CREATE TABLE IF NOT EXISTS` cannot change a key.

## Testing Decisions

- Unit, pure rules (`app/scripts/test-dictation-log.mjs`): an entry's word count and spoken span from
  a take's pieces, the count with its noun singular and plural, the month key and heading of a
  dictation, the fingerprint comparison (match, stale window, clear), and the pooled rate including a
  zero-words and a zero-milliseconds case.
- Component (`app/scripts/test-dictation-screen.tsx`): the three tabs render over a seeded mirror; the
  month headings and their card grouping; twenty rows drawn and the rest appended when the end comes
  into view; a row opening its sheet with the bot, the count and the spoken length over Delete and Copy
  in that order; the clear action behind its confirmation; the Bots tab's rows saying what each host
  hears on, the host's reason where it cannot, `Checking…` while the read is owed, a word where the
  read failed, and the model a refresh reports landing on the bot; a take the host never received
  surviving a reconcile and being posted again; Stats showing the summed words and rate from the cached
  answers, each row over its own line.
- Component (`app/scripts/test-dictation-mirror.tsx`): the reconciliation over a real Dexie database
  and a scripted host — a log the previous build left settled in one write with no POST, a take a host
  lacked handed over once and kept, a take a host refused marked and never asked about again, a read
  that contradicts the host's count taking nothing away, and a take whose host never answered
  surviving the open and being handed over by the next one.
- Plugin (`plugin/tests/test_dictations.py`): a write, a paged read, a delete, a clear that stamps
  `clearedAt`, stats that answer only their own profile, an id that belongs to each profile on its own,
  a take that lands after a clear stored at its stamp, a body that names no text being refused, and a
  store in the old shape whose rows and index survive the rebuild with an id two profiles can share.
- No browser flow: every claim here is reachable from a component with a faked HTTP boundary.

## Out of Scope

- Audio retention: a dictation keeps words, never the recording. The kept-audio path
  (`dictation-kept.ts`) is unchanged.
- Syncing the log through the account. It lives on the bots' hosts, not in the sync document.
- Editing a dictation's text, or re-inserting one into a composer.
- Per-bot stats rows, charts and trends; the stats card is the two combined numbers.
- Letting a take be heard by one bot and logged under another.

## Further Notes

- ADR 0060, `docs/adr/0060-a-dictation-is-kept-on-its-bots-host-and-mirrored-on-the-device.md`, is
  the decision this spec builds.
- `GLOSSARY.md` gains **Dictation** and stops listing "dictation" under **Speech-to-text**'s avoided
  words; the act and each bot's page stay named Speech-to-text.
- The plugin store moves to v44 for `dictations` and `dictation_state`; the app's Dexie gains the
  mirror and the stats cache.
