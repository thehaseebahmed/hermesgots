# A queued message draws when it is sent

**Extends [ADR 0071](0071-away-is-the-headers-word-and-a-refused-message-stays-in-the-thread.md),
which draws a send before it lands, and [ADR 0163](0163-a-steer-draws-when-it-is-sent-and-carries-no-caption.md),
which draws a steer before the host takes it, to the one send path that was left waiting: a message
that goes to the plugin's queue.**

A message sent while a reply is running goes to the plugin (`sessions/{id}/queue`) and the composer
clears at the press. The row it became was drawn only from the plugin's answer: `queueTurn` posted
the item and a read of the queue followed, and the thread drew whatever that read returned. On a
cooperating host that is one round trip — a row that appears a moment after the words leave the
field. On a host busy in a tool call it is as long as the call: the plugin answers late because the
turn it is running holds the process, so the reader had sent a message, the field was empty, and the
thread said nothing at all until the call ended. That is the same window ADR 0071 and ADR 0163 closed
for a send and a steer, and the queue was the path nobody had closed it on.

**The decision: the row stands the moment it is sent.** `queueMessage` puts a queued row in the
thread before it asks the host anything — the words, the files as they came, the mark "Queued" — and
takes it back if the post fails, which is where the composer's own handback already puts the words
back in the field with the refusal above it. The row carries no Remove and no Send now until the
plugin answers: both act on an item id, and this device has none yet. When the answer comes its item
is drawn at once (`queue-item`, in the reducer) and the drawn row goes with it, so the thread is never
waiting on a queue read for a row it already has: the drawn copy is the thread's own state, and the
page draws it a frame after the answer lands at most.

The row is the page's own, not the thread's state: `ThreadState` is kept on the device, and a reload
mid-post would draw a message no one is posting. The reducer holds only what the plugin really took,
which is also what a read of the queue would say.

**Considered options**

- **Waiting for the host, with the thread saying a send is in flight** — the same wait, wearing a
  loading state where the reader's own words go. Rejected for the reason ADR 0163 rejected it for a
  steer.
- **Sending the message straight to `POST /v1/runs` and letting the plugin queue it** — that is the
  path that only works while the app is open, which ADR 0065 and the queue itself exist to avoid.
- **Making the row actionable at once, with a Remove that reaches the plugin later** — a Remove
  pressed before the item exists has nothing to name, and a control that sometimes cannot work is
  worse than one that appears a round trip late.
- **Persisting the drawn row** — a reload does not resume the post, so the thread would draw a
  message that is going nowhere.

## Consequences

- A queued row can be marked "Queued" for the length of the post before the plugin holds it. A post
  that fails takes the row back and returns the words to the field, so the reader sees a refusal for
  a row they saw once — the shape ADR 0071 already gives a failed send.
- `Queued` carries `pending` for a drawn row, and both surfaces that draw the queue skip the actions
  on it. One reader (`queuedItem`) turns the plugin's item into that shape for both the queue read
  and the post's answer, so the row it becomes is drawn as the read would draw it.
- What the plugin answers late is still the plugin's own timing: this removes the app's dependence on
  it, not the wait inside the host.
- The current screen's own path is untouched: `queueMessage` there writes its row to the device's
  messages before it asks, which is the same decision made earlier.
- `scripts/test-chat-next-mount.tsx` holds the timing — with the plugin's queue route held, the row
  stands in the thread and the plugin does not yet hold it — and `test-chat-next-state.tsx` holds the
  reducer's `queue-item`.
