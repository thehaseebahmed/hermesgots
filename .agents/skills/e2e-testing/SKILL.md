---
name: e2e-testing
description: Use when verifying a Memento app change end to end in a real browser against the mock Hermes, or when adding a browser test for it.
category: testing
---

# End-to-end testing Memento

Memento's browser tests are plain Node scripts in `app/scripts/` that drive the real app (Vite) in
headless Chromium with Playwright, against the mock Hermes (`scripts/mock-hermes.mjs`). They don't
run in CI, so run them yourself before calling a change to chats, sessions, polling or sync done.
`pnpm lint`, `pnpm typecheck` and `pnpm build` still have to pass as well; these tests don't replace them.

## Run them

```bash
.agents/skills/e2e-testing/run.sh              # every test
.agents/skills/e2e-testing/run.sh e2e-live     # only the scripts whose name contains this
SHOTS_DIR=/some/dir .agents/skills/e2e-testing/run.sh   # keep the screenshots somewhere you choose
```

The runner frees ports 15173, 18642 and 18643. It then starts Vite on 15173 and the mock on 18642
with its change stream. A second mock runs on 18643 with `MOCK_NO_EVENTS=1`, so the app has to poll
the way it does on an older plugin. The runner runs each `regression-*.mjs` and `e2e-*.mjs` script,
and runs the `e2e-live*` ones against both mocks. It stops every server when it exits and prints
`FAILED: <script>` for each script that failed. Read the failing script's output above that line,
then open the `failed.png` screenshot in the screenshots folder.

The runner looks for Playwright in `app/node_modules`, then globally (`npm root -g`). If it's
somewhere else, set `PLAYWRIGHT_MODULE` to its `index.mjs`; a CommonJS `index.js` loads without
`chromium`. Never run `playwright install`. Cloud containers already have Chromium.

## What's covered

| Script | Checks |
|---|---|
| `e2e-live-sessions` | runs/live is read by one shared poll, no more than 3 times in 25s while polling (main read it 4 times). A project session waiting on an approval shows in the sidebar's Waiting for input and in the project's Waiting on you, then moves to Idle in both once allowed. A reply still streaming when the page reloads picks its run up again and finishes. |
| `e2e-screens` | At 390px and 1024px, Code, a project, Routines and a new chat load their data with no console errors. |
| `regression-clarify-*` | Answered questions survive stale polls, completion, reload and a fresh transcript. |
| `regression-code-sessions` | Project sessions stay out of Recents and open from their project. |
| `regression-dictation` | Dictation pieces, retries and the kept recording. |
| `regression-drafts` | Composer drafts are kept per chat and cleared on send. |
| `regression-submission` | Concurrent sends start one run and get one reply. |

## Add a test for your change

1. Copy the shape of `app/scripts/e2e-live-sessions.mjs`. Read `APP_URL` and `MOCK_URL` from the
   environment, import Playwright from `PLAYWRIGHT_MODULE`, and use `--no-sandbox`. Name it
   `e2e-<area>.mjs` and the runner picks it up.
2. Seed state through the app's own Dexie module, never through the UI:
   `page.evaluate(async (mock) => { const { db } = await import("/src/lib/db.ts"); … })`.
   Point the first profile at `${mock}/v1` with `apiKey: "mock-key"` and `pluginChats: true`, and
   write `db.settings` with `onboarded: true`. Otherwise the setup wizard covers the app.
3. Give seeded chats `titleEdited: true` when you look them up by title, because Hermes's
   auto-title renames them after the first turn. Give each run unique `hermesSessionId`s, because
   the mock keeps its state between scripts.
4. Drive the mock with words in a message (`clean up` asks for an approval, `long` streams slowly,
   `ask` asks a question, `plan` writes a plan). There are also env vars (`MOCK_NO_PLUGIN`,
   `MOCK_BLOCK_RUN_EVENTS`, `MOCK_DROP_EVENTS_MS`, …). The header of `scripts/mock-hermes.mjs`
   lists them all, and `.agents/skills/mock-server-scenarios.md` gives recipes. Seeded projects
   include `p_1a2b3c4d` (Memento) and `p_9c0d1e2f` (Smart Home, two repos).
5. Assert on what the user sees: roles and names (`getByRole("region", { name: "Waiting on you" })`,
   `getByRole("navigation", { name: "Recents" })`), or on Dexie rows for message state. To wait on
   an async check, loop in Node over `page.evaluate`. Don't pass an async predicate to
   `page.waitForFunction`: the returned promise is truthy, so the wait ends at once.
6. To count requests, use `page.on("request")`, and bound the count by the timing in
   `src/lib/freshness.ts`. Run the test against the polling mock as well, because with the change
   stream open most screens only poll every 5 minutes.
7. Prove the test can fail: run it against `main` and confirm it catches the bug you fixed.

   ```bash
   git worktree add /tmp/main origin/main && ln -s "$PWD/app/node_modules" /tmp/main/app/node_modules
   (cd /tmp/main/app && pnpm exec vite --port 15174 --strictPort &)
   APP_URL=http://localhost:15174 MOCK_URL=http://localhost:18643 node app/scripts/e2e-<area>.mjs
   ```

   If it passes on main as well, it doesn't test your change. Then remove the worktree.
8. Look at the screenshots (`SHOTS_DIR`) for every viewport you touched, in light and dark mode
   when the change is visual.

## Gotchas

- At 1440px a project session opens with its project pane and the sidebar beside it. That one
  screen shows all three views of a session's state, which is the best place to check that they
  agree.
- Cloud containers block `models.dev`, so the proxy reports failed connections to it. That's
  harmless: context windows are only unknown.
- When a selector stops matching, check whether the app renamed it before you blame your change.
  The sidebar's chat list went from "Conversations" to "Recents".
- Don't `pkill -f` with a pattern from your own command line, because it kills your shell. Free a
  port with `fuser -k <port>/tcp`.
