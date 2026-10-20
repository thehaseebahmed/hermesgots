# A stage ends only when its own run ends

An AFK session is an ordinary session: the user can stop its run, type a message, or queue one to go
after. The staged engine reads every one of those ends as the current stage's end, because
`afk.after_run` has only the session id to go on — `on_session_end` carries `session_id`, `task_id`,
`turn_id` and the outcome flags, and no run id. So a message typed into a session waiting at Build
could advance the pipeline to Review, and a workflow has more places for that to land: a turn of the
user's own between two stages is read as the next stage's end, and a review that then has no pull
request stalls a task because the user said hello.

A staged task now records the run id each stage posts, and that run's own status is what says the
stage ended and how. The hook names the session, the record names the run, and `GET /v1/runs/{id}`
answers. Any other turn on that session — the user's own, a queued item, a steer Hermes handed back —
changes nothing about the stage.

Three states fall out of that, and each used to be a guess:

- **A stop is a stall.** The run reads cancelled, the task stalls in the stage it stopped in, and it
  waits for the user with its claim and its transcript (ADR 0015). Nothing resumes a stop: a person
  chose it.
- **A stage that is due with no run is a post that never landed.** The sweep posts it. The stage's run
  is posted with an `Idempotency-Key` of session, stage and round, so the sweep's post either replays
  the run it should have had or starts the one that never happened — never a second one.
- **A run that ended with no hook to settle it is a host that died**, not a user who stopped, since a
  stop is always settled the moment it happens. The sweep resumes it once, as a new round of that
  stage. A second unsettled death stalls the task: a stage that kills its host twice is not something
  to retry in a loop.

## Considered options

- **Today's rule: whatever turn ends is the stage's end.** Cheapest, and wrong for the reason above —
  the user's own turns are the very thing an AFK session is full of when its task stalls.
- **Ask whether the recorded run is still live at hook time.** Right about a foreign turn, and blind
  after a restart, which is the case that most needs an answer: the hook is gone by then.
- **Have Hermes put the run id on the `on_session_end` payload.** Rejected: the plugin cannot change
  what Hermes sends, and the pairing would be a second thing to keep in step with the record.
- **Resume every interrupted run automatically.** Rejected: it makes a stop meaningless, and a user
  watching a task would be fighting the host they just stopped (ADR 0015's reasoning, kept).

## Consequences

- Posting a stage's run carries an `Idempotency-Key`, which also makes its terminal status durable for
  24 hours. Without a key the status lives in the host's memory, so a restart would forget what became
  of a run the record still names.
- The stage machine takes the run's outcome instead of a turn's flags, and the sweep gains a pass over
  the held tasks: a stage due with no run is posted, a run that ended unsettled is resumed once, and a
  pending rewind is consumed before a stage is posted (ADR 0024).
- ADR 0015 is superseded in part: a restart no longer adopts a session and leaves it waiting. It
  settles what it interrupted and finishes the stage.
- A settled end is written once, whether the hook or the sweep reaches it first, so the two cannot
  both advance the same stage.
- A checkpoint posts no run, so it is never a stage due with no run: the sweep applies the workflow's
  own rules rather than assuming every stage has a run.
- The record grows a settled mark per round, and a pending rewind beside it.
