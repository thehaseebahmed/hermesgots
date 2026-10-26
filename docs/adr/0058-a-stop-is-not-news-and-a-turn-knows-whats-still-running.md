# A stop is not news, and a turn knows what is still running

Two gaps in how a session behaves around its subagents.

**A user's stop woke the bot.** The wake sweep takes every ended delegation, and a child the user
stopped ends as `interrupted` like any other, so pressing Stop started a new turn in which the bot
reacted to the work the user had just called off. The plugin now settles the wake of a child it
stopped as `dropped` (reason `stopped`) the moment the stop takes, before the child's session closes,
so the sweep and `runs/live`'s `waking` never see it as owed. Every stop goes through one helper
(`delegation._stop_child`): a card's, the composer's session-wide one and the fan-out for a stopped
run. A child that ends any other way (a crash, the host's own interrupt) still wakes its bot, since
that is news. The stop is not told to the bot; it surfaces in the transcript the next time the user
writes.

**A turn sent while subagents work did not know it.** Nothing in the history said the work was not
in, so the turn could answer as if it were. `delegation.running_note` is a `pre_llm_call` hook that
returns a short note, naming the count and the goals, whenever the conversation has subagents core
still holds. Hermes puts a hook's context into the turn's user message and never the system prompt
(the hooks documentation), so the instructions stay identical and the prompt cache holds, and the
visible message is unchanged, so the thread shows nothing.

## Considered options

- **Waking the bot on a stop with a "stopped by the user" notice** — rejected: the user asked for the
  work to end, and a turn they did not ask for spends tokens and surprises them.
- **The note in the run's `instructions`** — rejected: instructions are fixed per session so the
  cache holds; a line that appears and disappears would break it on every change.
- **The note in the app's request** — rejected: a message queued on the plugin or sent from another
  device would go without it, and the plugin is where the fact is known.

## Consequences

- A subagent stopped by the user shows `Stopped` on its card and the session reads at rest once
  nothing else works, with no wake turn following.
- The note costs a read of `state.db` per turn, the read the app's cards already take.
- The note is context for the model only; a wake turn gets it too while other subagents still work.
