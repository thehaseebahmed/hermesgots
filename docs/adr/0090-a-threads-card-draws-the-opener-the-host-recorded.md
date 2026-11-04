# A thread's card draws the opener the host recorded

**Amends [ADR 0082](0082-a-threads-card-keeps-the-message-in-its-bubble-and-the-name-on-the-card.md)**,
which settled that a card's bubble holds the message that opened the thread and that "a thread this
device holds no message of draws no bubble at all". The second half does not stand: the reason it
gave — that a name in the bubble reads as something the reader typed — is about the *name*, and it
took the bubble away from every thread the device had never opened, which is most of them. A Main
where no card has a bubble reads as a list of names rather than as the conversation it is, and the
bubble is where the message a thread began with is visible at all.

**The opener is the host's to publish.** The message that opens a thread is typed on one device and
the thread is read on the others, so a card cannot rely on this device having stored it. The plugin
writes the opener — the message's words and the time they were sent — into the thread's chat record
when it makes the thread, for both ways a host starts one (triage opening a thread for a message,
and `/thread`), and the record travels with the title and the rest of a chat's synced fields.

**What the bubble says, in order:** the move's own text where a move opened the thread (the host
already holds it, and it is the message), else the first message this device holds for that thread,
else the record's `opener`, else nothing. A thread that reached this device before the plugin wrote
openers still draws its bubble once the device holds a message, and a host too old to write one
draws no bubble — the same card it drew before this ADR. The bubble still never says the title: the
title is the card's line, and a title in the bubble is what 0082 rejected and this ADR keeps
rejected.

## Considered options

- **Put the title back in the bubble when there is no message.** The state before 0082. Rejected then
  and still: a thread named after its first line would read as the reader having typed their own
  thread's name.
- **Read the thread's transcript when a card has no opener.** One read per card on screen, on the
  screen that already asks its host the most — the read storm ADR 0087 exists to end.
- **Record the opener only in the move.** Covers the thread triage made and nothing that `/thread`
  or another device made, which is where most threads come from.

## Consequences

- `Conversation` carries `opener` and `openerAt`; both are in `CHAT_FIELDS`, so a rename on another
  device and an opener on this one merge as one record.
- `openerWords` (`lib/thread-cards.ts`) takes the thread's record into account, and
  `scripts/test-thread-cards.mjs` pins the order above — move, device, record, nothing.
- `cardAt` reads `openerAt` before the record's creation time (ADR 0089).
- `plugin/chats.py`'s record is unchanged in shape: `opener` and `openerAt` are two more keys in a
  value the app already reads opaquely.
