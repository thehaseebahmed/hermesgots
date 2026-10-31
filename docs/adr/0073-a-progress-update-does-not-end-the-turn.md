# A progress update does not end the turn

A bot asked to say what it was doing sometimes stopped there, the issue half done. The reminder blocks a
tool call with a note that opens "Reply with a short update now", the model answers in words, and a reply
carrying text and no tool call is Hermes's final answer: the turn ends, the run is over, and the work
waits for a user who was told it was in hand. The note ended with "Then make this tool call again", but
that was one clause after the ask it competes with, and it named nothing about the turn ending.

Hermes has a stall guard for exactly this shape — a turn that ends on an announced next action is
re-prompted, up to twice — and it is not a net. It fires only on a reply of at most 400 characters whose
last 160 end on `let me now`, `I'll now`, `I will now`, `now I'll` or `next, I`, with the comma. The
shapes a progress update actually takes read as finished answers and end the run: "Checkpoint 1 is in:
the parser fix lands with a test. Next up: the router tests.", "Progress: 3 of 5 checkpoints done. Next
I'll wire the route and run the gates.", "Landed the parser fix, tests green. Moving on to the router
now." All three pass the guard untouched.

**Both surfaces say it, because the stop is made by the ask and by the shape of the reply.** The note
carries the negation inside the sentence that asks for the update — "…make this tool call again: this is
not your last turn unless the work ends here" — and the shared Do rules carry the standing rule for
every project session's run, so a bot that narrates without a reminder, and one at Off, is told it too.
The qualifier is not decoration: a plan-mode run is told by its own section to make the plan its whole
reply and stop, and a staged build is told to end the run once its gate is called, so both surfaces say
what an update is not only where work remains. A plain chat sends no plugin prompt at all (ADR 0028), so
"every run" here means the project sessions and their AFK and staged runs, which is where the work is.
The rule costs one line on every turn of every bot, and the alternative, leaving it to the note, leaves
the bot that never gets a note without it.

**The cadence is the app's, so the rule says what to write, not when to abstain.** Every run the app
starts already carries `PLAN_HINT` — "keep exactly one item in progress, and update the list as each step
is done" (`app/src/lib/hermes.ts`) — and ADR 0068's "where the plan has moved" was permission to leave
the list alone, not a standing ban on writing it. A Do rule reading "only write when the plan has moved"
would contradict the hint beside it and leave items in_progress for a whole run, so the rule asks for a
mark as each item lands and a plan rewritten only where it has moved, and the note keeps the softer
conditional: "if your todo list has fallen behind".

**The todo list is asked for by name.** ADR 0068 worded the note as "keep the todo list current" and
named no tool, because the todo tool answers to two spellings (`todo_list` and the older `todo`). On a
Gots host that reason is mostly spent: `todos.equip` puts `todo_list` on every agent the adapter builds,
and `todos.wire` reports whether it could in the boolean the plugin advertises. The host it cannot
reach — one with no `_create_agent` seam — has no list tool to name, so the note and the rule cost it
nothing it hadn't already lost, which is why the name is said anyway. A model told to bring its list up
to date without being told which tool writes it goes looking, and the list is the one thing the user
reads mid-run.

**This is words, not a guard.** Gots is a plugin: it cannot make Hermes re-prompt a turn, and the hooks
that see a turn end run after the answer has been delivered. The only enforcement available is a second
run posted on the user's chat by `on_session_end`, rejected below. The risk is stated plainly: a model
that reads the note, answers it and stops anyway still ends the run, and nothing catches it. What this
change buys is that the sentence standing in the way is the note's own, and that the rule stands in
front of every project session rather than only the runs a reminder reached.

**What holds it.** The words are pinned by `plugin/tests/test_progress.py` (the note names the tool,
carries the negation before the list clause, and keeps its pinned opening) and by
`plugin/tests/test_library.py` (the two Do rules, said on the block itself). The note the app's own
tests read is a copy, so `test_progress.py` holds `app/scripts/progress-reminder-fixture.ts` to
`progress.REMINDER` word for word — the guard the mock's prompt copy already had, for the copy that had
drifted. `docs/prompts.md` shows the prompt as it is now built.

## Considered options

- **Change only the note** — the ask that causes the stop is the note's, and the prompt's line costs
  tokens on every turn. Rejected: a bot narrating without a reminder is the same failure with no note in
  sight, and the bot's own level can be Off.
- **Change only the prompt** — rejected for the same reason read the other way: the note asks for the
  reply that ends the turn, so the ask itself has to say what it is not.
- **Have the note end its own ask on a guard tail** ("…next I'll wire the route") so Hermes re-prompts —
  cheap, and it works on any host. Rejected: it games a heuristic that a Hermes release may retune, and
  a bot whose reply happens to be longer than 400 characters would still end the run.
- **Detect the stop and start a continuation run** — `on_session_end` sees the run end, reads the
  session's todo list, and posts a run that carries on where the last one stopped. Rejected: a second
  run on the user's chat for every update that read as finished, including the ones where the work was
  done, and the detection rule is a guess standing in for a fact.
- **Name the tool only in the note** — keep ADR 0068's "naming no tool" in the prompt. Rejected: the
  prompt's rule is the one every session reads, and a rule whose tool has no name is a rule half told.
- **Keep the ban in the prompt and leave `PLAN_HINT` alone** — rejected under *The cadence is the app's*:
  two instructions in one system message asking for opposite things is the drift this change exists to
  prevent.
