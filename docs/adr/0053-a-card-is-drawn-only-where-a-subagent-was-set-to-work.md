# A card is drawn only where a subagent was set to work

A subagent's card used to be drawn for any call named `delegate_task`: `toParts` in
`app/src/components/chat/message-item.tsx` matched the tool's name alone, so `action: "list"`,
`steer` and `stop` — calls that run no agent — drew a "Sub-Agent:" card with a spinner over work
that never happened, and because `agentsOf`'s goal match bails below 8 characters ("list" is four),
a control call fell through to its ±5s window and could adopt a subagent started nearby, or sit as a
pending card of its own. The rule is now that a card is drawn only where a call set a subagent to
work — `delegate_task` spawning, by an absent `action`, `spawn`, or a `tasks` batch — and every
other call is a plain tool row. One classifier decides it, asked by the thread's part splitting, the
chat's agents-poll gate and `kindOf`, so the tool's name alone never decides again.

Nothing at render time can see the arguments: `ToolEvent` carries none, and the host's run
projection sends only the tool, its preview and its result. So the spawn proof is stamped where the
arguments are in hand — the transcript parse in `app/src/lib/history.ts`, beside the counts it
already derives for a patch's diff — while the live path matches Hermes's own control previews
(`list`, `steer <id>`, `stop <id>`), and catch-up re-derives authoritatively when the transcript
lands. Rows stored before this decision carry no stamp and classify from their stored label
instead, whose two shapes both parse, so old chats heal on the next render with no migration.
Control calls get their own words ("Listed subagents", "Steered subagent", "Stopped subagent"), and
`delegate_task`'s label is derived from arguments on both paths, which also ends the mismatch where
one call read `list` while streaming and `{"action":"list"}` after reload.

The same stamp carries `pull_request`'s and `cronjob_manage`'s actions, so a `status` read no
longer claims "Opened a pull request" and a cron `list` no longer reads as an execution: the
decision is about what a thread may claim, not only about cards.

## Considered options

- **Teaching Hermes's projection to carry `action` (or the whole arguments)** — rejected: a
  cross-repo change onto a host Gots must work with in any version, when the transcript already
  carries the arguments the app needs.
- **Classifying from the label alone** — rejected as the primary signal: labels arrive in two
  shapes (the stream's preview, the transcript's fallback) and a goal may read like a control
  preview. Kept only as the fallback for rows stored before this decision, where the label is all
  there is.
- **Keeping name-only matching and hiding just `action: list`** — rejected: it fixes the reported
  symptom while `steer` and `stop` keep drawing cards, and the next control action the tool gains
  would draw one too.

## Consequences

- The classifier fails toward a tool row, never a card: an unrecognized call may hide work that ran
  until catch-up reclassifies it, but the thread can no longer claim work that never happened.
- A `tool_call`-wrapped call isn't named by the live stream, so a wrapped spawn still draws as a row
  until the turn is rebuilt — recorded in `fixes.md`.
- `agentsOf`'s ±5s window and `PendingCard` are untouched: control calls never reach `AgentCards`
  now, so the mechanisms that mis-matched them have nothing left to match.
