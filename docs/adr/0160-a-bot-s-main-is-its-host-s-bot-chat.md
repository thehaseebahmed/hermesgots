# A bot's Main is its host's Bot Chat

Hermes has a conversation per profile that belongs to nobody's moment: the one its Bot Mode runs in,
the one the Desktop shows as the bot's own chat, titled `Bot Chat` in the profile's `state.db`. Gots
had no such conversation. A bot's entry opened a list, and every conversation in it belonged to a turn
somebody had run — so there was no thread a reader could come back to as *where the bot is*, and no
conversation the Desktop and Gots could both call the bot's own.

**The decision: a bot's Main is the bot's host's Bot Chat.** `sessions.bot_chat(home)` resolves that
session in the profile's `state.db` — the unarchived row titled `Bot Chat`, `hidden` where the column
exists, read-only — and `chats.carrying_main(records, session)` lays it over the list answer as a
projection: the record already bound to that session, else a record minted under an id derived from the
session, so a wiped store mints the same one again. It runs where `carrying_archive` already runs, at
`merged_chats`, and it is the only place a Main is written. Every other record carrying the flag loses
it and keeps its history, which is how the `main-*` records an earlier build wrote become ordinary side
chats (ADR 0161).

**Where a host has no Bot Chat, Gots asks the gateway to mint one.** `sessions.mint_bot_chat` goes
through the gateway's own session creation — the call the Desktop's Bots roster makes — never a raw
insert: the title carries a unique index, and Hermes drops a conflicting retitle silently, so a second
row inserting the same title is how a profile ends up with a squatter and a bot whose chat never
resolves. The title is looked up first, so a `Bot Chat` another surface already holds is adopted or
deferred to rather than fought over. A host that cannot answer (no such call, an older Hermes, a
refusal) leaves the bot with a Main of Gots's own — a Gots chat, honest about what it is — rather than
two that may later diverge.

**Main never carries the host's archive flag.** `carrying_archive` lays Hermes's flag over every
record with a session, so a Bot Chat archived on the Dashboard would otherwise put Main under the
Archived pill. An archived Bot Chat is a retired one: it is resolved as absent, and Main re-binds to
the host's next answer. The old record stays as a side chat with everything it had.

**A turn in Main is the bot's own news.** `sessions.is_chat` answers true for the profile's canonical
Bot Chat as well as for a `gots-` session, so a reply in Main is pushed, muted and counted like any
other chat's; the daily sweep already spares a record flagged `main`.

## Considered options

- **A Gots chat called Main, minted by the app on the bot's first visit.** It is what every client can
  do alone, and it splits the bot in two: the Desktop's Bot Chat and Gots's Main answer the same
  question with different conversations, and a reader who uses both finds two homes.
- **A raw insert into `sessions`**, or a competing mint with the app's own SQL. It is how the unique
  index on a title turns into a silently dropped rename, a squatting row and a bot whose Main never
  resolves.
- **The host's session id as the chat id**, rather than a record keyed by it. A re-pointed chat id
  would graft a new session's history onto an old chat's drafts and marks; the request keeps the old
  conversation as a side chat instead.
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
- Two Gots bots pointing at one Hermes profile share its store and its canonical chat, so one Main
  serves both lists, as that store's other chats already do.
- An app build older than this change can merge Main's record without the flag; the projection
  re-asserts it on the next list answer, and until then that device draws Main as an ordinary chat.
- Main's transcript is Hermes's own session, written by the Desktop and the TUI too; a turn started
  there reaches Main through the catch-up that already reads another writer's rows.
