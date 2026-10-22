---
name: verify-gots
description: "Verify Gots — the Hermes companion PWA in app/ — the way a user does: launch the app against the mock Hermes, drive its screens in a real browser, and capture proof. Use when a change must be proven end to end, when running a verification pass over the feature map, or when behavior needs evidence beyond the unit and component tiers."
---

# Verify Gots

Gots is a React PWA (`app/`, Vite) whose data comes from a Hermes host carrying the Gots plugin.
Verification drives the real app in headless Chromium against a mock Hermes (`app/scripts/mock-hermes.mjs`)
that speaks the same wire format, so every screen is exercised by the same requests a real host
would see. The harness is the repo's own: the `pnpm e2e` CLI and the flow library
`app/scripts/e2e/lib.mjs`. Read `features/README.md` first, then the feature file for the behavior
being proven. `.agents/skills/e2e-testing/SKILL.md` documents the same harness for writing new
flows; this skill is the contract for a verification run: what to launch, how to tell the instance
is worth driving, what counts as proof, and how to tear down.

## Launch

From `app/`, once per checkout: `pnpm install`. Nothing else is built — Vite serves the app.

```bash
cd app
pnpm e2e up        # the app on :15173 and every mock, left running
pnpm e2e down      # stop them
```

`pnpm e2e <flow>` starts the same servers itself and stops them when the flow ends; add `--keep`
to leave them up. A verification run keeps them up (`pnpm e2e up`) so several drives in a row start
at once.

| Port | Server |
|---|---|
| 15173 | The app (Vite; `--strictPort`) |
| 18642 | Mock `live`: the plugin's change stream is open |
| 18643 | Mock `polling`: `MOCK_NO_EVENTS=1`, polling like an older plugin |
| 18644 | Mock `legacy`: `MOCK_BLOCK_RUN_EVENTS=1`, Hermes v2026.9.24's blocked run stream |
| 18645 | Mock `no-dictation`: `MOCK_DICTATION=off` |

