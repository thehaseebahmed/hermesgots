# A steer draws when it is sent, and carries no caption

**Amends the steer's drawing in [ADR 0079](0079-a-steer-splits-the-tool-group-where-it-landed.md),
which is about where a steer lands, not when it lands or what marks it.**

A message sent into a running reply was drawn only once the host had taken it. On chat-next that
was two round trips away — `steerTurn` queues the message on the plugin and then steers it — plus
the save of any file it carried before either, and the page dispatched the part that draws it after
all three answered. The composer clears the field at the press, so for that window the reader had
sent a message and the thread showed nothing at all: a second on a good link, seconds when a file
had to be saved or the host was slow.

**The decision: the message is drawn the moment it is sent, files and all.** `steerMessage`
dispatches the `steer-drawn` event before it asks the host anything, which stands the steer in the
reply where it was sent — the same shape a turn has had since ADR 0071, where a send is drawn before
it lands. The files it carries ride with it as they came (`sentFileOf`), the way a queued row already
shows its own, and the host's answer settles that same part with the files as it saved them — each a
`SentFile` naming a host path the agent can open. A steer it refused or never got takes the part back
out (`unsteered`), because what waits then is the queue's row, and a part standing in the reply would
say it reached the agent when it did not.

The two halves are two functions, because they answer two different questions: `withSteer` draws a
send the reply does not hold yet, and `settleSteer` gives that same part the host's files and can
never create one. A settle that finds no part leaves the turn alone: the answer arrives after an
upload and two round trips, and the reply it belongs to may have ended in that window. Appending the
words to whatever reply stands now would put a steer the agent never read at the foot of another
turn. The send is named once (`randomId`), and the part carries it as `send`, which is what both
answers find it by.

**A reply being replayed is drawn from its transcript copy, and that copy has no row for a steer sent
a moment ago.** `drawn` therefore stands the device's own sent steers at the foot of the copy for as
long as the replay holds, so a reader who returns to a running chat and presses send sees their words
rather than waiting for the run's events to catch up. Where those words sat before the press cannot
be read from a replay that is still filling in; they hold at the foot until the transcript's row gives
them their place, which is the same place ADR 0079 draws for any steer.

**The caption goes.** The steer's bubble carried "Steered" muted under it (an arrow and the word, in
the app's own rows). The place in the reply already says it arrived mid-run — it splits the work it
interrupted — and the caption said a second time what the position had said, in the one row that is
the reader's own words. A queued message keeps its mark: "Queued", with Remove and Send now, because
that row is waiting rather than sent and the mark is the only thing saying so.

## Considered options

- **Drawing the words at once but leaving a mark on them until the host answers** — a faded steer,
  the way a queued row is faded. Rejected: the reader's own message fading and then settling reads as
  a send that is still in doubt, and the only fact in doubt is whether the agent read it, which the
  turn's own end says anyway.
- **Waiting for the host, and showing a spinner in the thread** — the thread has no row for a press
  in flight, and inventing one would put a loading state where a message goes.
- **Keeping the caption and dropping the timing work** — the caption was the thing the reader asked
  to be rid of; the delay was the thing that made the steer feel missing.
- **Drawing the whole steer, files and all, from the local copy and never settling it** — a file's
  tile would point at a blob on this device rather than the path the host saved, so the message would
  read as sent while the agent had nothing to open.

## Consequences

- A steer the host refuses leaves the reply for a moment and comes back as a queued row, with the
  plugin's queue read (`catchUp`) picking it up. A steer whose request fails outright goes back to
  the composer's field, as a failed send does, and the part is taken back with it.
- What the draw still needs is a live turn: the composer offers Steer from `busy` (a run the host
  lists) and `canSteer` (the screen's capability), so a press can land in the read before the page
  has attached to the run, and there is then no turn to stand the part on — it shows when the
  transcript's row lands, as it did before. The window is one read; carrying the sent steer beside
  the live turn rather than inside it would close it and is its own change, since it means a second
  field threaded through both draw surfaces.
- The steer's part carries the send's name (`Part.steer.send`), which is how the host's answers find
  it. A part folded from the transcript has none, and the pairing of a device's own part with that row
  is still by words, as it was.
- The current screen's own path is untouched: it queues the message first, so the faded queued row is
  what stands there at the press, and `steerQueued` moves it into the reply when the round trips end.
  Only its caption changed.
- `scripts/test-chat-next-mount.tsx` holds the timing: with the host's upload route held, the steer
  stands in the reply while the plugin's queue is still empty. `test-chat-next-steer.mjs` holds the
  draw, the settle and the taking back, `test-chat-next-state.tsx` the reducer's three events —
  including an answer that arrives for a reply that has moved, and a steer sent while a rejoined run
  replays — and `test-composer-steer.tsx` that the bubble carries no "Steered".
