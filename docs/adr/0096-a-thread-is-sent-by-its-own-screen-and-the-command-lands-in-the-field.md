# A thread is sent by its own screen, and the command that carries a message lands in the field

**Amends [ADR 0090](0090-a-threads-card-draws-the-opener-the-host-recorded.md)**, whose consequence
reads "`plugin/chats.py`'s record is unchanged in shape" and whose prose has the plugin "write the
opener … for both ways a host starts one (triage opening a thread for a message, and `/thread`)". The
host writes an opener for the thread *triage* opens, because triage is the host's own act; `/thread`
never reaches the plugin at all — the app makes the chat record and syncs it — so the opener of a
thread started that way is the app's to write, and one of the app's two send paths never wrote it.

Two reports from the same screen, with one cause. A thread started with `/thread` opened on a chat
that drew nothing until it was left and opened again, and back on Main its card stood with no bubble
above it — the message the reader had typed with the command shown nowhere at all. Both follow from
the turn being posted by the screen that *left*: Main created the thread, posted the run to its
session and navigated away, so the screen that then drew the thread had seen neither the message nor
the run, and the write that records the opener never ran, because the screen that owns a chat's first
send is where that write lives.

**The pick types the command; Send is what carries it out.** The composer's `/` menu is a list of
things a message can be, and one of them — `/thread` — says where the message goes rather than
doing something on the press (`carriesMessage`). Picking it inserts `/thread ` at the caret, exactly
as a skill's name is inserted, and the field keeps whatever was typed after it. A press of Send then
runs it, with that text as the thread's first message, and `/thread` alone still opens an empty
thread. The other commands (`/new`, `/settings`, `/cheatsheet`) still run on the pick: each does
something on the spot and none of them takes a message, so a press on one has nothing to type into.
The complaint was that a pick put the reader on a screen the thread had nothing in yet, and that the
words they meant to send with it had nowhere to go — a command that takes a message is a prefix, not
a button.

**A thread started from Main is sent by the thread's own screen.** Main still makes the chat record
— it holds the model pick the thread runs on (ADR 0059) — and hands the message over to that thread's
id, in a map the app holds (`handOver`/`takeHandover` in `lib/threads.ts`), which the screen that
draws the thread takes once. The handover is beside the address rather than in it because the address
is one for every screen mounted at once: a bot's Main sits beside its thread from `xl` (ADR 0041), and
a `start` read from the shared address was taken by whichever of the two rendered first — the pinned
Main stripped it and sent the reader back to Main, and a remount that kept `history.state` let both
instances send the same message. A map keyed by the thread's own id is taken by the screen that draws
that id and by no other — chat-next's screen is keyed by the chat it draws, so the take is the new
instance's, not an old one's — and a take is what releases the entry, so a remount or a back sends
nothing twice. The entry carries the time the reader sent the message too, so a thread opened a
minute later still stamps its opener, and stands its card, where the words were typed.

The thread's screen then sends it as it sends any message of its own: drawn at once in the flow it
belongs to, the run followed by the page that started it, the title and the opener written by the
same settle. That is the shape every other first message in a chat already had, and it is why the
message now stands in the thread as its reader arrives. Both of the app's send paths do it — the
current screen's, whose send writes the thread's own rows, and chat-next's — so `/thread` reaches the
same rule whichever screen is on.

**The opener is written by whichever path sends a chat's first turn.** `lib/chat.ts` has written
`opener`/`openerAt` since ADR 0090; `chat-next/turn.ts` now writes them on the same condition — a
chat's first turn, not Main, no opener yet — so a thread this device started carries the bubble its
card draws on every other device. The 2000-character limit lives in `lib/words.ts` beside `oneLine`,
one constant for both writers.

## Considered options

- **Carry the message in the address (`state.start`).** What was tried first, and what the double
  send above came of: the address is the one every mounted screen reads.
- **Keep posting the turn from Main and have the new screen join it.** The run id would have to
  travel the same way, and the thread would still be blank for as long as the host takes to write the
  turn's first rows — the screen that did not send it has no row to draw until then.
- **Make `/thread` create the thread and stay on Main.** The thread's reply would then run in a chat
  the reader is not looking at, and the card would appear without any of it being opened — a bigger
  change than the report asks for, and against 0034's "one screen is the bot".
- **Have the pick run the command with the field's text, as the send does.** It is the same
  behaviour that was reported, arriving one press earlier: the reader picks the command to say where
  they are going, then types.
- **Write the opener only in the move.** ADR 0090 rejected it, and it cannot cover a `/thread` at
  all: no move exists for a message that was never triaged.

## Consequences

- `startTurn` is gone from `chat-next/turn.ts`; nothing starts a turn for a screen that is not the
  one drawing it.
- `ThreadStart` (`lib/threads.ts`) is the message handed between the two screens — `Unsent` without
  its id and time — and `start` is the chat-next page's own option for it. One `beginThread` makes
  the record and hands the message over for both screens.
- The opener is one rule (`openerFor` in `lib/send-turn.ts`, beside `titleFrom`), read by both send
  paths and stamped with the time the reader sent the message, not the time the post settled: the
  handover's own `at` reaches both sends (§`sendMessage`'s `at`, and `sendTurn`'s).
- `OPENER_CHARS` moves to `lib/words.ts`, carrying the host's own cap (`plugin/triage.py`) with it.
- `scripts/test-thread-command.tsx` pins the pick that types and the Send that starts; 
  `scripts/test-chat-next-main.tsx` pins the thread drawing its message at once and the record
  keeping the opener; the `bot-threads` flow asserts the pick lands in the field and opens nothing.
