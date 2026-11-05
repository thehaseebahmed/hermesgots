# A queue paused by a lost turn is read from the host's ledger, and cleared from the chat

Hermes admits every prompt to a session's own FIFO (`session_admissions`) rather than refusing it
while a turn runs. A turn whose owner restarted mid-execution cannot be known to have finished, so
it is fenced `unknown` — the TUI draws it as `[paused: lost in restart · ↑ select, Ctrl+X discard]` —
and **nothing queued behind it runs**. Only a client of the gateway can clear it:
`prompt.resolve_unknown`, from the TUI's `/discard` or `hermes sessions discard`.

The app had no door to any of that. A chat whose session was fenced this way showed a queue that
never moved and no reason for it: a message sent from the phone was admitted and waited behind a
turn that would never finish, so it never started, never streamed, and never failed. The only way
out was a terminal on the host, which is exactly what the app exists to avoid.

**The queue is read from the ledger, and the lost turn is discarded from the chat.** The plugin reads
a session's pending rows through Hermes's own reader (`list_session_admissions`) and answers them as
`GET sessions/{id}/pending`: the inputs still in line, in FIFO order, each carrying only the words its
sender typed, `lost` naming the one row the host cannot say finished — the row that holds the rest —
and `running` saying the host is executing a turn there, rather than a per-row status the app would
have to translate. `POST
sessions/{id}/pending/{admission}/discard` acknowledges that turn through the authority that owns it
(`resolve_unknown_as_owner`), the same resolution the gateway makes when the last viewer leaves a
session whose turn recovered `unknown`; the row's generation is the fence, so a card that goes stale
is refused rather than acknowledged twice. The discard never replays the lost input: it stays in the
transcript, as Hermes's own discard leaves it.

The chat draws the answer **in the composer's place**, naming the lost turn and every message behind
it, with one `Discard lost turn`. It takes the composer's place rather than sitting above it because
anything typed there would queue behind the same fence and never run — the silence this change exists
to end. A queue with nothing holding it draws nothing: its messages are already in the thread,
waiting their turn, and a card that said so would be a second account of the same fact.

The read is gated on the plugin advertising `pending`, so a host from before this change draws no
card at all — and a host whose Hermes has no admission ledger advertises nothing either, rather than
answering "nothing is waiting" about a session it never read. It is polled at the chat's idle pace:
a fence is written to the ledger with no event of its own, so no stream would ever announce it. A
read is bounded like every other on the screen, and two in a row that don't answer leave the card
standing with its control disabled and its own sentence: the queue may still be held, and handing the
composer back would admit a message behind a fence nothing will drain.

## Considered options

- **Refusing the send in the app when a host's queue is held.** The app cannot know before it asks,
  and the ask is the send: the admission is what queues. Refusing would also drop the message the
  user typed, where Hermes holds it for when the fence lifts.
- **A banner above the composer, leaving it usable.** Everything typed there is admitted and waits
  behind the fence, which is the bug: a message that looks sent and never runs. The TUI keeps its
  composer because a terminal user can run `/discard` from it; a phone has no such command.
- **Clearing the fence over the gateway's RPC (`session.resume` → `prompt.resolve_unknown`), as
  `hermes sessions discard` does.** That is a viewer attaching: it registers the session, joins a
  subscriber and is subject to a viewer's close on disconnect, none of which the app's HTTP chats
  are. The owner-side resolution is the same verb without pretending to be a viewer, on a session
  restored exactly as startup recovery restores the chat.
- **Queueing at this level instead of in the plugin (`plugin/outbox.py`).** Hermes's FIFO does run an
  API chat's queued turns after a restart (`recover_authority_api_turns`), so the outbox could in
  time retire. It is not this change: the outbox also holds each turn's run body, its model pin and
  its pause after a stop, and moving those is a separate decision with its own failure modes. This
  change reads the ledger the outbox sits beside, and neither knows of the other.
- **A state on the Code row for a session whose queue is held.** Code lists every session of every
  bot; reading each one's ledger is one select per row per poll, and the row's claim is a run's, not
  a queue's. The chat is where the queue is acted on, so it is where it is drawn.

## Consequence

A session that a restart fenced is unstuck from the phone: the lost turn is acknowledged, the FIFO
runs, and the turn it frees is followed from `runs/live` like one the plugin started. What a discard
cannot do is cancel a message waiting behind the fence: that message runs once the fence lifts, from
the app's Stop or not at all.

**An empty thread that something is filling is a state, not a failed read.** The app reads a chat that
has a past and holds no rows here as a read that failed, and says so — right for a chat synced from
another device, wrong for one whose only turn was the turn a restart lost, which never wrote its row.
The test is the host's, not a stopwatch: the queue is held there, it is running a turn there
(`running`), or this screen is following a turn a discard just freed. So
while the host says the queue is held, a read that comes back with nothing records no failure and the
thread draws neither the pane nor a spinner: the card says why it is empty, and clearing the queue is
what makes a read worth making again.
