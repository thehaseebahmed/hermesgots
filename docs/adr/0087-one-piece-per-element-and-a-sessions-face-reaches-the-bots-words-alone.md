# One piece per element, and a project session's face reaches the bot's words alone

**Amends [ADR 0069](0069-one-working-look-and-one-chat-face.md)** on where the code face stops: it
now reaches the bot's own words inside a card — a question and its choices, an approval's
description, a subagent's goal, a recorded question and its answers — and stops at every title,
button, count, pill and sheet heading. **Amends
[ADR 0066](0066-the-status-line-wears-a-rotating-word-and-a-loading-thread-says-so.md)** and
[ADR 0070](0070-the-status-line-is-muted-and-the-count-is-the-only-blue.md) on two points: the
rotating word is decoration for assistive tech, which hears the plain state instead, and the thought
row's live word is "Thinking", not the lowercase literal. **Records the card family's three kinds**
where before only its two shells were written down. **Amends
[ADR 0071](0071-away-is-the-headers-word-and-a-refused-message-stays-in-the-thread.md)** nowhere: a
refused message still says "Not sent" and no more.

A bot's chat and a project session are two surfaces over one thread renderer, and the elements they
draw had drifted into pairs that meant one thing in two shapes. The same quiet break was a straight
hairline in a chat and a squiggle in a session, in two colours and two sizes. A work row lost its
sign when it finished and threw its words 24px left. The same act — "your message went there" — was
"Moved to “…”" on a marker and "View thread" on a card, with Undo in two places and two caps on the
bubble. And a session's face reached its prose, its rows and its composer but stopped at every card,
so the bot's question in a session read in the app's face while its reply read in mono.

**A break in a thread is one piece: a squiggle broken by a word.** The squiggle wears the border
grey and the words wear the muted grey at 12px medium — the fainter line under the stronger words —
and the piece announces itself as a separator with its own label spoken. Three elements call it: the
day heading, which only a bot's Main draws, the model change, which only a project session draws,
and the compaction, which both draw because both compact. A chat stops drawing the model change
because a model a chat falls onto mid-run is a detail of the run rather than a mark on the work. The
day heading keeps its place in Main because triage, thread cards and moved markers are what make a
day in that flow worth dividing; a session's turns are one conversation, undivided, and the superset
rule does not reach a mark whose subject only Main has.

**A work row holds its sign's place whether or not it has one.** A finished thought row and a
finished tool group keep the empty 16px box, so nothing a reply says slides sideways when its work
ends; a row says what it is doing by its loader, never by a reflow. Its live word is "Thinking": the
lowercase literal was the one lowercase word in the thread, and sentence case is what the status
line's own words and the row's measured label wear.

**The rotating word is decoration.** The status line keeps its rotating words — they are the line's
voice while no thought row holds the turn — but a screen reader is told the plain state instead
("Thinking", "Writing"), once, rather than a new word every four seconds. What is on screen and what
is announced part company here on purpose: the rotation is personality, the state is the fact.

**A card waiting on the reader floats and wears its own colour; a card recording what happened lies
flat and muted; a card that stops the session floats and stays grey.** The third kind is the point:
read-only, resolved and discarded replace the composer because nothing can be sent, which is the app
speaking about the session, and an alarm colour would dress a decision the user made as a fault.

**The bot's words inside a card take the session's face; the app's words around them do not.** A
question's text, its choices and its Other field, an approval's description, a subagent's goal, and a
recorded question with its answers are the bot's and the user's words and read in the code face in a
session. "Question", "1 of 2", "Approved once", a button, a count, a pill and a sheet's heading are
the app's and keep the app's face everywhere. A tool call's command is drawn once, wherever it
appears: the reply's code block, labelled with the tool's name and carrying its copy button, so the
command in an approval can be taken away and read exactly as a fence in a reply.

**One way into a thread, whichever mark holds it.** A thread card a move opened says "Moved to “…”",
as the moved marker does, and "View thread" stands only where no move did. The opener's bubble is
drawn whole in both — a message cut at four lines has lost the words the mark exists to repeat — and
Undo rides the system line in both, so one control stands in one place.

**A progress reminder is a system line, not a work row.** A work row is the bot's account of its own
work; a reminder is the host talking to the model, which is the app's line for something that
happened, pressable across its width, saying the bare words "Progress reminder" and opening the
host's note.

**What was rejected.** Keeping two looks per element because the surfaces differ: the surfaces differ
in what data exists there, not in how a row is drawn, and every element that drifted did so by
accident of who wrote it first. Cutting the bubble to a preview in the thread card alone: the card's
whole job is to show the message that opened the thread. Tracing the code face through a card's
title as well: a card's heading is the app naming a thing, and a mono heading would read as the bot
having said it.

**What stays literal.** Stats show on both surfaces, with nothing drawn for a turn whose cost the
device never measured. A todo list keeps its pill in a bot's chat. A drawn interface stays flat on the
reply's edge, in its own typography. The header keeps two arrangements — a conversation's and a
place's — and the empty state keeps the bot's picture even in a session. A chat says nothing about
what only a session has. Plan mode and the session's own cards stay a session's.
