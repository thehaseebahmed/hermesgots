---
name: e2e-testing
description: Use when verifying a Gots app change end to end in a real browser against the mock Hermes, taking screenshots of the app, or adding a browser flow.
category: testing
---

# End-to-end testing Gots

Gots's e2e flows drive the real app (Vite) in headless Chromium with Playwright against the mock
Hermes (`app/scripts/mock-hermes.mjs`). The `e2e` CLI starts the app and whichever mocks a flow
needs, runs it, and stops them again. CI doesn't run these, so run the flows your change touches
before you call a change to chats, sessions, polling or sync done. `pnpm lint`, `pnpm typecheck`
and `pnpm build` still have to pass on top of that.

## The CLI

From `app/` run `pnpm e2e …`. From anywhere in the repo, `.agents/skills/e2e-testing/e2e …` does
the same.

```bash
pnpm e2e list                     # every flow, one line each
pnpm e2e chat-message             # one flow
pnpm e2e approval reattach        # several
pnpm e2e all                      # every flow; approval and reattach again on the polling mock
pnpm e2e approval --polling       # on the mock without its change stream, so the app polls
pnpm e2e live-poll --app http://localhost:15174   # against an app already running (say main's)
pnpm e2e shot /code --width 390 --dark            # a screenshot of any screen (below)
pnpm e2e up / pnpm e2e down       # start every server and leave it up, or stop them all
```

Each flow prints `PASS: …` lines, and the run ends with `All N passed` or `FAILED: <flows>`. On
failure, read the flow's output above that line, then look at its `<flow>-failed.png`. Server logs
are in `$TMPDIR/memento-e2e-logs/`.

The CLI reuses any server that is already up, so after `pnpm e2e up` each run starts at once. With
`--keep`, a run leaves its own servers running.

| Port | Server |
|---|---|
| 15173 | The app (Vite) |
| 18642 | Mock `live`: the plugin's change stream is open, so most screens poll only every 5 minutes |
| 18643 | Mock `polling`: `MOCK_NO_EVENTS=1`, polling like an older plugin |
| 18644 | Mock `legacy`: `MOCK_BLOCK_RUN_EVENTS=1`, Hermes v2026.9.24's blocked run stream |
| 18645 | Mock `no-dictation`: `MOCK_DICTATION=off` |
| 18646 | Mock `theseus`: `MOCK_THESEUS=building`, a run part-way through its checkpoints |

The CLI looks for Playwright in `app/node_modules`, then globally (`npm root -g`). If it's
elsewhere, set `PLAYWRIGHT_MODULE` to its `index.mjs`. The CommonJS `index.js` loads without
`chromium`. Never run `playwright install`, because cloud containers already have Chromium.

## Flows

| Flow | Checks |
|---|---|
| `chat-message` | A new chat sends its message, gets the whole reply, and shows in Recents |
| `approval` | A project session waiting on an approval shows in the sidebar's Waiting for input and its project's Waiting on you. Both move it to Idle once it's allowed |
| `reattach` | A reply still streaming when the page reloads picks its run up again and finishes |
| `live-poll` | `runs/live` is read by one shared poll: at most 3 times in 25s with the session, its project and the sidebar open. Main read it 4 times |
| `photo-progress` | A message with a photo shows its reply's tool calls while it runs, on the `legacy` mock where the app follows the turn in the transcript. Main showed none |
| `stream-writes` | A streaming reply is written to IndexedDB at most 6 times a second on the mock. Main wrote it 7.5 times |
| `idle-requests` | An open chat with nothing happening makes at most 12 requests in 65s on the `polling` mock (6 of them the sidebar's `runs/live`). Main made 17 |
| `screens` | Code, a project, Routines and a chat load at 390 and 1024px, light and dark, with no console errors |
| `clarify-polling`, `clarify-transcript` | Answered questions survive stale polls, a reload and a fresh transcript |
| `code-sessions` | Project sessions stay out of Recents and open from their project |
| `dictation` | Dictation pieces, retries, the kept recording, and no mic where the host can't transcribe |
| `drafts` | Composer drafts are kept per chat and cleared on send |
| `submission` | Concurrent sends start one run and get one reply |
| `image-skeleton` | A reply's images hold their cell while the plugin serves them (the route is held), then land at that size: one image and a gallery alike, phone and tablet, light and dark |
| `image-captures` | Theseus's capture screenshots hold their place, and a capture the host can't serve says so |
| `image-viewer` | A photo opened from a message holds its own box while it decodes |

The new flows live in `app/scripts/e2e/`. The older ones are `app/scripts/regression-*.mjs`, which
the CLI runs by name.

## Screenshots

An agent sees the app through PNG files. It captures them in three ways:

1. **Any screen, on demand.** `pnpm e2e shot <path>` sets up the bot against the mock, opens the
   path, waits for the network to settle, saves a PNG and prints its path. `<bot>` in the path
   stands for the bot's id. Options are `--width` (390 is a phone, 1024 a tablet, 1440 the
   default laptop), `--height`, `--dark`, `--polling` and `--out <file>`.

   ```bash
   pnpm e2e shot /routines --width 1024
   pnpm e2e shot /code/'<bot>'/p_1a2b3c4d --width 390 --dark
   pnpm e2e shot /settings/appearance --out /tmp/appearance.png
   ```

