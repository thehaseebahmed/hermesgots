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
a muted line of time, bot and word count, and opens a sheet with the whole text, its metadata, Copy
and Delete. Bots links to every bot's Speech-to-text page, in list order, with a bot whose host
can't dictate shown disabled with the host's reason. Stats is one card with the words spoken across
every bot and the pooled words per minute behind them.

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
  pauses are left out. A take cancelled or failed before any words landed writes nothing.
- **The plugin gains five routes behind a `dictations` feature**: `POST dictations`,
  `DELETE dictations/<id>`, `DELETE dictations`, `GET dictations?before&limit`, and
  `GET dictations/stats` returning the totals plus count, newest, oldest and `clearedAt`. The paged
  read serves a mirror that has to be filled or repaired, never the draw path.
- **The stats route does two jobs**: it is the numbers tab 3 draws and the fingerprint the mirror is
  reconciled against. The app sums each bot's last answer and caches it on the device, so the Settings
  menu's subtitle reads "1,204 words" — or a generic line until a host has answered once.
- **Reconciliation is fingerprint first.** On opening the screen, once per bot and side by side, a
  matching fingerprint does nothing; `clearedAt` drops every mirror row older than it without a
  row-by-row compare; an append reads the newest page; any other divergence walks the log back a page
  at a time and writes what the host has and drops what it no longer does.
- **Clearing is one action over every bot**, on the screen's header, behind a confirmation, each host
  stamping its own `clearedAt`. A bot without the routes loses only its local rows.
- **A bot that cannot answer contributes nothing to the totals**, and a bot without `dictations` is
  still listed in Bots, disabled with its host's reason.
- **Tabs live inside the one section screen** (the `Tabs` component), so back leaves Dictation.
- **The screen is a component, not routes**; the section is one entry under Appearance and
  `/settings/dictation` opens it.
- Nothing raises `MIN_PLUGIN_VERSION`; the plugin's version rises in `plugin.yaml` and
  `dashboard/manifest.json`, and the plugin store's schema moves one version for the two new tables.

## Testing Decisions

- Unit, pure rules (`app/scripts/test-dictation-log.mjs`): an entry's word count and spoken span from
  a take's pieces, the month key and heading of a dictation, the fingerprint comparison (match,
  stale window, clear), and the pooled rate including a zero-words and a zero-milliseconds case.
- Component (`app/scripts/test-dictation-screen.tsx`): the three tabs render over a seeded mirror; the
  month headings and their card grouping; twenty rows and more appended; a row opening its sheet with
  Copy and Delete; the clear action behind its confirmation; the Bots tab listing a disabled bot with
  its reason; Stats showing the summed words and rate from the cached answers.
- Plugin (`plugin/tests/test_dictations.py`): a write, a paged read, a delete, a clear that stamps
  `clearedAt`, stats that answer only their own profile, and a body that names no text being refused.
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
