# A subagent's delivery is not a message in the thread

When a subagent finishes, core writes a delivery row into the conversation (`display_kind:
async_delegation_complete`), and the app drew it as the bot's own message at the thread's end. That put
host bookkeeping in the reader's flow: it landed mid-turn, so it sat pinned beneath a reply that was
still streaming, and it was rewritten by every catch-up, so it could appear and then go. The finding
itself already has a home — the subagent's card and sub-thread, in the subagent sheet — so the thread
said it twice, in the worse place.

So the thread draws nothing for a delivery row. It starts no turn and closes no reply, as before; it is
simply not a message. What a subagent found is read in its sub-thread.

The turn the host starts afterwards (the **Wake turn**) is not hidden. When the main run has ended and
is waiting on a subagent, the wake turn *is* the main run continuing: its reply, tools, questions and
approvals draw as any turn's do. Only its prompt, the model's input, draws nothing, as already decided.

## Considered options

- **Hide the wake turn too** — rejected: it carries the work forward, and hiding it would hide real
  output and could leave a question the user must answer unseen (the case #573 fixed).
- **Keep the bubble but draw it after the running turn ends** — rejected: it still says the finding
  twice, and fixes only the ordering.

## Consequences

- This replaces the earlier glossary entry (and the thread behaviour behind it) that had a subagent's
  result arrive as the bot's message at the thread's end. ADR 0038's wake stays as it is.
- A chat that stored such messages loses them on the next catch-up.
- A wake turn's question must keep surfacing: `adoptRun` follows the wake turn by its reply, and that
  path, and its timing, must not change with this decision.