2. **Each step of a flow.** Inside a flow, `await shot("waiting")` saves `<flow>-waiting.png`, and a
   failing flow saves `<flow>-failed.png`. They go to `$TMPDIR/memento-e2e/`, or to `--shots <dir>`.
   Take a shot at each state a reviewer would want to see.

3. **In a script of your own.** Use `page.screenshot({ path, fullPage: true })` for a whole page,
   or `page.getByRole(…).screenshot({ path })` for one element, such as a card or a sheet.

To look at a screenshot, open the PNG with the file-reading tool, which shows images, and check the
screen. A passing assertion doesn't catch a clipped sheet or a broken dark mode. To show the user,
copy the PNG into a folder you can deliver from, such as the project's shared files in Claude
Projects, attach it to your reply, or describe what it shows. Never commit screenshots.

## Adding a flow

1. Write `app/scripts/e2e/<flow>.mjs` on `lib.mjs`:

   ```js
   import { app, assert, flow, pass } from "./lib.mjs"

   await flow("my-flow", async ({ page, profileId, seed, send, lastReply, until, shot }) => {
     await seed([{ id: "e2e-mine", title: "Mine", projectId: "p_1a2b3c4d" }])
     await page.goto(`${app}/c/e2e-mine`)
     await send("clean up")
     await page.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 20_000 })
     await shot("approval")
     pass("the approval shows")
   })
   ```

   `flow(name, body, { viewport, dark })` points the first bot at the mock and skips the setup
   wizard. The other helpers do the rest:
   - `seed` writes chats to Dexie, titled for good and with a session id new to the mock.
   - `send` types into the composer and sends.
   - `lastReply(chatId)` reads the newest reply's status and length.
   - `until(check, ms, what)` polls a check.
   - `held(pattern, fail)` holds requests matching a pattern back until its `release()` (10s at most),
     so a placeholder can be looked at while the bytes are still coming; `fail` answers a url ending
     in it as a file the host can't serve.
   - `watchSkeletons()` records every skeleton the page renders, `skeletons()` reads them and
     `stopSkeletons()` ends it: a placeholder can live for a single commit, which polling misses.
2. Register the flow in `FLOWS` in `app/scripts/e2e/cli.mjs`: its script, a one-line `about`, and,
   if it needs one, `mock` (another mock), `alsoPolling` (also run on the polling mock under `all`)
   or `extra` (more mock URLs as env vars). A new mock variant goes in `MOCKS` there and in the
   port table above.
3. Drive the mock with words in a message: `clean up` asks for an approval, `long` streams slowly,
   `ask` asks a question, `plan` writes a plan. The header of `app/scripts/mock-hermes.mjs` lists
   its words and env vars, and `.agents/skills/mock-server-scenarios.md` has recipes. Seeded
   projects include `p_1a2b3c4d` (Gots) and `p_9c0d1e2f` (Smart Home, two repos).
4. Assert on what the user sees. Use roles and names, such as
   `getByRole("region", { name: "Waiting on you" })` or `getByRole("navigation", { name: "Recents" })`,
   or Dexie rows for message state. Don't pass an async predicate to `page.waitForFunction`: its
   promise is truthy, so the wait ends at once. Use `until`.
5. To count requests, use `page.on("request")` and bound the count by the timing in
   `src/lib/freshness.ts`. Run the flow on the polling mock, because with the change stream open
   most screens barely poll.
6. Prove the flow can fail by running it against main:

   ```bash
   git worktree add /tmp/memento-main origin/main
   ln -s "$PWD/app/node_modules" /tmp/memento-main/app/node_modules
   (cd /tmp/memento-main/app && pnpm exec vite --port 15174 --strictPort &)
   pnpm e2e <flow> --app http://localhost:15174
   ```

   If it passes there too, it doesn't test your change. Afterwards, free the port with
   `fuser -k 15174/tcp` and run `git worktree remove --force /tmp/memento-main`.
7. Look at the flow's screenshots for every width and mode you touched.

## Gotchas

- At 1440px a project session opens beside its project and the sidebar. That one screen shows all
  three views of a session's state, which is where to check that they agree.
- The mock keeps its state between flows, so `seed` gives each run new session ids. Hermes's
  auto-title renames a chat after its first turn unless it is seeded with `titleEdited: true`, as
  `seed` does.
- Cloud containers block `models.dev`, so the proxy reports failed connections to it. That's
  harmless: context windows are just unknown.
- When a selector stops matching, check whether the app renamed it before you blame your change.
  The sidebar's chat list went from "Conversations" to "Recents".
- Don't `pkill -f` with a pattern from your own command line, because it kills your shell. Use
  `pnpm e2e down`, or `fuser -k <port>/tcp`.
