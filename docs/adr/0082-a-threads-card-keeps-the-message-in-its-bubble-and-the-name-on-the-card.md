# A thread's card keeps the message in its bubble and the name on the card, with no avatar

**Amends [ADR 0034](0034-the-bot-opens-main-and-its-threads-are-cards-in-it.md)**, which settled that
every thread is a card in Main at the time it began, "with its opener bubble, so a message that opened
a thread is visible where it was typed". That stands: the message the user typed stays in its own
bubble where it was typed, and the card under it is the thread. What changes is the avatar, and what
each of the two elements says.

The box beside the card was the bot's picture. It answered "who is speaking" about something that is
not a turn, and it is gone: the bot is named in Main's own header, and a thread's card is part of
Main's flow rather than a message in it.

The two lines had drifted apart from the message they stand for. The card's line says the host's name
for the thread; the bubble's words are the message that opened it — the move's text where triage made
the thread, else the first message the user sent, as far as this device holds it. The bubble never
says the name: a thread this device holds no message of draws no bubble at all, because a name in the
bubble reads as something the reader typed. The card never says the message: the same words twice,
one above the other, read as a message posted twice.

The card's icon says what the thread is doing, and a run in flight is a spinner. Until now the card
read working only while this device streamed the reply or a subagent ran; a run started on another
device — the phone left, the desktop answering — showed the idle icon on a thread that was working.
`threadState` reads the host's own `runs/live` (`ThreadFacts.live`) as well, so the spinner follows
the host's answer whichever device began the run.

## Considered options

- **Drop the bubble and put the message on the card** — rejected as the opposite mistake: the message
  stays where it was typed, and a card is not the place it was sent from.
- **Put the name in the bubble and the message on the card** — rejected as the report: the name in the
  bubble reads as the user's own words, and the message on the card loses the message's own shape.
- **Keep the avatar beside the card** — rejected: it is the one element that makes a card read as a
  turn, and nothing in the card needs it.
- **Read only this device's own stream as a run in flight** — rejected: a run the host lists but this
  device is not streaming is still a run, and the card said idle about it.

## Consequences

- `ThreadCard` takes no `botId`; both screens that draw Main lose the argument, and the card's root
  carries `data-thread` so a test finds a card by the thread it draws.
- What the bubble says is one rule with a home: `openerWords(thread, move)` in `src/lib/thread-cards.ts`,
  pinned by `scripts/test-thread-cards.mjs` — the move's text, else the first message this device
  holds, else nothing.
- `ThreadFacts.live` is the host's answer about a run, and `scripts/test-session-work.mjs` pins that a
  thread with one reads working and one waiting on an approval reads waiting.
- `scripts/test-main-cards.tsx` asserts both halves of the split — the message in the bubble, the name
  on the card, no avatar — because a jsdom has no colour to check.
