# A chat's model is fixed at its first send

A bot's Default model says what its turns to come run on, and a chat used to ask for it again on every
send: the model was resolved at each turn — the chat's own pick, else the bot's default
(`Profile.modelChoice`), else whatever the host runs — so a change made in Settings reached every
session already under way. The next message in a Thread, or a stage of a Code Session, ran on a model
the user had not chosen for it, and the only trace was a divider drawn after the fact (ADR 0010). The
report was a thread that changed models between one message and the next with nothing on screen saying
so. A model belongs to the conversation the user started; changing the default is a statement about
chats to come.

So a chat's model is fixed at its first send. The two paths that resolve one — `prepareSend` (under
`sendMessage`) and `queueOnHost` — call `pinModel`, which writes the model in effect into the chat's
own pick (`Conversation.modelChoice`) and hands that copy back with the one way to take it back, so the
turn that pins is the turn that sends the pin, and every window that can leave the turn unsent releases
it: a run the host refused, the message rows a store refused, a plugin that would not take the queued
turn. A pin left behind by a turn that never reached Hermes would fix the chat to a model the user had
already set the default away from.
The model in effect is what the device already holds: `Profile.modelChoice` where the bot keeps a
default of its own, else the host's model as the last read left it in `Profile.hostModel` — the same
`botModel` the picker draws, so a chat is never shown one model and fixed to another. No send waits on
the host for a model; only a chat neither of those names a model for is asked, after its turn has run,
through the cache the pickers already keep (`modelInfoFor`, one read a minute), and a host that names
nothing to pin leaves the Default row's marker on the chat, which records the question as asked so the
next send doesn't ask it again. The read is deliberately not written back to `Profile.hostModel`, which
would bump the bot's sync clock for a read. A chat that already holds a pick of its own pins nothing —
the user's pick is the pin — and a send that finds another device's sync landed in the meantime keeps
it, because the write re-reads the row inside its transaction before it writes, and returns what it
found.

Main is the exception, and the only one. The bot's Main thread follows the Default model for as long as
it lives, since that is its whole job: it is where a user changes what the bot runs next without
opening a thread. `pinOf` answers nothing for it, so nothing is ever written there.

There is no migration. A chat that has already been sending pins at its next send, to whatever the
default is then, and keeps it from that send on. That is the only honest way to move a chat whose model
nobody wrote down: this device knows what it sent each turn with (ADR 0010) and nothing else, so a
backfill would be a guess about turns that already ran — and, for a session that has only ever run on
the default, a guess that would move it onto a model chosen today.

The pin travels as the app's own field. `Conversation.modelChoice` is the pick the chat list already
round-trips through the plugin's `chats` store, so nothing new is stored and no route is added; the
plugin reads it where a run is posted outside the app. `chats.by_session` finds a chat by the session id
AFK keys by, or by a value's `hermesSessionId` — what the app keys by — asking the row its id keys first
and then one query against the `chat_session` expression index for the records whose value names the
session, so a read decodes only those rows instead of walking the list; it answers nothing for a closed
record. `chats.pick` holds what a pick is — both halves, named — and everything that reads or carries
one asks it: `chats.choice` as `{ provider, model }` off a record,
`chats.pin` as the one read of a session's pin, `chats.pin_fields` as the one spelling of a pick on a
body, `chats.set_choice` as the one write of one. `host_model.read_main` answers the profile's main
model for a session with no record to read yet, and names no provider unless the file states one — a
main model with no provider, or one left on `auto`, is not a pick and pins nothing, since the main model
has nothing above it to fall back on and guessing a route would move the run somewhere the file never
chose; the session's runs then name no model and the host's own answer decides, which is what every run
did before the pin existed. AFK's `_begin` resolves a new session's pin once (`_starting_pin`) and hands
it back with the prompt and the snapshot, so `start` names it on the first run and hands the same dict
to `publish`, whose record carries it; `work_stage` reads `chats.pin` back for every stage, and
`sessions.put_wake_batch` reads it once, in the call that writes a wake batch's intent and freezes it
with the text. A stage and a wake are ordinary turns of a session already under way, so they carry what
it started on.

A message triage moves out of Main is a thread's next send, and pins it. The ask the app builds names
the model Main runs on — Main's own pick, else the bot's default, else the host's remembered model,
resolved on the device, since this path carries no model read either — and the plugin writes it onto the
thread the message lands on when that thread has no pick of its own, before queueing the message there
(`triage.deliver`, `chats.set_choice`). A thread that already has a pick keeps it, so Main's model never
overwrites a chat's own, and a thread triage opens keeps the name its first run went out on. Naming
nothing would have made a triaged message the one send that never fixed a model: the plugin strips the
run's model and restores only the target thread's own pick, so the thread ran the host's current default
and stayed free to move with it.

## Considered options

- **Leave resolution where it was and trust the divider** (ADR 0010). Rejected: the divider is a record
  of what happened, and the complaint was that it happened — someone reading a thread has no reason to
  check a divider above an earlier turn before typing.
- **Pin on the host**, as a model on the plugin's session record, written before the first run.
  Rejected: starting a chat would need the host up, and a host that was away would leave the chat
  unpinned and moving with its file; the pick is the app's already and is synced, so the plugin has only
  to read it.
- **Pin when the chat is created.** Rejected: a chat is created when its composer opens and can sit as
  a draft for days, so it would pin a default the user never sent a turn on — the first send is the
  first moment a model actually runs, which is what the pin describes.
