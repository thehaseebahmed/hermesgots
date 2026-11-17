# A chat's archive is Hermes's archive

The sheet's Archive wrote a field on the chat's record, and nothing else. Hermes has had the feature
all along: the `sessions` table of the profile's `state.db` carries an `archived` column, and
`hermes sessions archive` — and the archive in the Desktop and the Dashboard — sets it. That flag is
what takes a session out of `hermes sessions list`, out of `/resume` and out of the Dashboard's list;
it keeps the session's messages and its search, and it is undone from the Dashboard.

So there were two archives, and they disagreed. Archiving a chat in Gots left its session standing in
every Hermes surface, still resumable from the terminal as if nobody had put it away; archiving in
Hermes left the row in Gots's list, still answering and still counted. The reader had to do it twice,
in two places, and each place could only see half of what they had done.

**The decision: for a chat and for a routine's run, the archive is Hermes's `sessions.archived`.** A
**room** keeps Gots's own mark (`roomMarks.archived`, ADR 0157) and nothing about that path changes:
a room is the Host's and has no Hermes session of its own, so there is no flag for it to carry.

## What each kind is archived by

- **A chat.** Hermes's flag on its session. The reader's press writes the flag and the chat record's
  copy of it, and every list answer reads the flag back, so the two surfaces cannot disagree.
- **A routine's run.** The same, through the session the run was started on: a run is a chat that
  nobody typed in, and Hermes archives it the same way.
- **A room.** `roomMarks.archived`, the record the plugin keeps under the room's own id and lays over
  the room it projects (ADR 0157). A room has no session, so no flag of Hermes's can stand for it.

## How the plugin writes it

`sessions.set_archived(home, session_id, archived)` is a metadata write on the profile's `state.db`,
the same shape as the two the plugin already makes there — the session label repair
(`sessions.heal_sources`) and the worktree stamp (`sessions.stamp`): the file opened for writing,
never planted, `UPDATE` one column, and a store that won't answer is a reason returned rather than an
exception raised.

`chat_session` resolves the chat's own first session, and the write then runs on through the
compaction children to the live tip, in Hermes's own lineage selector's shape. That is not a detail:
Hermes lists a compacted conversation by its newest session, and it archives the lineage as a unit,
so a flag set on an old compression segment hides nothing at all while a flag set on the tip alone
would be resurrected by the root on the next refresh. `hermes sessions archive` flips the same
lineage for the same reason.

One column is written and nothing else — the schema is Hermes's, and a store that doesn't have the
column is not this plugin's to migrate.

## The route

`POST {PREFIX}/chats/{chat_id}/archived`, body `{"archived": true|false}`:

- `{"object": "gots.chat.archived", "archived": <bool>, "host": <bool>}` — `host` says whether
  Hermes's own session took the flag.
- `404` for a chat the store doesn't hold, or one with no `hermesSessionId` — a room, or a chat
  nothing has been said in. There is nothing for Hermes to archive.
- `400` for a body that isn't JSON, or an `archived` that isn't a boolean.

The record is written **whether or not the host took the flag**: that copy is what reaches every
device through the merge the app already makes, and what a chat still reads as once its session has
gone. `host: false` — no `state.db`, or one whose schema has no `archived` column — is the app's cue
to keep its own mark, which is exactly the behaviour every device had before this route existed.

`info` advertises `session_archive` beside `room_marks`, and the app posts only where the row's bot is
callable and its plugin advertises it. An older plugin stores the record and nothing else, so the app
asks it nothing and a chat's archive stays on the device that made it.

## Reading Hermes back in

`chats.carrying_archive(records, flags)` is a pure function applied in the one place both list routes
go through — `merged_chats` in the plugin. `flags` is `{session_id: bool}` read in one pass over the
profile's store. Each chat record whose `hermesSessionId` the store names takes that session's flag
**both ways**: archived in Hermes is archived here, and unarchived in Hermes is unarchived here. A
record whose session the store doesn't name keeps what it holds, and a room's mark record is skipped —
it is not a chat (ADR 0157), and its archive is not Hermes's. A store or a column that isn't there
answers no flags, and every row stands as the device has it.

## Considered options

- **Keep Gots's field as the archive.** It is what the reader reported: two archives, each of which
  leaves the other surface's list untouched.
- **Read Hermes's flag back, but never write it.** An archive made in Gots would still leave the
  session in `hermes sessions list`, `/resume` and the Desktop — the half of the complaint that made
  the reader archive in two places.
- **Call Hermes's `SessionDB.set_session_archived` through the API server's adapter.** It is the same
  write, but it goes through the live session store, which drains a running turn's queued token
  writes and shares the API server's executor — the stall `chat_session` exists to avoid, on the one
  request a list answer already pays for. The profile's `state.db`, resolved by the caller and not
  from `os.environ`, is the seam this plugin already writes its session metadata through.
- **Archive the row the chat is keyed by, and only that row.** Hermes lists a compacted chat by its
  tip, so the flag would hide nothing in `hermes sessions list`, and the next refresh through the
  root would put it back.
- **Archive a room with the same flag.** A room has no session; the nearest thing would be the
  answering member's, which would archive a bot's own chat rather than the room. ADR 0157 stands.

## Consequences

- An archive made in Hermes now hides the row in Gots, and an archive made in Gots takes the session
  out of `hermes sessions list`, `/resume` and the Dashboard too. There is one archive, and it is
  undone either from the Dashboard or from the sheet's Unarchive.
- An older plugin — one that doesn't advertise `session_archive` — keeps today's behaviour exactly: the
  mark is the device's own, and a second device hears of it through the merge, as before.
- A store without the `archived` column falls back to Gots's own mark, and says so in the answer
  (`host: false`) rather than letting the app believe it wrote a flag nothing holds.
- Every list answer now reads the profile's `sessions` table once for its flags. That is one scan
  beside the Host projection each read already pays for.
- The write sets `archived` and leaves `auto_archived` — the idle sweep's provenance — alone: the
  schema is Hermes's, and one column is the whole of what this plugin touches. A chat the sweep hid,
  which a reader then archives here, therefore keeps that mark, so a later resume of that session can
  un-hide it in Hermes while Gots still reads it as archived until the next list answer says otherwise.
- A room's archive is untouched by all of this: no session, no flag (ADR 0157).
