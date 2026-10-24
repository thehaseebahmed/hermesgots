# The chat pane holds the previous chat until the next one is ready

Switching bots or threads rebuilt the chat from nothing. The chat page reads its state through
several live queries — settings, the conversation, its profile, the messages, and Main's thread
list — each resolving on its own tick, and the render treated "not answered yet" as real states.
Every switch therefore painted the not-configured empty state with a "New chat" title, then the
new-chat hero with its greeting line, then the messages: three or four wrong frames over about
250 ms, with Main's cards and a scroll jump landing after them and the shell's page transition
fading the whole sequence in as one flash. The wrong states were not only visual. Mounting the
ready line burned a line turn and could swallow the hour's greeting, and the first content frame
was not the final scroll position.

The chat is now **ready** only when settings, the conversation, the profile and the messages have
all answered for the id being shown — and, on a Main thread with bot threads on, Main's thread list
too. Readiness is composed over the live queries that already exist, whose stale-answer guards stay
as they are: an answer naming another id never renders. Each contributor answers three states —
unknown, answered-empty, answered — so an unknown profile is never read as "not configured" and an
unanswered thread list is never read as "no threads". Until the chat is ready, the pane **holds**
the previous chat's last ready frame — both panes at 1280px and up, while the sidebar selection
moves at once — and the new chat's header and body land in one commit. During the hold everything
is inert: the composer is hidden or disabled and taps do nothing, so nothing can act on the wrong
chat. The held frame is the last ready one and does not stream forward, since the queries already
answer for the new id. Once a chat is ready for an id, transient query gaps never push it back
into the hold.

Where there is nothing to hold — a cold start or a deep link — the body shows a spinner under the
kept header until the first ready frame. A conversation that answers "definitely gone" is an
answer, not a gap: it counts as ready and renders the honest empty state for it. A chat whose
transcript still has to be fetched from Hermes is ready when the device's own queries answer; the
fetch keeps the spinner it already shows, so a network wait never holds the pane.

The ready line mounts only on a genuinely unstarted, ready chat, so a switch can no longer consume
a line turn or the hour's greeting. Main's cards are in before the swap, so the first content frame
is the final scroll position and the scroller moves once. The shell's page transition keeps its
200 ms fade but no longer plays it at navigation time — that moment shows the held content, and
fading it in again is the flash the hold exists to remove. The fade plays when ready content
replaces the held content.

## Considered options

- One live query returning the chat's state atomically, so partial states are impossible by
  construction: not taken. Readiness is composed over the separate queries instead, keeping their
  ranges and their stale-answer guards exactly as they are.
- A neutral blank pane, or a spinner, during every switch: rejected. The hold shows the reader
  what they were reading until what they asked for can replace it; the spinner is kept only for
  the cold start, where nothing has been read yet.
- A new end-to-end flow with a registry key of its own for the frame probe: rejected. The frame
  and scroll assertions fold into the bot-threads flow as new steps, keeping the stay count the
  audit argues for. A browser is needed at all only because the scroll jump is geometry
  ([ADR 0019](./0019-a-test-belongs-to-the-cheapest-tier-that-would-fail-for-its-reason.md)).
- Holding until the transcript fetch lands: rejected. A fetch can take seconds, and an honest
  spinner after the swap beats freezing the previous chat behind a network wait.

## Consequences

- The invariant the tests assert is strict: every frame during a switch is either the previous
  chat's ready frame or the new chat's ready frame, nothing in between. A component test drives
  the sequence over a seeded database and asserts the greeting and line-turn keys are untouched;
  the bot-threads flow samples frames in a real browser and fails on a wrong-state frame or a
  scroll position that moves after the first content frame.
- The sidebar selection moving while the panes hold is deliberate: selection is feedback, the pane
  is content. The hold covers bot switches and thread switches alike, in the two-pane layout and
  on the routed chat alike.
- The composer being inert during the hold is the price of the hold. It is never live to the
  outgoing chat, and never live to a chat whose id the send path would have to guess.
