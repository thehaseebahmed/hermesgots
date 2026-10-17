# Cluster D — tool results

The widest of the three and independent of B and C. Do it last: it adds a route, a shape on every stored
tool row and a new trigger on the live path.

## Goal

What a tool call returned, whether it failed, and how many lines a patch moved are facts about the
transcript, so the plugin reads them out. The app stops interpreting tool results entirely — it renders
the verdicts it is handed and keeps only its wording.

## What the code does today

`src/lib/tools.ts` interprets results in two places' service:

- `Reader` (`:110`) and `readEnvelope` (`:227`) parse a tool's JSON result **even when it is cut short** —
  the run stream's preview stops at 500 characters and long transcript rows are clipped.
- `failureReason` (`:249`) mirrors Hermes's own `_detect_tool_failure`: a `user_summary` field, else
  `error`/`message`, plus a `terminal` call's non-zero `exit_code`. `exitCode` (`:268`) reads the exit code
  alone.
- `taskCount` (`:63`) reads a count from a todo call's label ("planning 3 task(s)" / "3 tasks").
- `kindOf` (`:68`) uses a patch's `created` flag, and `phrases` / `activityOf` / `todoTarget` turn all of it
  into words ("Ran a command", "3 tasks").

`src/lib/history.ts::patchStats` (`:133`) counts a patch's added and removed lines from its diff and reads
`files_created`. It runs while a run streams (`src/lib/chat.ts:315`, on a patch's preview result) and when
a transcript row is imported (`src/lib/history.ts:305`), and `failureReason` is called on imported rows at
`src/lib/history.ts:307`. Results land on `ToolEvent` (`src/lib/db.ts:237`: `result`, `error`, `added`,
`removed`, `created`), which lives on `Message.tools` (`:355`).

The plugin reads transcripts the same way `plugin/todos.py` does (`read`, `:81`), including the pairing
that refuses a bare tool row: `_answers_todo_call` (`:47`) only counts a `role: tool` row when the nearest
earlier assistant message made that call id (via Hermes's `tools.todo_tool.is_todo_tool_call`).

## The contract

- **New module `plugin/tool_results.py`.** Walks a session's transcript (and its ancestors, as `todos.read`
  does) and answers, per tool call id:
  `{ "tool": "terminal", "outcome": "ok" | "failed", "reason": "…" | null, "exit_code": 3 | null,
  "added": 12, "removed": 4, "created": true, "task_count": 3 }` — fields absent where they don't apply.
  Port the semantics, not the code: the same truncation-tolerant read is not needed here, because the
  plugin holds the whole transcript row.
- **Route `GET sessions/{id}/tool_results`** answering `{ object, session_id, tools: { "<tool_call_id>": {…} } }`.
  A session with nothing to say answers an empty map, never a 404 (the app reads a 404 as a missing
  plugin). Feature flag `tool_results` in `info`'s `features`.
- **Bounded.** A long session has hundreds of tool rows and this read walks the whole transcript, so cap it
  (the newest N, the way `todos.MAX_ITEMS` caps its list) and say what the cap is in the docstring. Only
  verdicts for rows the app holds matter, and those are the newest.
- **Pairing.** Refuse a bare tool row, exactly as `_answers_todo_call` does, and answer for a delegated
  child session's rows too — the app renders delegated transcripts (`src/components/chat/agent-card.tsx`).
- **`task_count` comes from the result, not a label.** The label regex the app uses is a preview artifact;
  the plugin has the todo result itself (cluster A's reader already finds it), so count from `todos`.
- **Display text stays for now.** `ToolEvent.result` (the preview the stream delivered) is what the row
  shows; this cluster moves the verdict, not the body.

## Steps

1. `plugin/tool_results.py` + tests: the ported failure semantics (`user_summary`, `error` vs `message`, a
   `terminal` non-zero exit, a call that looks fine), the patch line counts and `files_created`, a
   `write_file`'s created flag, `task_count`, a bare tool row refused, another call's id not answering for
   ours, and the cap.
2. The route + the `tool_results` flag.
3. App wire: `getSessionToolResults(config, sessionId)` in `src/lib/hermes.ts` (beside
   `getSessionTodos`, `:1381`) with the same tolerant parsing.
4. App: `ToolEvent` gains `exitCode`; `error`, `added`, `removed` and `created` are now filled **only**
   from the plugin. Delete `Reader`, `readEnvelope`, `failureReason`, `exitCode` and `taskCount` from
   `src/lib/tools.ts`; `kindOf` reads the `created` field the plugin sent, and `todoTarget` reads
   `task_count`. `history.ts` stops calling `patchStats`/`failureReason` at `:305` and `:307`; `chat.ts`
   stops calling `patchStats` at `:315`.
5. App: a `refreshToolResults(conversationId)` beside `refreshTodos` (`src/lib/todos.ts` is the model:
   a cooldown keyed by server for an older plugin, `lacksRoute(server, error, "tool_results")`). Trigger it
   the way the todo read is triggered — a completed call schedules a retry (the `TODO_RETRY_MS` pattern),
   plus the existing turn-end and `noteFollowUps` follow-ups (`src/lib/chat.ts:664-666`,
   `src/lib/history.ts:509-511`) — then write each verdict onto the row by `toolCallId`.
6. App storage: Dexie bump with an upgrade that **drops** the derived fields (`error`, `added`, `removed`,
   `created`) from stored tool rows, so nothing paints a badge the plugin didn't author. `result` stays.
7. Mock: `app/scripts/mock-hermes.mjs` computes verdicts from the rows it already records (`record(req, …)`
   at `:537`; its tool calls are written with their results), and its `features` list gains the flag.
8. Docs: `AGENTS.md`'s `src/lib/tools.ts` layout row and any sentence about reading a result (check the
   `tool-group.tsx` paragraph about `+N −N` badges), `plugin/README.md`, and delete this cluster's entry
   from `fixes.md`.

## Pitfalls

- **The badge appears a beat later.** A patch's `+N −N` while a run streams comes from the preview today;
  after this it waits for the plugin's read (the change stream carries no content — see the ADR). Accepted;
  do not reintroduce an app-side count to hide the gap.
- **A verdict is per call id, and ids arrive from two sources.** The offline transcript import matches rows
  to this device's tool rows by its own rules (`history.ts`); make sure a verdict written by id lands on the
  row the app shows, or the same call reads failed in one place and fine in another.
- **`clarify` is not this.** A question's result is the user's own answer, written when it is answered
  (`src/lib/chat.ts:310-313`); leave that path alone.
- **Cost of the read.** A transcript walk per refresh is the heaviest read the plugin does; keep it bounded,
  keep it off the send path, and let a failure be `noteFailure`-quiet rather than a visible error.
- **Performance regression guard.** `pnpm e2e stream-writes` and `pnpm e2e idle-requests` exist to catch
  exactly this kind of added read; run them and report the numbers in the pull request (the repo's
  convention for a change that adds work to a screen).
- Deleting the app's interpreter is the point: if any of `failureReason`, `exitCode`, `taskCount` or
  `patchStats` survives "as a helper", the cluster has not landed.

## Definition of done

- A failed tool call, a non-zero exit and a patch's line counts all come from the plugin, and no code path
  in `app/` reads a tool result's JSON.
- An older plugin (no `tool_results` flag) shows tool rows with no verdict and no badges, and nothing
  recovers the old behaviour.
- Plugin tests cover the ported semantics and the pairing; `pnpm lint`, `pnpm typecheck`, `pnpm build` and
  the chat/session flows pass; the mock mirrors the contract.
