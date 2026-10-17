# Cluster A — the todo list's progress and depths (done)

**This cluster is complete.** It is here as the worked example the other three follow, and as the record
of what the shape looks like end to end. Do not redo it; copy it.

## What moved

The app used to work out a chat's todo progress (how many are done of those that count) and each item's
indentation (how deep it sits under its parents). Both are facts about the list, so the plugin states them.

## The plugin's half

- `plugin/todos.py::depth_of` states each item's `depth` in place, capped at `MAX_DEPTH = 3`, stopping at
  a parent that isn't in the list or a loop (`seen` holds the ids walked).
- `plugin/todos.py::progress_of` states `{ done, total }`, with a cancelled item counted in neither.
- `read` returns `{ revision, todos, progress }`, each item carrying its `depth`; the route
  (`plugin/__init__.py`, `session_todos`) passes `progress` through, and answers nulls rather than a 404
  for a session it doesn't know (the app reads a 404 as a missing plugin).
- No new capability flag: the `todos` flag already gated the route, and the fields are additive.

## The app's half

- `src/lib/hermes.ts::parseTodos` reads `progress` and each item's `depth` from the payload, and **never
  computes either**. `MAX_TODO_DEPTH` (`src/lib/db.ts`) is the app's copy of the cap, used only to clamp
  what the wire sent.
- `src/lib/todos.ts` dropped the run-preview fast path entirely: `onTodoTool` now only decides a call is
  worth re-reading (by tool name) and schedules `refreshTodos` at `TODO_RETRY_MS` (1500ms, 5000ms), because
  Hermes flushes the transcript row the plugin reads only after the tool round.
- `src/components/chat/todos.tsx` renders `item.depth` for indentation and takes `progress` as a prop for
  the pill's ring and `done/total` text; its own `progress()` and `depths()` walks are gone.
- Storage: `Todo.depth`, `Conversation.todos.progress`, `TodoProgress` in `src/lib/db.ts`, Dexie **v15**
  with an upgrade that **deletes** a stored `todos` (a list stored without the facts must not paint a
  count it cannot know — the next read brings it back complete).
- An older plugin (before 0.48) sends neither field: the pill reads "todos" with no ring and the sheet
  header "Todos". No fallback, by the ADR's rule.

## What the other clusters copy from it

- The trigger: the app does not read the stream's result preview, it re-reads the plugin's route a beat
  later. Same pattern for cluster D's verdicts.
- The upgrade: drop the stale derived value rather than half-fill it.
- The mock mirror: `depthOf` / `progressOf` in `app/scripts/mock-hermes.mjs` duplicate the plugin's rules,
  because the mock *is* the plugin for the flows (`pnpm e2e todos`, `todos-legacy`).
- The docs sweep: `AGENTS.md`'s todo paragraph and layout row, `plugin/README.md`'s route line, and
  `docs/adr/0005-calculations-belong-on-the-plugin.md` all describe the new behaviour in the same commit.

## Tests it left behind

- `plugin/tests/test_todos.py`: depth under a parent, an orphan parent, a loop, the cap, a cancelled item,
  the newest list winning, a bare tool row being refused, another tool's call not answering for ours.
- Flows: `pnpm e2e todos` and `pnpm e2e todos-legacy` assert the pill reads `N/M todos`. They were **not**
  run when this landed (no browser in that environment) — run them if this path is touched again.
