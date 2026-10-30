# Away is the header's word, and a message the host refused stays in the thread

**Amends [ADR 0066](0066-the-status-line-wears-a-rotating-word-and-a-loading-thread-says-so.md)** on one point:
an away host no longer "keeps its banner".

A chat whose host could not be reached hid its whole composer and said "Can't reach this host right
now." as the first child of the scroller's content. The words sat above the viewport on any thread
long enough to scroll, and the scroller pins to the newest row, so the reader they were meant for
never saw them. Hiding the composer cost the field, the model pill, the `+` menu and dictation: a
chat with an unreachable host could not even be typed in, and the files already picked went with it.
A send the host refused landed in the same place by a second path — the optimistic row was dropped,
its words handed back to the field, and the error drawn as a banner at the top of the thread.

**Away is the header's word, not the thread's.** The away words replace the chat header's subtitle
while the host cannot be reached, and the subtitle returns with the host. Two wordings, split by
whether this device has a network at all: "You're offline" where it does not, "This host isn't
answering" where it does. The app cannot tell the two causes itself — a dead host and a dead device
both arrive as a fetch that failed or timed out — and `navigator.onLine` is the only fact that
separates them.

**The composer stays.** It is drawn, typeable and sends. While away a send is attempted with a short
timeout instead of the 15s read timeout, so a dead host costs a breath while a host that has come
back still works.

**A refused message stays in the thread, in the shape the current screen already gives it.** Its row is
drawn at the end of the flow, in the dimmed bubble a queued message wears, with the "Not sent" mark
beside it and the Retry and Cancel failed message the app already draws under a message that did not
go — one store, one look, one set of actions, so both chat screens say it the same way. The words leave
the composer into the row and its attachments go with it. The row belongs to the device: kept until it
is sent or removed, never written to the host, never synced, and gone the moment the host takes the turn
it was retried as.

**Nothing re-sends by itself.** A retry is the user's tap. The chat's periodic read keeps running
all the same, because it is not a retry of the message: it is what draws another device's turn, a
run that finished and the catch-up, and a read that lands is what clears the header.

**Rejected: a composer that stays but is disabled** — a chat that looks writeable and is not reads as
a bug, and it still loses the field. **A device outbox that sends on return** — it promises a send the
app cannot confirm, gives the app a second writer of the thread's order, and the host's own queue
already owns "hold this until it can run". **Dropping the refused row back into the draft** — the words
leave the place the user left them, which is the state this replaces. **Stopping the periodic read
while away** — the header could then never clear itself and another device's turn would never arrive.
