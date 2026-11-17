# A bot's Main is its host's Bot Chat

Hermes has a conversation per profile that belongs to nobody's moment: the one its Bot Mode runs in,
the one the Desktop shows as the bot's own chat, titled `Bot Chat` in the profile's `state.db`. Gots
had no such conversation. A bot's entry opened a list, and every conversation in it belonged to a turn
somebody had run — so there was no thread a reader could come back to as *where the bot is*, and no
conversation the Desktop and Gots could both call the bot's own.

**The decision: a bot's Main is the bot's host's Bot Chat.** `sessions.bot_chat(home)` resolves that
session in the profile's `state.db` — the unarchived row titled `Bot Chat`, `hidden` where the column
exists, read-only — and `chats.carrying_main(records, session, bot)` lays it over the list answer as a
projection: the record already bound to that session, else a record minted under an id naming the bot
and the session (`chats.main_id`), so a wiped store mints the same one again and two bots that reach a
Host by different profiles never key one record between them — the app keeps a chat with the bot that
holds it, so a record keyed by the session alone reached the first of them and the second bot's list
drew no Main at all. It runs where `carrying_archive` already runs, at `merged_chats`, and it is the only place a Main
is written. Every other record carrying the flag loses it, keeps its history, and is **dated past the
record it was** — the app applies a remote record only when its clock is strictly newer, so a strip
carrying the old clock never reached a device that had already synced the retired Main, and two Mains
stood for ever, the stale one undeletable because every guard refuses `main`. That is how the `main-*`
records an earlier build wrote become ordinary side chats (ADR 0161). The record the flag is **laid
on** takes the same clock rule in reverse where the flag is new to it: a gateway that retitles an
existing Gots chat `Bot Chat` adopts a record every device already holds, dated later than the session
began, and an undated flag would be one the merge drops in silence. The store's own copy catches up
when a device merges the answer back, so both cost one crossing rather than one per read.

**Where a host has no Bot Chat, Gots asks the gateway to mint one — once.** `sessions.mint_bot_chat`
goes through the gateway's own session creation — the call the Desktop's Bots roster makes — never a raw
insert: the title carries a unique index, and Hermes drops a conflicting retitle silently, so a second
row inserting the same title is how a profile ends up with a squatter and a bot whose chat never
resolves. The title is looked up first, so a `Bot Chat` another surface already holds is adopted or
deferred to rather than fought over. A host that cannot answer (no such call, an older Hermes, a
refusal) leaves the bot with a Main of Gots's own — a Gots chat, honest about what it is — rather than
two that may later diverge.

**A list read never asks for a mint on every request.** The answer that named no Bot Chat is remembered
per profile for half a minute (`MAIN_ABSENT_TTL_S`), and that window alone paces the ask: the mint is
awaited on the API server's loop and takes the gateway's titled-create lock, which is not something a
request can pay for. A bot holding a Gots Main of its own is asked again when the window opens, because
a refusal is a moment — an owner draining, a session writer holding the chat — and not a state: skipped
for already holding one, a single refusal left the bot on a Gots Main for ever, and a host that answered
on the next window was never adopted. The window is seconds because a host that gains Bot Mode writes
its own chat, which the read sees on the next answer. The one write the fallback makes stays one: the
Gots chat is minted into the store on the first answer that needs it, and a store that will not take
that write (another writer, a read-only mount) answers the record in memory rather than failing the
list read.

**Main never carries the host's archive flag, and no route can put it away.** `carrying_archive` lays
Hermes's flag over every record with a session, so a Bot Chat archived on the Dashboard would otherwise
put Main under the Archived pill. An archived Bot Chat is a retired one: it is resolved as absent, and
Main re-binds to the host's next answer. The old record stays as a side chat with everything it had.
The archive route refuses a chat that is Main (409) by asking the same resolvers the projection asks —
the host's Bot Chat through the chat's lineage, else the Gots chat the fallback minted — because the
record's copy of the flag is projection-only until a device merges it back, and reading it there
archived the bot's canonical chat with a 200 and retired Main. The refusal is *archiving* alone: an
unarchive of Main is always allowed and the route writes it, since a device that put the row away
before the flag reached it would otherwise be stranded under the Archived pill with no list to bring it
back. A route that refuses anyway (409) is the one answer the app undoes — `setArchived` writes the
mark first, and takes it off again when the Host says no.