- **Copy today's default onto every existing chat in a migration.** Rejected: it would move chats that
  have already run onto a model chosen today, and rewrite a history whose models the app can't see.
- **Pin Main too.** Rejected: that leaves the one screen a user changes the default on stuck on the
  model it started with.
- **Ask the host for the model before the first send.** Rejected: a send would wait on a read for a
  value the device usually holds already, and a cold cache is seconds of a message not appearing. The
  pick comes from `Profile.modelChoice`, `Profile.hostModel` and the chat's own row, and the host is
  asked only afterwards, for the chat none of those names a model for.

## Consequences

- **A host that names a model but no provider pins nothing, and the chat follows the default.** The pin
  is the pick its caller resolved, and `pinOf` takes only one both halves of which could be sent: half a
  pick, an empty provider and the provider `auto` are all refused — as the plugin refuses a record
  missing either half (`chats.pick`) and a main model left on `auto` (`host_model.read_main`). So a bot
  whose host reports a model with no provider, or whose main model sits on `auto`, gives the chat
  nothing to pin; once its turn has run the chat takes the Default row's marker instead, which records
  the question as asked so it isn't asked again, and its turns go on running the host's own model until
  the user picks one. No pin is ever written that no run could carry.
- **A sync record that names no model leaves the pin where it is.** Chat sync is whole-record
  last-write-wins on `changedAt`, and `applyChats` (`app/src/lib/sync.ts:567-599`) writes every
  `CHAT_FIELDS` value from the incoming record — all but `modelChoice` when the record carries none,
  because every choice made in the app writes either a pick or the Default row's marker, so an absent
  one can only mean the record has nothing to say about the model. Clearing it there would lose the pin,
  and the next merge would carry the loss back to the plugin, so an AFK stage or a wake would run the
  changed default too.
- **A pinned chat no longer falls back with its bot.** A turn that names a model explicitly no longer
  benefits from the bot's `fallback_providers` chain when its own model fails, so a model that fails
  fails there rather than being retried down the chain.
- A pinned turn names its model on `/v1/runs` (`{ model, provider }`, through `pickFields`, so the two
  halves travel together or not at all), and goes on naming it after the default moves on, so what the
  host runs is what the pill says. The divider (ADR 0010) now divides only where the user picked: the
  default no longer reaches a chat under way, which is the point.
- **A wake was the one run the pin did not reach.** `delegation._wake_root` built its batch body from
  the input alone, so the turn a finished subagent's result arrives on still chose its model per turn:
  a conversation settled on one model woke onto whatever the profile's Default model said at that
  minute — the movement this ADR exists to stop, on the one turn nobody types. The body now names the
  conversation's `modelChoice`, read once when the batch's intent is written and frozen with its text
  (`sessions.put_wake_batch`, `subagent_wake_batches`' `provider` and `model`, schema v42), because a
  retry has to re-post the same bytes under the batch's key: core replays a key it remembers and answers
  409 for a changed payload, which the outbox treats as permanent, so a pick read again at the retry
  would drop the whole batch. A record that pins none names neither `model` nor `provider` — the host's
  own model, ADR 0026's behaviour for a conversation that never pinned, so a store that can't be read
  never costs a wake.
- **A pin is read back out of the chat list, once per run, against an index.** The list is keyed two
  ways — an AFK record by its session id, a chat the app made by its own id with the session in
  `hermesSessionId` — so the read used to be the whole list, paid on every stage of every task and every
  wake, on a host that may be holding every chat the user has ever had. `chats.by_session` asks for the
  one row the session id keys (`chats.one`), and whatever that misses is answered by one query on
  `json_extract(value, '$.hermesSessionId')` off the `chat_session` expression index, so the rows
  decoded are the ones that name the session and nothing else. That index joined the migration after the
  store had already shipped v42 with it, which is why the version moves to 43: a store at 42 runs the
  block again and builds the index, and every ALTER in it is `PRAGMA`-guarded and every index says
  `IF NOT EXISTS`, so nothing else moves. Each caller reads once: `afk._begin` for the run and the
  record it publishes, `afk.work_stage` for a stage, `sessions.put_wake_batch` for a whole batch of
  finished subagents — and not again when that batch is retried, since its model froze with its intent —
  never once per child.
- ADR 0026's claim that AFK's runs carry no model is superseded in part: a run of a session with a
  record carries its pin, and so does a wake turn. Everything else there stands.
- Main still follows the default live, so a user who wants a new default everywhere changes Main, or
  picks it per chat.
- `app/scripts/test-model-pick.mjs` pins the rules as units (8 tests, 0.1 s) and
  `app/scripts/test-model-pin.tsx` the component paths (13 tests, 20 s); both were verified red before
  the fix with `pinModel` neutered, and green after it. The triage ask's model is
  `app/scripts/test-main-triage.tsx`: a bot's own default, a bot whose default is the host's remembered
  model, and a device that can name neither — the ask naming both halves of a pick, and no read on the
  way. The plugin's read-back is `plugin/tests/test_chats.py`'s `SessionPins` over a temp store — both
  keys, a closed record, a half-written pick, and a store already at v42 gaining the index — with a
  thread taking the model its next send names in `plugin/tests/test_triage.py`, and a wake frozen on its
  own model in `plugin/tests/test_delegation_wake.py`.
- `AGENTS.md`'s rule for a chat's model and `GLOSSARY.md`'s **Model pick**, **Default model** and
  **Pin** say this now.
