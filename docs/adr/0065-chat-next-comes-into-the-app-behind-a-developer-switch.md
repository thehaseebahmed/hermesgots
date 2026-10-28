# chat-next comes into the app behind a Developer switch

chat-next (`app/src/chat-next/`, #666–#668) is a second chat screen. It reads a session straight
from Hermes's transcript, fixes the turn the host has written, and shares none of the logic in
`lib/chat.ts` or `lib/history.ts`. It has only run at the dev-only `/next` route, opened by query
parameters, holding everything it drew in a React reducer. It now comes into the app to replace the
chat screen, in three decisions.

**It arrives behind a Developer switch, and the old screen stays until the switch is the
default.** `Settings.chatNext` is local, off by default, and in the Developer section, like
`botThreads` and `meetings`. While it is off nothing changes. While it is on, a chat or a session
opens on chat-next. chat-next only draws a thread today: there is no composer beyond a text box, no
attachments, no dictation, no queue, no todos and no pills. If it took over at once, every one of
those would be lost the day it landed. A switch lets each one arrive and be checked against real
hosts, while everyone without the switch keeps the screen that has them. Turning the switch on by
default, and then deleting the old engine, is a later decision. It is made when nothing the old
screen does is missing from the new one, not by date.

**What it draws is kept in Dexie and drawn from live queries.** The reducer stays the one rule for
how an event changes the thread. What it keeps moves into two tables, so a chat reopens on what this
device last saw instead of a blank wait for the host, and the screen reads the database the way
every other screen does:

- `sessionRows` holds a session's transcript rows exactly as the host gave them. Each row is keyed
  by session, by which read it came from (`live` or `archive`, since the archive read holds the live
  rows too) and by the row's id, and is ordered by its place in that read. That order is the
  conversation's, which is not row-id order once a compaction has carried turns forward (ADR 0058).
  A read writes only the rows that are new, moved or changed and deletes only the ones that have
  gone. A poll that finds nothing new writes nothing, and wakes no query.
- `sessionStates` holds one record per session: the subagents the plugin last listed, whether the
  archive has been read, and the turn this device is streaming (`live`), until the host's transcript
  replaces it. While a reply streams, its words are written at most every `FLUSH_INTERVAL_MS`,
  which is `chat.ts`'s pace and now lives in `freshness.ts` for both. A tool call and a turn's end
  are written at once.

The rows and the state are read by separate live queries. So a streamed delta re-runs only the read
of one record, and the fold over the transcript runs only when the rows change.

What the page is *doing* is not stored: whether it is loading, whether it is running a turn, what the
run waits on, and why it failed. Those belong to this page's own connection to the host. A
`running` flag left behind by a closed tab would hold every later read back, and a question card left
behind would answer a prompt the host has since settled. So they live in memory, reset when the
page loads. The run that is still going is found again the way a device that never held the chat
finds it, through `runs/live`.

The page takes its database as a prop, with the app's `db` as the default. A device in the tests is
then its own database, as it is in the world. Without that, two test devices in one process would
share one IndexedDB, and the multi-device matrix would stop testing what it says. A reload in the
tests keeps its device's database, as a reload does.

**The host it needs is Hermes 0.22.5 or newer, and so does the plugin.** chat-next reads a run's
events and a compaction's rows in the shape 0.22.5 writes them. That release is also where Hermes's
own `clarify` route arrived, and where a run's events are shared between every device following it.
The plugin now declares `requires_hermes: ">=0.22.5"`, Hermes's own manifest gate, so an older Hermes
skips the plugin before importing it. `scripts/test-chat-next-version.mjs` holds the plugin's floor
to `MIN_HERMES`. The plugin is not public yet, so no installed host is stranded by the floor.

## Considered options

- **Replace the old screen in one change.** Rejected: chat-next lacks most of what the composer and
  the thread's pills do, and one change carrying all of it could not be reviewed or tested against a
  real host a piece at a time.
- **Keep chat-next in memory and mirror only a cache to Dexie.** Rejected: the app's rule is that the
  UI renders from live queries (`AGENTS.md`, Conventions). Two sources for one thread is the drift
  that rule exists to prevent.
- **Store the whole transcript as one record per session.** Rejected: following another device's
  turn reads the transcript every two seconds. Rewriting every row each time it grows by one is the
  write cost `pnpm e2e stream-writes` guards against.
- **Store `running` and `waiting` too.** Rejected for the reasons above: a closed tab would leave
  them stale, and Hermes is where both are true.
- **Gate the plugin by code in `register()`.** Rejected: Hermes's manifest gate skips the plugin
  before anything of it is imported, and logs why in Hermes's own words. A check of the plugin's own
  would need the plugin importable on every older Hermes just to say no.

## Consequences

- Dexie version 28 adds `sessionRows` (`[session+set+id]`, indexed `[session+set+pos]`) and
  `sessionStates` (`session`). Deleting a chat deletes its session's rows and state, and clearing the
  app's data clears both tables.
- `state.ts` keeps `reduce` as a pure function over rows, archive, subagents and the live turn.
  `turnsOf` folds what is held into the turns the screen draws, with the live turn laid over the
  last one.
- `store.ts` is the one writer: one store per database and session, shared by every mount, applying
  events in order and writing what changed.
- `Settings.chatNext` is added in the change that mounts chat-next on the app's routes. Until then
  `/next` stays dev-only.
- The plugin's version moves to 0.91.0. `MIN_PLUGIN_VERSION` does not move, since no app change needs
  a newer plugin route.