The CLI serves the app on `127.0.0.1` and its readiness probe accepts any family, so launch works
whether `localhost` here resolves to IPv4 or IPv6 (see the e2e-testing skill's gotcha).

Ready means usable, not just answering: `pnpm e2e up` prints the five URLs only after each answers
its probe (the app's `/`, each mock's `/health`), but the app is usable when a fresh browser shows
its chat route. Prove it with a screen at rest — `pnpm e2e shot / --out <artifacts>/launch-probe.png`
— and look at the PNG: the composer and the sidebar, or the setup wizard, not an error frame.
Every drive opens a **fresh browser profile**, so IndexedDB starts empty and Dexie runs its own
migrations on first touch; the flow's `setUpBot` then finishes onboarding and points the first bot
at the mock. Seed data comes from the flow's `seed(...)` and from what the mock already holds
(projects `p_1a2b3c4d` "Gots" and `p_9c0d1e2f` "Smart Home", two repos).

Isolation: the ports are fixed, so **only one run of this checkout may drive them at a time** —
never drive an instance you didn't start, and never start a second app on 15173. A `--jobs N` sweep
is the one sanctioned concurrency: N lanes, lane n on its own mock ports (base + 4n) with its own
mock state, all sharing the one app. A second app can be driven against the same mocks on another
port (`pnpm e2e <flow> --app http://127.0.0.1:15174`), which is how a branch is compared with
`main`. The mock keeps its state in the process across flows and runs; flows take fresh ids
(`runId()`) so their sessions don't collide.

## Doctor

```bash
.agents/skills/verify-gots/doctor.sh
```

Read-only. It answers, in order: the app and each mock respond (the CLI's own probe, anything under
500); the mock and Vite processes are up and which working directory owns each pid (so a stale
server from another tree is visible); the thread budget this cgroup has left (a lane wants ~150 per
concurrent browser); Playwright resolves (as the CLI finds it — `app/node_modules`, `npm root -g`,
then `PLAYWRIGHT_MODULE`); and it prints the build being driven (git head, app version), the
artifact directory, and the fact that the mock's fixed key leaves no credential to validate. Exit 0 is "worth driving", 1 is not. **Run it first whenever anything looks off** — a
flow failing with a missing control is often a stale server, not a regression.

## Drive

The unit of driving is a flow: a script on `app/scripts/e2e/lib.mjs`, run by the CLI or on its own.
`features/<feature>.md` pairs each user action with the exact call that performs it; this is the
harness they all sit on.

```bash
cd app
pnpm e2e list                     # every flow, one line each
pnpm e2e chat-message             # one flow
pnpm e2e approval --polling       # the same on the polling mock
pnpm e2e all --jobs 4             # the whole sweep in 4 parallel lanes (one per registry slice)
pnpm e2e shot /code --width 390   # any screen at rest, as a PNG
```

A drive that is not (yet) a registered flow runs directly against servers left up by
`pnpm e2e up`, from `app/`:

```bash
PLAYWRIGHT_MODULE="$(npm root -g)/playwright/index.mjs" \
APP_URL=http://localhost:15173 MOCK_URL=http://localhost:18642 SHOTS_DIR="$GOTS_VERIFY_ARTIFACTS" \
node scripts/e2e/my-drive.mjs
```

On a full sweep prefer lanes (`--jobs N`, 2-8) to running `all` serially: lanes split the registry
round-robin, each with its own mocks and shared app, and the wall time divides by the lanes minus
one startup. Each concurrent browser wants roughly 150 threads and some headroom — `doctor.sh`
reports the cgroup budget — and a flow that measures wall-clock pacing can flake when lanes contend;
run a suspect flow serially (`pnpm e2e <flow>`) and say so, rather than rerunning until green.

A drive script uses the library's real handles — roles and names the app renders, route paths, and
the helpers:

- `flow(name, body, { viewport, dark })` — opens the app with its bot set up, runs `body`, closes
  the browser; a throw saves `<name>-failed.png` first. `signedIn({ width, dark, vault })` is the
  same for a flow that starts before the setup wizard (Identity and the sync function stubbed).
- `send(text)` types into the composer (`page.getByRole("textbox").last()`) and presses Enter.
- `seed([{ id, title, projectId? }])` writes chats to Dexie, titled for good (`titleEdited: true`)
  and with a session id new to the mock — a fixture, never the behavior under test.
- `lastReply(chatId)` reads the newest reply row: status, text length, reasoning, tool count — the
  stored side effect, beside what the bubble shows. `stored(chatId)` reads a chat's pull requests.
- `until(check, ms, what)` polls a check; `settled(page)` waits until nothing the clock drives is
  still moving before a box or a class is read.
- `held(pattern, fail)` holds requests back (10s at most) so a placeholder can be looked at mid-load;
  `watchSkeletons()` / `skeletons()` / `stopSkeletons()` record placeholders that live one commit.
- `shot(step)` saves `<flow>-<step>.png` under `SHOTS_DIR`; `pass(text)` prints `PASS: …`.
- `mockAuth`, `compress(session, child)`, `makeProject(until, name)`, `openAfk(page, screen)`,
  `afkOn(page, screen, until)`, `say(body)` reach the mock the way another device or the plugin
  would. `assertOneLine` and `assertBreakAtHyphen` measure rendered text.

Drive through the UI: buttons, links, roles and names — `getByRole("button", { name: "Allow once" })`,
`getByRole("navigation", { name: "Recents" })`, `getByRole("region", { name: "Waiting on you" })` —
not coordinates or tab order. The composer is `getByRole("textbox").last()`. When a selector stops
matching, check whether the app renamed it before blaming the change.

The mock behaves like a Hermes with the Gots plugin and is steered by words in a message:
`clean up` asks for an approval, `ask` asks a question, `long` streams slowly, `plan` keeps a todo
list, `fail` fails a tool call, `image` answers with images, `think out loud` streams reasoning,
`ship` opens a pull request. Its header lists every word and env var, and
`.agents/skills/mock-server-scenarios.md` has recipes. The mock stands in for Hermes — a real
production boundary — and nothing else is mocked: IndexedDB, the plugin's routes and the render
path are the real code.

## Evidence

Proof artifacts live outside the repo, in `GOTS_VERIFY_ARTIFACTS` (default
`${TMPDIR:-/tmp}/gots-verify`); pass it to a run as `--shots "$GOTS_VERIFY_ARTIFACTS/<run-id>"`.
**Never commit screenshots.**

Proof standards:

- Exercise the real user path — a tap on the control the user taps, never an internal setter or a
  test-only endpoint. `seed(...)` may set up fixtures; it may never stand in for the action.
- Capture the action **and** the resulting state: `shot(step)` at each state a reviewer would want
  to see, including before the tap where the next state could regress a layout. A passing assertion
  doesn't catch a clipped sheet or a broken dark mode — look at the PNGs.
- Verify side effects beside what is visible: the reply row in Dexie (`lastReply`), a project's AFK
  switch read back from the Host after a reload, a removed MCP server gone from the list. The final
  screen alone is not a proof of a write.
- Mocks only where a production boundary already isolates the system — here, the Hermes host.
- When the safe path is a dry-run or test mode, verify what it actually skips by observing (files,
  network, git refs), not by trusting its name.

Each drive ends with `PASS: …` lines per step; a failure saves `<flow>-failed.png` and the run ends
`FAILED: <flows>`. Server logs are in `$TMPDIR/memento-e2e-logs/`. Keep, per run: the flow's PNGs,
the `PASS:` transcript, and any read-back values the journey asserted (reply length, request counts).
Record the feature id and the entry point used with every artifact.

## Cleanup

```bash
cd app
pnpm e2e down
```

That stops everything the CLI started (it kills by port). Kill only what this run started: never
`pkill -f` with a pattern from your own command line (it matches your shell) — use `pnpm e2e down`,
or a bracketed pattern (`pkill -f 'mock-herme[s]'`), and check with `pgrep -af` after, since
`fuser` can no-op silently on hosts that lack it and a stale mock keeps its state, which reads as a
regression. A run with `--keep` or `pnpm e2e up` leaves servers up on purpose; end with `down`.

Cleanup removes instances and scratch state — the browser profile dies with the flow, the mock's
state dies with its process. **It never removes the evidence**: after `down`, confirm the PNGs and
transcripts still sit in `GOTS_VERIFY_ARTIFACTS`. If a drive failed midway, run `down` before the
next attempt so a broken run can't strand a port.

## Helpers

- `.agents/skills/verify-gots/doctor.sh` — the read-only instance check (see **Doctor**):
  `GOTS_VERIFY_ARTIFACTS=… .agents/skills/verify-gots/doctor.sh`
- `app/scripts/e2e/lib.mjs` — every drive helper, listed under **Drive**.
- `.agents/skills/e2e-testing/e2e` — the same CLI from anywhere in the repo.
- `app/scripts/mock-hermes.mjs` — the mock's words and env vars, in its header.

## Environment notes

Proven in a Linux container: `pnpm install` with a warm pnpm store, Playwright preinstalled at
`npm root -g` with its Chromium under `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, headless (no
display). A machine without those needs `npm i -g playwright`, a Playwright Chromium (never
`playwright install` in a container that already has one), and `PLAYWRIGHT_MODULE` set when
Playwright sits somewhere the CLI doesn't look.

That stand-in capped threads at 256 (`pids.max`, read-only), which fits one or two headless
browsers and no more. Everything above was proven there except full-sweep lane scaling: lanes were
proven at `--jobs 2` (same outcomes as serial; four light flows 107s serial → 78s in two lanes),
while `--jobs 5` there killed browsers (`Target crashed`, `pthread_create: Resource temporarily
unavailable`) — the cap, not the flows. `--jobs 4` for the whole sweep needs a normal machine (each
browser ~150 threads); `.github/workflows/e2e-nightly.yml` runs it that way and its wall time is
the real number.

If the app's readiness probe loops its full 60s against a Vite that is up, the Vite bound `::1`
while the probe reached `localhost` over IPv4 — the CLI now probes every family and starts its own
app on `127.0.0.1`, so only an app started elsewhere needs the manual workaround: `--host
127.0.0.1` and `--app http://127.0.0.1:<port>`.
