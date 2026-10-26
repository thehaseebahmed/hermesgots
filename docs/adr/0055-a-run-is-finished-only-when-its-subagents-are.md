# A run is finished only when its subagents are

Two screens read the end of a run from one signal's edge: the todos' stop mark from this device's
newest reply no longer streaming (`busy` in `routes/chat.tsx`), the host's `run_done` push from
`on_session_end` firing for the turn. A delegation that turn set to work outlives it — the ladder has
said so all along, a session whose subagents still work is working whether or not a turn is live, and
ADR 0053 keeps it as a claim on the Code list — so both were reading the run as over while it still
ran: a pause icon over a list its agent was working on, and a push telling the user the run had
finished before the subagents it left had gone.

Both now read one definition: **a run is finished when it has ended and no subagent it left at work
still runs.** The app answers it in `session-work.ts`'s `runFinished`, from `runs/live`'s run and its
`subagents` map plus what this device sees of its own reply. The host answers it in `alerts.py`'s
`_working`, from the same `subagents` map (`delegation.live_sessions`, which is what `runs/live`
reports, so both sides read one endpoint rather than each keeping its own idea of a subagent). A turn
that ends over live subagents parks its `run_done` in `alerts._held`, and `alerts.tell_finished` —
asked where a turn ends, which is a wake or the user's own next turn, and from the every-few-minutes
pass — sends it when they are gone.

## Considered options

- Let each reader decide for itself: rejected — that is the bug. The two would drift again on the
  next thing that outlives a turn, and the next screen that draws what a run still has to do.
- Take the run's end as the turn's end and drop the subagent half: rejected — it is a false answer
  while the agent works, which is exactly when a pause mark and a "finished" push do harm.
- Watch for the subagents' own last end and push there: rejected — a subagent's end is not a place
  that knows whether it was the last one. The answer is read at the moments a turn ends, and the
  pass asks again every few minutes for the case where nothing else ends a turn of that session.
- Push at the subagents' end regardless of how long the run lasted: rejected — the 60-second floor
  on `run_done` is not this bug's to move, and it now runs from the turn's start, as it did.

## Consequences

- One definition, one function per side, over one endpoint: a screen that draws a run's remaining
  work and a push that says a run is over cannot disagree again.
- The news can wait a while. The turn's own end settles it on the next turn or wake; the pass is the
  answer when a conversation is left waiting on the user with the subagents long since gone.
- Nothing is silenced by a failure: a read that fails says nothing and holds nothing back, so the
  nudge goes rather than being lost, and a host restart drops the parked news along with the turn
  clock it was judged against — early news is worse than no news here.