**A turn in Main is the bot's own news.** `sessions.is_chat` answers true for the profile's canonical
Bot Chat as well as for a `gots-` session, so a reply in Main is pushed, muted and counted like any
other chat's; the daily sweep already spares a record flagged `main`. The Bot Chat is asked of the
ancestry the walk already holds, of the rows that ancestry returns and through `_bot_chat_row` — the one
rule `bot_chat` answers with — so no predicate is written out a second time and a store from before a
column (`archived` came to `sessions` after the Bot Chat did) still reads its Main. Written as a bare
`archived = 0` the statement raised on such a store and the walk answered no, so every turn in Main went
unpushed. A push runs this on Hermes's hook thread, so it stays one indexed read of the ancestry's ids
and one prepared statement for the columns.

**One read of the store serves one list answer.** The archive flags and the Bot Chat come off one pass
in one connection (`sessions.list_state`), gathered beside the Host's rooms projection rather than
awaited in series: the two used to be two scans, and both are only laid over the answer once they
arrive.

## Considered options

- **A Gots chat called Main, minted by the app on the bot's first visit.** It is what every client can
  do alone, and it splits the bot in two: the Desktop's Bot Chat and Gots's Main answer the same
  question with different conversations, and a reader who uses both finds two homes.
- **A raw insert into `sessions`**, or a competing mint with the app's own SQL. It is how the unique
  index on a title turns into a silently dropped rename, a squatting row and a bot whose Main never
  resolves.
- **The host's session id as the chat id**, rather than a record keyed by the bot and the session. A
  re-pointed chat id would graft a new session's history onto an old chat's drafts and marks; the
  request keeps the old conversation as a side chat instead.
- **Writing the projection on every read.** `carrying_main` is a projection for the reason
  `carrying_archive` is: a GET writes nothing, and a device that never asks keeps what it holds.
- **Re-binding only while the chat is untouched.** Main is meant to be the conversation the Desktop
  shows; a conversation that quietly stops being that is worse than a visible move, so the re-bind
  happens whenever the host names another, and the old one stays in the side list.
- **Gating the whole feature on a plugin flag.** An absent Main is already an honest answer, and a
  flag would let a device draw a home the host disagrees with.

## Consequences

- A device that has never met a plugin publishing a Main draws the bot's side list where Main belongs,
  and lands on Main the first time that answer arrives.
- A bot whose host cannot mint one keeps a Main of Gots's own, which the Desktop does not show as the
  bot's chat. The fallback is a Gots conversation, not the host's.
- A Bot Chat Gots asked for may not be the one the Desktop's roster recognises: Hermes's discovery
  admits a row whose `chat_id` starts with `local-`, and not every shape its own mint paths produce
  matches (an open Hermes bug). The conversation is the bot's canonical chat by title, and the
  Desktop's next mint adopts or displaces it, but the roster's row may show no canonical session until
  Hermes agrees with itself.
- When the host retires a Bot Chat its record becomes an ordinary side chat, so a reader finds two
  conversations where there was one; a host that gains Bot Mode after Gots minted a Main gets the same.
  Both are the rule rather than a fault, and the old conversation keeps everything it had.
- Two Gots bots over one Hermes profile share its store and its canonical chat, and its Main's record
  is keyed by that profile's own name and the session, so two bots that reach a Host by different
  profiles each key their own (`chats.main_id`). Two bots over *one* profile share the record as they
  share that store's whole list, and the app's table keeps it with the bot that merged it first — a
  bot is a profile, which is the only identity a request carries.
- An app build older than this change can merge Main's record without the flag; the projection
  re-asserts it on the next list answer — dated past the record it is laid on, since a device already
  holds it — and until then that device draws Main as an ordinary chat.
- Main's transcript is Hermes's own session, written by the Desktop and the TUI too; a turn started
  there reaches Main through the catch-up that already reads another writer's rows.
