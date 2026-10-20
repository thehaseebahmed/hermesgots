# An agent may send a task back to a stage it has already run

Each of a task's runs is briefed for one stage: a review run is told to review the diff and open the
draft, and it neither rebuilds the work nor expects to. The user, though, sees the review and
remembers the build was wrong, and their message arrives in a run briefed for the wrong thing. Today
that message lands in the review's run, which edits the build under a review's brief, or waits in the
queue and runs after the workflow has moved on. Neither puts the task back where its work belongs.

The agent gets a `rewind` tool: it names a stage of the snapshot that has already run, with a reason.
The tool does not move the record. It writes a pending rewind beside it and tells the agent to stop,
and when that turn ends the hook consumes it: the record goes back to that stage as a new round, and
the host posts that stage's run with its own brief, carrying the reason. A rewind therefore costs one
run and lands where the engine's own stages land — no second path into the stage machine, and every
stage's row still names the run that ran it (ADR 0023).

## Considered options

- **The record moving under the turn already going.** One run cheaper, and it retires ADR 0023: the
  record would say Build while the run in flight is the one briefed as Review, every pill and sheet
  reading it would be wrong from then on, and a turn that failed would stall "Build" over a run
  briefed as Review.
- **No tool at all: the agent does what it decides and the record stays put.** Rejected: the record
  then describes work that did not happen where it says it did, and the stage's own end — a review
  with no pull request — stalls a task somebody was actively fixing.
- **A user control, "Go back to a stage".** Rejected: the judgement is whether a message belongs to an
  earlier stage, which is the agent's reading of the user's words, not a control to find mid-run.
- **The host pinning the user's message into the new run's input.** Rejected as unreliable: a steered
  message never reaches the plugin's store, only Hermes's run, so the agent's quoted reason is the one
  path that works for a steer, a queued item and a plain send alike.

## Consequences

- Any stage that has already run, from any stage. Naming one that has not run is a jump forward, which
  the workflow's order already governs.
- Refused once the pipeline is finished: the hold has been let go and the task is in review, so
  working on it again is a new task.
- A rewind into a loop's span spends a round of the cap, like a retry — otherwise it is an unlimited
  retry the cap cannot see.
- A rewind to the stage a task is stalled in is how a stalled stage resumes, with a reason attached.
  It is the same mechanism, which is why there is no separate Resume control.
- Every stage keeps what it ran. The sheet's title says where the task is now with the rewind's reason
  beside it, so "Stage 1 of 4" over a Build row that already has a round reads as what it is.
- The user's message reaches a running stage by steer, so the agent holding the words decides on the
  spot; the host's queue stays, and a queued turn can never advance a stage.
- The AFK brief tells the agent the tool exists and that its work ends with the call. A run that
  ignores that does its work under the brief it started with — a wrong-briefed run, not a corrupt
  record.
- Nothing new is advertised to the app: the rewind arrives with the workflows feature, so a bot on an
  older plugin draws none of it.
