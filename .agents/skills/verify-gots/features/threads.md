# Bot threads

A bot's chat is its own Main: the messages the bot and the user wrote there, with every bot thread
drawn as a card inside that flow at the time the thread began. A card opens the thread, its opener
sends text into it, and a message the host moved into another thread carries a line naming where it
went, with the host's own undo.

## Sub-features

- `threads-main` — a bot opens on Main, its header naming the bot with Main and the thread count
  under it (`bot-threads`).
- `threads-cards` — each bot thread is a card at the time it began, between Main's own messages,
  under the day heading it falls in (`bot-threads`).
- `threads-card-open` — a card's "View thread" opens that thread and back returns to Main where it
  was; the card's opener text sends into the thread and lands there (`bot-threads`).
- `threads-start-command` — the composer offers `/thread`, and `/new` where the switch is off,
  never both names (`bot-threads`).
- `threads-move-new` — a message that opened a new thread leaves Main as that thread's card, with
  Undo and no marker (`bot-threads` on `triage-new`).
- `threads-move-older` — a message moved into an older thread keeps a `Moved to` line linking it,
  with no card carrying the move (`bot-threads` on `triage-thread`).
- `threads-widths` — the cards, the day heading and the moved line still draw at tablet width in
  dark mode (`bot-threads`).

## How to get to it (user POV)

- Open a bot from the sidebar's chat list: its chat is Main, the threads drawn as cards inside it.
- A bot's old thread list address, `/b/<botId>`, lands on that same Main (and on home where the
  switch is off).
- A card's "View thread" link, or the card's opener text itself.
- The composer's `/thread`, or `/new` where the bot threads switch is off.
- A moved message's `Moved to` link, and the Undo under it.

## Driving it with the e2e flows

Preconditions:

- Baseline state (features/README.md): app and mocks up, `doctor.sh` exit 0, and the build being
  driven is this worktree's (doctor prints its git head).
- No other run is driving this instance. `$GOTS_VERIFY_ARTIFACTS` names where proof goes.
- The bot threads switch is on. With it off this whole feature is the old build's behaviour.

- **Main opens.** From home, open the bot. Run
  `pnpm e2e bot-threads --shots "$GOTS_VERIFY_ARTIFACTS/<run-id>"` (from `app/`). The drive lands on
  `/c/<id>`, the header reads `Main` with `1 thread` or `N threads` under it (`No threads` at
  zero), and the bot's own messages are still in the thread. The proof is
  `PASS: the bot opens its Main thread` and `bot-threads-main-cards.png`.
- **Cards at their start times.** The same drive: each thread is a card whose body is its opener,
  sitting where that message was written, under a centred day heading (`Today`, `Yesterday`, else
  the date), each link reading `View thread` with `· N replies` where the thread has replies. Main's
  own replies stay between the cards. Proof: `PASS: Main draws its bot's threads as cards at their
  start times`.
- **Opening a card and coming back.** Click a card's "View thread", then go back. The thread's own
  route opens and back returns to Main with the list where it was. Proof: `PASS: tapping a card
  opens its thread, and back returns to Main`.
- **Sending from a card.** Tap a card's opener text instead of its link. That text is sent into the
  thread and the thread opens holding it; back on Main the thread's card now sits at that message's
  time, drawn with no marker. Proof: `PASS: back on Main, the started thread's card sits at its
  start time`.
- **`/thread` with text.** Type `/thread <text>` into the composer and press Enter. A thread opens
  holding that message. Proof: `PASS: /thread with text opened a thread with that message`.
- **A message that opens a thread.** Send on a host answering `MOCK_TRIAGE=new` (the CLI starts
  that mock for this flow). The message leaves Main as its new thread's card, carrying an `Undo`
  control and no marker. Proof: `PASS: triage's new thread draws a card with Undo and no marker` and
  `bot-threads-triage-new.png`.
- **A message moved into an older thread.** Send on a host answering `MOCK_TRIAGE=thread`. The
  message keeps a `Moved to "<thread>"` line linking the thread it went to, with `Undo` directly
  under it, and no card carries the move. Proof: `PASS: a message moved into an older thread keeps
  its Moved marker with its link` and `bot-threads-triage-thread.png`.
- **Widths and theme.** The flow's closing pass resizes to 768px and switches to the dark theme: a
  card, Main's day heading and the moved line still draw, and the move's Undo is still there.
  Proof: `PASS: on a tablet in dark mode Main still draws its cards, its heading and the move's
  line` and `bot-threads-tablet-dark.png`.
- **Proof of a whole pass.** Keep the run's `PASS:` transcript and the `bot-threads-*.png` shots in
  `$GOTS_VERIFY_ARTIFACTS/<run-id>`; they name the feature id and the entry point (the bot's chat).

## Gotchas

- This flow needs two mocks of its own (`MOCK_TRIAGE=new` and `MOCK_TRIAGE=thread`), which the CLI
  starts for it. Drive it as `pnpm e2e bot-threads`; a drive pointed at the `live` mock alone can
  never reach the two move cases.
- The switch off is the old build's behaviour: no cards, `/new` in place of `/thread`, and
  `/b/<botId>` still a thread list. Say which state you are in before asserting a card.
- A bot whose Hermes predates the wire has no moves at all, so no cards and no markers — the
  thread list address still lands somewhere sensible, and that is the degradation, not a bug.
- A card is drawn where its message was written, so Main's own replies and day headings stay in the
  flow between the cards. A check that only counts what is on screen will double-count a thread.
- A marker's Undo is offered only while the thread it moved into has not replied. Once it replies
  the control is gone; do not wait for it later in a drive.
- The sidebar's bot row previews what Main last said. Where Main has said nothing that preview
  reads `No threads yet`, which describes the preview alone — the header's own subtitle at zero
  threads is `No threads`. Assert the one you mean.
