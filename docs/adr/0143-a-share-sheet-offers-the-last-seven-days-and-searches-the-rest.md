# A share sheet offers the last seven days, twenty-five at most, and searches the rest

The share sheet is a pick made while the app the reader was in is still on screen: an article, a photo,
a link, and then one tap on where it goes. It drew the picked bot's newest five chats, Show more to
thirty, and nothing else. A code session — where a bot does the work this app is also for — was not a
row at all, though a session is a conversation of the same store, with a title and a clock like any
chat. And a bot with a long history was reachable only by pressing Show more through the thirty newest,
with nothing at the foot for anything older.

**So the sheet offers a week, and the clock is the bound.** A row is offered while its `updatedAt` is
inside the last seven days (`SHARE_WINDOW_MS` in `lib/share-list.ts`). That is the clock a chat's, a
session's and a room's row already draws its age from, so the list reads as what the reader has been
doing this week: each row's "2 hr. ago" says why it is there, and nothing on the sheet needs a date to
make sense of the order. A page size — the newest five, or the newest thirty — answered a different
question, *what did I touch most recently*, with a number the rows around it had to explain, and it grew
wronger the busier the bot was.

**Ten rows, then Show more for the rest of the window, and a hard twenty-five.** `SHARE_FIRST` is what
the sheet draws first: a pick on a phone is a glance, and ten rows is what a thumb takes in under the
thing it is sending. Show more reveals the rest of the week — all of it, not one more page — up to
`SHARE_MOST` rows. Twenty-five is a limit rather than a page size: past it the sheet would be a list the
reader pages through to leave, and what lies beyond it is reached by looking for it.

**One list, newest first, told apart by the mark it wears.** A code session is a row of the same list as
a chat, wearing Code's mark where a chat wears its bubble; two rows touched at one moment keep one order
by id, so two devices draw the same list. A second band or a second heading for sessions would be a
second ordering rule, and rows would move under the reader as one kind's clock overtook the other's —
the argument ADR 0136 made for a bot's chats. A canvas's chat and a discarded session are out: a canvas
lists nowhere (ADR 0113), and a session the reader has thrown away is not a place a note is sent from.

**The search at the foot reaches everything the bot is in, not only the rows past the window.** A window
with no way out would be a trap: the chat the reader shared into last month is exactly what a share
sheet is for. So the field matches titles through the matcher the app's lists already use
(`filterByFuzzy`), and a query replaces the window with every match, in full — in the matcher's own
order, its best matches first and the newest first inside a rank, since a search narrows a list
rather than re-ordering one — saying "Nothing matches." where nothing does. A search that stopped at
the twenty-five would refuse rows the sheet had just shown, which no reader would understand.

**A room is a row of the same list, and is sent through the room's own store.** The rooms whose roster
seats the picked bot join the window and the search, wearing their members' faces where a chat wears an
icon. A room is not a chat: its words live on the Host, and its message is an event the Host appends. So
a share into one uploads each of its files to the room's store and sends the note as one message, and a
share carrying more than the eight files a room's message takes is refused in words rather than half
sent.

## Considered options

- **Keeping the newest thirty, with no window.** A count by recency is a page whose edge nothing
  explains: a reader who reached it learned nothing about why the list stopped, and the number had to
  grow with the bot.
- **A window with no cap.** A bot in a busy week holds more than twenty-five rows, and the sheet would
  become a list to page through — the screen the reader was sharing from, drawn again.
- **Two headings, chats then code sessions.** That is a second ordering rule, and a session touched this
  morning would sit under every chat of the week rather than where its own clock puts it.
- **A control that narrows the list to code sessions.** The mark already says what a row is, and a
  filter over ten rows is a control to press before the one the reader opened the sheet for.
- **The search at the top, as a bot's chat list has it.** The sheet's top holds the share itself — what
  arrived, and the note — and the foot is where a thumb already rests.
- **Listing canvases with everything else.** A canvas's chat is its own screen's and lists nowhere
  (ADR 0113); its row here would open a thread no other list shows.
- **Sending a room's share as a chat message about the room.** The Host's log is the room, and a message
  written into a chat row would be a second log of the same conversation.

## Consequences

- The sheet reads every conversation of the picked bot off `[profileId+updatedAt]` and lets the rule
  window it, rather than asking Dexie for a window the rule would have to agree with a second time —
  and `useRoomNeeds`, which places the rooms beside them, scans every conversation the device holds.
  Both are accepted as they stand: a conversation record is cheap, neither read reaches the network,
  and the rows the sheet draws are ten, so opening it costs a bot's history and the room list rather
  than the week.
- A room send keeps what a failed tap minted — the event id, and each file's upload id with the
  manifest the Host answered — and reuses them while the same words and the same files are sent into
  the same room again, as the room's own composer reuses them. A retry of the same share into the
  same room is therefore one message and one upload per file, where a note or a file set the reader
  changed is a new message and mints anew; a file whose manifest is already in hand is not uploaded
  again.
- A window holding ten rows or fewer draws no Show more at all, and a bot whose week is one chat draws
  one row.
- A chat older than the week is not a row of the sheet. The search is how it is found, so the field is
  not optional on a device with history.
- A code session sends the way a chat does: the note lands in the session's own thread at its address,
  so nothing new is written for a session's row — what changed is that the row is offered.
- A device whose session records lag its host can put a busy row outside the window, where only the
  search finds it.
- The window and the cap read the record's clock, not the newest message's, so a chat whose last message
  landed from another device moves into the week when its record does.
- The search at the foot and the rooms as rows are the rest of this decision and landed behind it in
  the same change. The search is how a row past the twenty-five is reached, and a room's row comes
  from the device's own room list rather than from the bot's read — its record is in both, so the
  rule places it once beside the chats.
