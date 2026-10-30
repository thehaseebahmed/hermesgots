# Away is said in the chat's header, and a message the host refused stays in the thread

Status: grilled 2026-10-30, every decision settled and recorded in
[ADR 0071](adr/0071-away-is-the-headers-word-and-a-refused-message-stays-in-the-thread.md), which amends
ADR 0066 on one point, with the glossary's **Away** entry written alongside and **Catching up** amended.
Published as #701 with tickets #702 to #705; the build order at the end is the tickets' shape when
implementation starts. #701 is blocked by the gate issue (#707) that the docs pull request carrying this
file (#706) closes — work starts on that merge. The spec carries `ready-for-agent` and the tickets stay
bare, so the agent claims the spec and works the graph in order.

## Problem Statement

A chat whose host cannot be reached takes its composer away and says so in the wrong place.

The composer is the whole lower edge of a chat: the field, the model pill, the `+` menu, dictation. When
a read gets no answer, the new chat screen stops drawing it, so a chat with a host that is down cannot be
typed in at all — a thought the user had while the train went into a tunnel is lost, and the files they
had already picked with it. The user is left looking at a thread with a hole where the field was and no
way to say anything until the host comes back.

What replaces it is a sentence — "Can't reach this host right now." — drawn as the first child of the
thread's own scroller. The scroller pins to the newest row, so on any thread longer than a screen the
sentence sits above the viewport: the reader it is for is looking at the bottom of the thread and never
sees it. It is also in the one place a chat's notices should not be, because it scrolls away with the
messages while describing something about the chat itself.

A message sent when the host cannot answer fails the same way twice over. It is drawn as a banner at the
top of the same scroller, and the row the user just sent is dropped from the thread, so their words leave
the conversation and come back in the field they typed them in. The current screen already answers this
better: a message whose send fails stays in the thread, dimmed, marked "Not sent", with Retry and Cancel
beside it, and it outlives a reload. The new screen does not do that yet.

## Solution

Away is the chat header's word. While the host cannot be reached, the header's subtitle line says so in
place of what it usually says — the bot's thread count on a Main, the repos and bot on a project session
— and that line comes back the moment the host answers. It has two wordings: "You're offline" where this
device has no network at all, and "This host isn't answering" where it does. Nothing about it is drawn in
the thread.

The composer stays. It is drawn, typeable and it sends, whether or not the host is answering. A send made
while the host is away is tried with a few seconds' timeout rather than the long one reads use, so a dead
host costs a breath instead of fifteen seconds.

A message that does not reach the host stays in the thread, at the end of the flow where the user left
it, in the app's own not-sent look: the dimmed bubble a queued message wears, the "Not sent" mark beside
it, Retry and Cancel under it, and its files kept to go again with. Retrying is the only way it goes
again — nothing sends it by itself — and it leaves the thread when the host takes it. It is kept on this
device only: it is never written to the host's transcript and never synced anywhere.

The chat still reads on its own timer, because that read is what draws another device's turn, a run that
finished and the catch-up. A read that lands is what clears the header, so away clears itself. A read that
fails with an answer — the host is there and something on it is wrong — is a toast, as every other failed
read in the app is, and draws nothing in the thread.

## User Stories

1. As someone typing when their host stops answering, I want the composer to still be there, so that I can finish my thought and send it rather than losing it.
2. As someone whose host is down, I want to be told so in the chat's header, so that I see it while I read the newest message rather than only if I scroll to the top of the thread.
3. As someone scrolled up in a long thread, I want the away words not to move with the messages, so that a notice about the chat itself doesn't scroll out of the chat.
4. As someone on a phone with no signal at all, I want the header to say "You're offline", so that I know the problem is my end and not the bot.
5. As someone whose network is fine but whose host is down, I want the header to say "This host isn't answering", so that I know waiting on my own connection won't help.
6. As someone who has fixed the host, I want the header to go back to what it says about this chat on its own, so that I don't have to dismiss anything.
7. As someone sending a message the host never receives, I want it to stay in the thread where I sent it, so that my words and my files are still in the conversation I am reading.
8. As someone reading back through a chat, I want a message that didn't go marked as not sent, so that I can tell it apart from one that did.
9. As someone whose send failed, I want Retry on that message, so that one tap sends it again without retyping.
10. As someone who changed their mind, I want to cancel a message that didn't go, so that it is taken out of the thread and out of my way.
11. As someone whose send fails with a photo attached, I want the photo kept with the message, so that Retry sends what I picked rather than the words alone.
12. As someone who closes the app after a failed send, I want the message to still be there when I come back, so that a tunnel or a dead battery doesn't lose what I wrote.
13. As someone waiting for a message that didn't go, I want nothing to send it behind my back, so that a host coming back never puts words in my mouth that I have since taken back.
14. As someone whose host is away, I want tapping Send to answer me in a breath, so that I am not left watching a dead field for fifteen seconds.
15. As someone whose host answers with an error rather than with nothing, I want that said once, as a toast, so that the thread is not wearing a notice about the host above its messages.
16. As someone reading a thread another device is writing in, I want the chat to keep updating while my own host is away, so that coming back shows me what happened rather than a frozen screen.
17. As someone with two chat screens in the app, I want a failed message to look and act the same in both, so that which screen I am on doesn't change what my message means.
18. As someone who never sees an away host, I want none of this in my way — no new chrome, no new control — so that the chat looks exactly as it did.

## Implementation Decisions

**One away state, two sentences.** The app cannot tell a dead host from a dead device: both arrive as a
fetch that failed or timed out. `navigator.onLine` is the only fact that separates them, so one pure rule
takes the state and the device's answer and returns the sentence — a module with no imports, tested
without a DOM, read by whatever draws the words. The state itself keeps the meaning it has: away is a
read that got no answer, and the next read that is answered clears it.

**The composer slot has one precedence.** Away no longer empties the slot. The prompt a run is waiting on
still wins it (an approval or a question is what the user must answer), and the composer is drawn
otherwise, whatever the host is doing. Its draft, its attachments and its menus behave exactly as they
do with the host up.

**A send while away is tried with a short timeout.** The reads keep their long timeout; a send made while
the state is away uses a short one, a few seconds, so a dead host answers the user in a breath and a host
that has come back still works. The timeout is a named constant beside the away state, not a second
setting.

**The header's subtitle is the away words' place, and only while away.** The subtitle comes back the
moment the state clears. Away still suppresses the first read's "catching up" line, as it does now: two
lines about the same wait would say it twice.

**No away notice in the thread, in either view.** The app view and the plain dev view both stop drawing
the away line, so a test reading the plain markup and a reader in the app see the same absence.

**A read that failed with an answer is a toast.** The thread draws no banner for it. It is a transient
fact about a read the next poll retries, and the app already reports failed reads with a toast
everywhere else, so this is the app's own vocabulary rather than a new one.

**A refused message is the app's failed message, not a new kind of row.** It is kept in the device's own
message store in the shape the current screen already writes — a user message with the error status and
the status text "Not sent" — and drawn with the app's existing not-sent look: the dimmed bubble a queued
message wears, the mark beside it, Retry and Cancel failed message. Its attachments stay with it. The
reason a host gives for a refusal belongs to the chat's own error and is never repeated under the bubble.
One shape means the two chat screens draw a refused send alike, and no second vocabulary of "queued",
"pending" or "outbox" enters the app.

**It is drawn last in the flow, where the user left it.** After the last turn, before the composer,
in the order the messages were sent — the place a message the user sent moments ago belongs. A thread
with several of them draws them in that order, each with its own actions.

**Retry is the only sender, and the row leaves on acceptance.** A retry posts the turn as any send does,
with the row's text and its files; the row leaves the thread as soon as the host accepts it, because from
then on the turn itself draws the message. A retry that fails again leaves the row exactly where it was.
Nothing re-sends on a timer, when the host comes back, or when the chat is reopened.

**It is this device's alone.** It is never written to the host's transcript, never merged into the thread
the host answers with, and never synced: the sync carries the chat record and its draft text, and a
failed message is neither. Reopening the chat draws it from the device, and it is gone for good once it
is sent or cancelled.

**Nothing else changes pace.** The periodic read keeps its intervals while away; there is no manual
connection retry, because a read that lands is what clears the state and the timer already reads.

## Testing Decisions

- **What a good test asserts here** is what a reader sees and does: which words the header says, whether
  the composer is there and takes typing, whether a message stays in the thread marked not sent, what its
  two controls do, and what survives a reload. Not the constants, not the component tree.
- **The one new seam is a browser flow, and it is the highest one available.** `pnpm e2e away` drives the
  new screen against the mock with the plugin's routes blocked, which is how the current screen's failed
  send is already proved. Two wordings are both reachable from it: aborting the host's routes leaves the
  device online ("This host isn't answering"), and taking the browser context offline turns
  `navigator.onLine` false ("You're offline"). The flow asserts the composer is drawn and typeable, the
  header's words, that the thread carries no away notice, that a send becomes a not-sent row within a few
  seconds, that Retry sends once the routes are restored, that a reload keeps the row, and that the row is
  gone when the turn lands. Prior art: the current screen's failed-send flow, and the flow that drives
  the new screen behind its two switches.
- **The component tier carries what the flow cannot say.** A not-sent row folded from the device's store
  is drawn after the last turn and not inside one; it is gone once it is sent; several of them keep their
  order; a thread that never had one is unchanged. Prior art: the new screen's component tests over a
  seeded device, which already mount the thread with its own database.
- **The unit tier carries the two sentences**: the rule that answers which wording the header wears, and
  the short timeout's choice, both with no DOM. Prior art: the small import-free modules the app already
  tests this way.
- **Both chat screens are asserted where the row is.** The current screen's failed-send flow already
  pins the look and the two controls; this change must not alter it, so that flow stands as the check
  that one shape serves both.
- **No new sweep**: the failed row's height and inset are the ones the current screen already draws and
  the browser audit already measures, so the sweep has nothing new on this screen.

## Out of Scope

- The current chat screen's way of saying a host is away. It never hid its composer and it reports a
  failed read with a toast already, so there is nothing there to move.
- Holding a message on the device to send when the host answers. A retry is the user's tap, and the
  plugin's queue already owns "hold this until it can run".
- The plugin's queue, its steer, and anything the host does with a message once it arrives.
- Retrying a read by hand, and any change to the periodic read's intervals.
- What a bot's row on the bots screen says about being online, which is the registry's check-in and a
  different question from this chat's host answering.
- Any change to the failed reply a turn can draw (`failed_turn`), which is the host's own failure and not
  a send that never arrived.

## Further Notes

- ADR: [0071](adr/0071-away-is-the-headers-word-and-a-refused-message-stays-in-the-thread.md), which
  amends ADR 0066's "an away host keeps its banner".
- Glossary: **Away** is new and names the state with its two wordings; **Catching up** is amended to say
  the chat's header rather than a banner.
- The current screen's failed-send behaviour is the shape this adopts, so it is worth reading before
  building rather than inventing a second one.
- The agent guide's line describing the new screen says the composer is withheld when the host is away,
  which is wrong the moment the first ticket lands; it is corrected in that ticket.
- The parity document gains the failed message as a row the new screen closes.

## Tickets

- [ ] #702 — the composer stays while the host is away, and a send made then answers in a breath
- [ ] #703 — away is the chat header's word, and the thread carries no notice of it
- [ ] #704 — a message the host refused stays in the thread, marked not sent, with Retry and Cancel
- [ ] #705 — a message that didn't go outlives a reopen, and is gone once the host takes it

## Build order

#702 and #703 start immediately and can land in either order: one keeps the composer and shortens the wait a send makes while the host is away, the other moves the away words to the header and takes the thread's notices out of it. #704 waits on both, because the row it draws is what a refused send leaves behind and where a failure is said is the second's. #705 waits on #704: it is the same row, kept across a reopen.
