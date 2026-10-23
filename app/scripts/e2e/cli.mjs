#!/usr/bin/env node
// The e2e CLI: runs Gots's browser flows against the mock Hermes, starting the app and the
// mocks each flow needs and stopping them afterwards. `pnpm e2e help` lists what it does.
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, openSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { laneOf, MAX_LANES } from "./lanes.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, "../..")

// Mocks by what they leave out; each runs on its own port so flows can mix them. A parallel lane
// takes its own set (E2E_MOCK_BASE + its four), so lanes never share mock state.
const MOCK_BASE = Number(process.env.E2E_MOCK_BASE ?? 18642)
const MOCKS = {
  live: { port: MOCK_BASE, env: {} },
  polling: { port: MOCK_BASE + 1, env: { MOCK_NO_EVENTS: "1" } },
  legacy: { port: MOCK_BASE + 2, env: { MOCK_BLOCK_RUN_EVENTS: "1" } },
  "no-dictation": { port: MOCK_BASE + 3, env: { MOCK_DICTATION: "off" } },
  "triage-new": { port: MOCK_BASE + 4, env: { MOCK_TRIAGE: "new" } },
  "triage-thread": { port: MOCK_BASE + 5, env: { MOCK_TRIAGE: "thread" } },
  stream: { port: MOCK_BASE + 6, env: { MOCK_DICTATION_STREAM: "on" } },
}
// The app is shared: lanes drive it in separate browsers and one Vite serves them all.
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 15173)

// `script` is relative to app/scripts; `mock` the one MOCK_URL points at (live by default);
// `alsoPolling` runs it again on the polling mock under `all`; `extra` adds more mock URLs.
const FLOWS = {
  "chat-message": {
    script: "e2e/chat-message.mjs",
    about: "Start a new chat, send a message, get the whole reply and find it in Recents",
  },
  "thinking-line": {
    script: "e2e/thinking-line.mjs",
    about:
      "A turn watched thinking: the working line before any reasoning, the line open and the working line gone as it streams, folded at the first answer token, and a reload reading Thought",
  },
  "slash-skills": {
    script: "e2e/slash-skills.mjs",
    about:
      "The composer's / menu lists the bot's skills from the Gots plugin, not Hermes's /v1/skills",
  },
  "model-switch": {
    script: "e2e/model-switch.mjs",
    about: "Changing the model mid-chat shows where it changed in the thread, on a reload too",
  },
  "usage-limit": {
    script: "e2e/usage-limit.mjs",
    about:
      "The limit notice follows the account (quiet with credits, out without), and the usage sheet names the model in a box above its meter",
  },
  approval: {
    script: "e2e/approval.mjs",
    about:
      "A project session waits on an approval in the sidebar and in Code, then lands under Today",
    alsoPolling: true,
  },
  "approval-missed": {
    script: "e2e/approval-missed.mjs",
    about: "An approval the host timed out, or refuses to take an answer for, leaves the composer",
    alsoPolling: true,
  },
  "clarify-missed": {
    script: "e2e/clarify-missed.mjs",
    about:
      "A question the host timed out stays in the thread, and asking again has the agent ask afresh",
  },
  "failed-send": {
    script: "e2e/failed-send.mjs",
    about:
      "A message the host never received stays in the thread, marked Failed, to send again or drop",
  },
  "plain-error": {
    script: "e2e/plain-error.mjs",
    about:
      "A turn that fails before it answers shows as plain text in the chat, with no bot beside it",
  },
  reattach: {
    script: "e2e/reattach.mjs",
    about: "A reply still streaming when the page reloads picks its run up again and finishes",
    alsoPolling: true,
  },
  "foreign-run": {
    script: "e2e/foreign-run.mjs",
    about: "A run started elsewhere shows as running in Code and on the open session screen",
    alsoPolling: true,
  },
  "compressed-run": {
    script: "e2e/compressed-run.mjs",
    about:
      "A compressed chat another device started loads its transcript and follows its run on a device that never saw it",
    alsoPolling: true,
  },
  "compressed-live": {
    script: "e2e/compressed-live.mjs",
    about:
      "A chat compressed mid-run on the device that sent the turn keeps streaming to its end, finishes after a reload, and comes down on Stop",
    alsoPolling: true,
  },
  "plan-mode": {
    script: "e2e/plan-mode.mjs",
    about:
      "A plan a session finishes stays with it: opening another session as it lands shows no plan card",
    alsoPolling: true,
  },
  "history-pages": {
    script: "e2e/history-pages.mjs",
    about:
      "A session opened mid-turn from another device loads whole turns, pages back twice and keeps one reply",
  },
  "history-generations": {
    script: "e2e/history-generations.mjs",
    about:
      "A session compacted while this device already showed its turns keeps each of them shown once",
  },
  "question-from-push": {
    script: "e2e/question-from-push.mjs",
    about:
      'A question opened from a notification shows as waiting, never "No answer", even before the chat is here',
    alsoPolling: true,
  },
  "live-poll": {
    script: "e2e/live-poll.mjs",
    mock: "polling",
    about: "runs/live is read by one shared poll: at most 3 times in 25s with every screen open",
  },
  "photo-progress": {
    script: "e2e/photo-progress.mjs",
    mock: "legacy",
    about: "A message with a photo shows its reply's tool calls while it runs, from the transcript",
  },
  "image-skeleton": {
    script: "e2e/image-skeleton.mjs",
    about:
      "An agent's images hold their place with a skeleton while they load, in a chat and a project session",
  },
  "image-viewer": {
    script: "e2e/image-viewer.mjs",
    about: "A photo opened from a message holds its place while it decodes, then paints",
  },
  todos: {
    script: "e2e/todos.mjs",
    about: "The todo list shows while the reply that wrote it runs, from events or the transcript",
  },
  "fallback-models": {
    script: "e2e/fallback-models.mjs",
    about:
      "A bot's fallback models are recorded on its host: two picks in order, one removed, no third",
  },
  "delegation-model": {
    script: "e2e/delegation-model.mjs",
    about:
      "A bot's subagent model is recorded as its host's delegation model, cleared back to the bot's own",
  },
  mcps: {
    script: "e2e/mcps.mjs",
    about:
      "A bot's MCP servers are a tab of its settings, with Add a server on top, its own servers and its plugin's under headings, each row a name over its health, at phone and tablet widths",
  },
  afk: {
    script: "e2e/afk.mjs",
    about:
      "A project's options menu opens AFK's frontier: ready oldest first, claimed marked, blocked naming its open blocker, with no row for a plugin that can't read it",
  },
  "afk-switch": {
    script: "e2e/afk-switch.mjs",
    about:
      "AFK's switch turns a project on and off on its host, and a reload reads that setting back — the project's, not the device's",
  },
  "afk-skills": {
    script: "e2e/afk-skills.mjs",
    about:
      "AFK's pop-up picks one skill to build by and any number to critique from the bot's own list, kept on the host apart from another project's, with no pickers on an older plugin",
  },
  "afk-switch-reasons": {
    script: "e2e/afk-switch-reasons.mjs",
    about:
      "AFK's pop-up says why it can't offer the switch: no GitHub account, said once, and a plugin too old to switch it",
  },
  "afk-claim": {
    script: "e2e/afk-claim.mjs",
    about:
      "AFK claims the oldest ready task when a project is turned on — the pop-up naming what it holds — and a GitHub refusal leaves the switch on with its reason shown",
  },
  "afk-session": {
    script: "e2e/afk-session.mjs",
    about:
      "AFK works its claimed task in a session of its own: in Code marked AFK, opening with one line naming the task rather than the brief",
  },
  "afk-stalled": {
    script: "e2e/afk-stalled.mjs",
    about:
      "A stalled AFK session waits where the user finds it: the sidebar's Waiting for input and Code's Waiting on you, with the host's reason under it",
  },
  "afk-stage": {
    script: "e2e/afk-stage.mjs",
    about:
      "AFK's pop-up names the stage its held task is in, by the stage's own name from the task's snapshot, prefixed to the task's title, and keeps naming it once the pickers change under it",
  },
  "afk-prompt": {
    script: "e2e/afk-prompt.mjs",
    about:
      "AFK's Prompt row reads the words its runs are told and opens one writing sheet for them — the bottom sheet, or the drawer from a laptop's width — with Done writing them back to the host",
  },
  "pipeline-pill": {
    script: "e2e/pipeline-pill.mjs",
    about:
      "A staged session's pipeline is the first pill above the composer — three bars, green where a step is done and red where it failed, with the stage in words — and its sheet counts the stage out of three and names what each step ran, still there once the task is done",
  },
  "mcps-gate": {
    script: "e2e/mcps-gate.mjs",
    about:
      "A bot whose plugin answers without `mcps` has no MCP tab, its tab's URL returns to the bot, and the controls each advertises apart are offered apart",
  },
  "mcps-catalogue": {
    script: "e2e/mcps-catalogue.mjs",
    about:
      "A Bot's Add action opens Hermes's Catalogue, which lists only the entries it doesn't have, and a search narrows it",
  },
  "mcps-remove": {
    script: "e2e/mcps-remove.mjs",
    about:
      "A removal is offered on each of a bot's own MCP servers and none a Hermes plugin provides, asks first, and leaves the list showing what is left",
  },
  "mcps-add": {
    script: "e2e/mcps-add.mjs",
    about:
      "Picking a Catalogue entry opens a form of the values it declares, titled by value name and subtitled by prompt, an entry with nothing to fill is one tap, and an add writes the server and leaves the Catalogue",
  },
  "mcps-server": {
    script: "e2e/mcps-server.mjs",
    about:
      "A server's own sheet shows its Config — the block, its values, one Save — and its Tools, from the schema cache, with Load tools for a fresh list",
  },
  "mcps-custom": {
    script: "e2e/mcps-custom.mjs",
    about:
      "A custom server is added from a form of its name and transport, and the Host's own refusal of a name it won't take is what the form says",
  },
  "mcps-access": {
    script: "e2e/mcps-access.mjs",
    about:
      "Server access starts from a waiting server's own health line, shows the Host's URL, takes the pasted callback, and clears the row by itself, at phone and tablet widths",
  },
  "fallbacks-silent-host": {
    script: "e2e/fallbacks-silent-host.mjs",
    about: "A host that never answers a fallback write gives the field back instead of wedging it",
  },
  "todos-legacy": {
    script: "e2e/todos.mjs",
    mock: "legacy",
    about: "The same on a Hermes whose events stream the browser can't read",
  },
  "stream-writes": {
    script: "e2e/stream-writes.mjs",
    about:
      "A streaming reply is written in batches: at most 6 writes a second on the mock (main wrote 7.5)",
  },
  "idle-requests": {
    script: "e2e/idle-requests.mjs",
    mock: "polling",
    about: "An idle open chat makes at most 12 requests in 65s",
  },
  openui: {
    script: "e2e/openui.mjs",
    about:
      "A reply's interface draws at 390 and 768px, light and dark; a block that can't draw stays code; a patch landing while the thread is scrolled up doesn't move the reader",
  },
  screens: {
    script: "e2e/screens.mjs",
    about:
      "Projects, a project, Code, Routines, a chat and a started session load at 390 and 1024px, light and dark, the session's header centred with its repositories and no bot picture",
  },
  "sidebar-collapse": {
    script: "e2e/sidebar-collapse.mjs",
    about:
      "The sidebar shrinks to an icon rail at 1024px and stays collapsed; phones have no button",
  },
  research: {
    script: "e2e/research.mjs",
    about: "A research mission from question to guide, another format, and a citation's source",
  },
  panes: {
    script: "e2e/panes.mjs",
    about:
      "Projects, Code, Meetings and Research: the list beside the item with room for it, one pane without",
  },
  meetings: {
    script: "e2e/meetings.mjs",
    about: "Meetings behind its Developer switch: a recording, an added file and a timestamp",
  },
  "clarify-polling": {
    script: "regression-clarify-polling.mjs",
    mock: "legacy",
    about: "An answered question survives stale polls, completion and a reload",
  },
  "clarify-transcript": {
    script: "regression-clarify-transcript.mjs",
    about: "Answered questions read back from a fresh transcript",
  },
  "code-sessions": {
    script: "regression-code-sessions.mjs",
    about: "Project sessions stay out of Recents and open from Code",
  },
  "session-empty": {
    script: "e2e/session-empty.mjs",
    about:
      "A chat or session not started shows the big bot, a greeting once an hour and the bot's five lines in turn; a session's header holds no text, with its repository chip and the branch it starts from below",
  },
  onboarding: {
    script: "e2e/onboarding.mjs",
    about: "The setup wizard's Join the leaderboard step: on by default, and Continue joins or not",
  },
  "recovery-code": {
    script: "e2e/recovery-code.mjs",
    about:
      "Setup always issues a recovery code, offers the passkey beside it, and gates Continue on copying it",
  },
  "recovery-code-rotation": {
    script: "e2e/recovery-code-rotation.mjs",
    about:
      "Replacing a recovery code in Settings: one dialog asks for the current one, then shows the new one",
  },
  prs: {
    script: "e2e/prs.mjs",
    about:
      "A shipped pull request lists in its project's Pull requests tab; a host that can't reach GitHub keeps the ones it knows",
  },
  outputs: {
    script: "e2e/outputs.mjs",
    about:
      "The outputs pill opens a drawer: a session's pull requests, live and finished, beside its library",
  },
  dictation: {
    script: "regression-dictation.mjs",
    extra: { OFF_MOCK_URL: "no-dictation", STREAM_MOCK_URL: "stream" },
    about:
      "Dictation pieces, retries, the kept recording, a take heard while it is spoken, and no mic where the host can't",
  },
  drafts: {
    script: "regression-drafts.mjs",
    about: "Composer drafts are kept per chat and cleared on send",
  },
  "draft-mode-sync": {
    script: "e2e/draft-mode-sync.mjs",
    about: "A composer draft and a picked mode sync through the plugin's chat record",
  },
  "bot-threads": {
    script: "e2e/bot-threads.mjs",
    extra: { TRIAGE_NEW_MOCK_URL: "triage-new", TRIAGE_THREAD_MOCK_URL: "triage-thread" },
    about:
      "A bot opens Main, its threads are cards where they began, /thread with text opens a thread, and triage's answers read as a card with Undo or a Moved marker",
  },
  submission: {
    script: "regression-submission.mjs",
    about: "Concurrent sends start one run and get one reply",
  },
}

const HELP = `Usage: pnpm e2e <command> [options]      (or .agents/skills/e2e-testing/e2e from the repo root)

Commands:
  <flow> [<flow>...]   Run these flows (see list)
  all                  Run every flow; approval, approval-missed and reattach again on the polling mock
  list                 Name and describe every flow
  shot <path>          Screenshot a screen of the app, e.g. shot /code or shot /routines
  up                   Start the app and every mock, and leave them running
  down                 Stop them

Options:
  --polling            Run flows on the mock without its change stream, so the app polls
  --shots <dir>        Where screenshots go (default: ${join(tmpdir(), "memento-e2e")})
  --app <url>          Use an app already running there (say main's, on another port)
  --headed             Show the browser (needs a display)
  --width <px>         shot: the window's width (default 1440; 390 is a phone, 1024 a tablet)
  --height <px>        shot: the window's height (default 844 under 768px wide, else 900)
  --dark               shot: dark mode
  --out <file>         shot: the file to write (default: <shots>/shot-<path>-<width>.png)
  --jobs <n>           Run the flows in <n> parallel lanes (2-${MAX_LANES}); each lane takes its own
                       mock ports (base + 4 per lane) and they share the app
  --keep               Leave the servers running afterwards (the next run reuses them)`

const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}
const flag = (name) => {
  const at = args.indexOf(name)
  if (at >= 0) args.splice(at, 1)
  return at >= 0
}
const shots = resolve(option("--shots") ?? join(tmpdir(), "memento-e2e"))
const appUrl = option("--app")
const width = Number(option("--width") ?? 1440)
const height = Number(option("--height") ?? (width < 768 ? 844 : 900))
const out = option("--out")
const jobs = Number(option("--jobs") ?? 1)
const dark = flag("--dark")
const polling = flag("--polling")
const keep = flag("--keep")
const headed = flag("--headed")
const [command, ...rest] = args

const logs = join(tmpdir(), "memento-e2e-logs")
const started = []
const up = async (url) => {
  // One server, both families: Vite without `--host` binds `::1` alone while a `localhost` that
  // resolves to 127.0.0.1 never reaches it. Try each name a local server can be on, port kept, and
  // answer the one that serves so the caller's URL names it.
  const at = new URL(url)
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    try {
      at.hostname = host
      const response = await fetch(at, { signal: AbortSignal.timeout(1000) })
      if (response.status < 500) return host
    } catch {
      // That family isn't answering; try the next.
    }
  }
  return null
}
async function serve(name, port, command, args, env = {}) {
  const hosted = await up(`http://127.0.0.1:${port}${name === "app" ? "" : "/health"}`)
  if (hosted) return `http://${hosted}:${port}`
  const url = `http://127.0.0.1:${port}`
  mkdirSync(logs, { recursive: true })
  const log = openSync(join(logs, `${name}.log`), "w")
  const child = spawn(command, args, {
    cwd: appDir,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", log, log],
    detached: true,
  })
  child.unref()
  started.push(child)
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    if (await up(`${url}${name === "app" ? "" : "/health"}`)) return url
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error(`${name} didn't start on ${port}; see ${join(logs, `${name}.log`)}`)
}
const serveApp = () =>
  appUrl ??
  // Bound to 127.0.0.1 so the URL every probe and flow uses reaches it whatever `localhost` means
  // here (the e2e-testing skill's gotcha).
  serve("app", APP_PORT, "pnpm", ["exec", "vite", "--port", `${APP_PORT}`, "--strictPort", "--host", "127.0.0.1"])
const serveMock = (name) =>
  serve(`mock-${name}`, MOCKS[name].port, "node", ["scripts/mock-hermes.mjs"], MOCKS[name].env)
function stopStarted() {
  if (keep) return
  for (const child of started) {
    try {
      process.kill(-child.pid)
    } catch {
      // Already gone.
    }
  }
}
function stopAll() {
  // Every lane's mock ports too: `down` also stops a sweep this CLI ran in parallel (lane n takes
  // MOCK_BASE + 4n, up to MAX_LANES lanes).
  const ports = [APP_PORT, ...Array.from({ length: 4 * MAX_LANES }, (_, index) => MOCK_BASE + index)]
  spawnSync("fuser", ["-k", ...ports.map((port) => `${port}/tcp`)], { stdio: "ignore" })
}

function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE
  const global = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim()
  // The ESM entry: importing the CommonJS index.js leaves `chromium` undefined.
  const found = [
    join(appDir, "node_modules/playwright/index.mjs"),
    join(global, "playwright/index.mjs"),
  ]
  const module = found.find(existsSync)
  if (!module) {
    console.error(
      "Playwright not found: install it globally, or set PLAYWRIGHT_MODULE to its index.mjs",
    )
    process.exit(1)
  }
  return module
}

async function runFlow(name, mockName) {
  const flow = FLOWS[name]
  const env = {
    ...process.env,
    PLAYWRIGHT_MODULE: playwright(),
    APP_URL: await serveApp(),
    MOCK_URL: await serveMock(mockName),
    SHOTS_DIR: shots,
    ...(headed ? { E2E_HEADED: "1" } : {}),
  }
  for (const [key, mock] of Object.entries(flow.extra ?? {})) env[key] = await serveMock(mock)
  const label = mockName === (flow.mock ?? "live") ? name : `${name} (${mockName} mock)`
  console.log(`\n== ${label}`)
  const result = spawnSync("node", [join(here, "..", flow.script)], {
    cwd: appDir,
    env,
    stdio: "inherit",
    // A hang guard, not a budget: a multi-case flow (panes runs seven) needs headroom on a slow
    // machine — its cases alone take ten minutes here — and a script killed here dies mid-case as
    // a closed browser.
    timeout: 1_200_000,
  })
  return result.status === 0 ? null : label
}

async function shot(path) {
  process.env.PLAYWRIGHT_MODULE = playwright()
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE)
  const app = await serveApp()
  const mock = await serveMock(polling ? "polling" : "live")
  process.env.MOCK_URL = mock
  const { launch, setUpBot } = await import("./lib.mjs")
  const browser = await launch(chromium, !headed)
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      colorScheme: dark ? "dark" : "light",
    })
    await page.goto(app)
    const profileId = await setUpBot(page)
    await page.goto(`${app}${path.replaceAll("<bot>", profileId)}`)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(1000)
    const slug = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home"
    const file = resolve(out ?? join(shots, `shot-${slug}-${width}${dark ? "-dark" : ""}.png`))
    mkdirSync(dirname(file), { recursive: true })
    await page.screenshot({ path: file, fullPage: false })
    console.log(file)
  } finally {
    await browser.close()
  }
}

/**
 * Walks the app's routes once in a throwaway browser before any flow runs. A lane that hits a cold
 * dev server competes with the other lanes for the same first module graph, requests back up, and
 * pages come up blank; warmed, the transforms are already cached. A lane's parent warms it.
 */
async function warm() {
  if (process.env.E2E_LANE) return
  process.env.PLAYWRIGHT_MODULE ??= playwright()
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE)
  const app = await serveApp()
  process.env.MOCK_URL = await serveMock(polling ? "polling" : "live")
  const { launch, setUpBot, settleNav } = await import("./lib.mjs")
  console.log("warming the app's routes")
  const browser = await launch(chromium, !headed)
  try {
    const page = await settleNav(await browser.newPage())
    await page.goto(app)
    await setUpBot(page)
    // The feature switches open the routes and the chunks the flows drive.
    await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      await db.settings.update("settings", { developer: true, meetings: true })
    })
    for (const route of ["/projects", "/code", "/routines", "/meetings", "/research", "/settings"])
      await page.goto(`${app}${route}`)
  } finally {
    await browser.close()
  }
}

/**
 * Runs one lane of a parallel sweep: this CLI again with its own lane number and mock ports, its
 * output forwarded a line at a time behind `[lane/lanes]`. Lanes share the app and stop only the
 * servers they started. Answers the lane's exit code and its captured output.
 */
function laneRun(lane, lanes, argv) {
  return new Promise((done) => {
    const forwards = [
      ...argv,
      "--shots",
      shots,
      ...(appUrl ? ["--app", appUrl] : []),
      ...(polling ? ["--polling"] : []),
      ...(keep ? ["--keep"] : []),
      ...(headed ? ["--headed"] : []),
    ]
    const child = spawn(process.execPath, [join(here, "cli.mjs"), ...forwards], {
      cwd: appDir,
      env: {
        ...process.env,
        E2E_LANE: String(lane),
        E2E_LANES: String(lanes),
        E2E_MOCK_BASE: String(MOCK_BASE + lane * 4),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    const forward = (stream) => {
      let pending = ""
      stream.on("data", (chunk) => {
        pending += chunk
        const lines = pending.split("\n")
        pending = lines.pop()
        for (const line of lines) {
          out += `${line}\n`
          console.log(`[${lane + 1}/${lanes}] ${line}`)
        }
      })
    }
    forward(child.stdout)
    forward(child.stderr)
    child.on("exit", (code) => done({ lane: lane + 1, code: code ?? 1, out }))
  })
}

process.on("SIGINT", () => {
  stopStarted()
  process.exit(130)
})

try {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_LANES)
    throw new Error(`--jobs is 1-${MAX_LANES}, not ${jobs}`)
  if (jobs > 1 && command !== "all" && !FLOWS[command])
    throw new Error("--jobs runs flows (one or more, or all), nothing else")
  if (!command || command === "help" || command === "--help") {
    console.log(HELP)
  } else if (command === "list") {
    const pad = Math.max(...Object.keys(FLOWS).map((name) => name.length))
    for (const [name, flow] of Object.entries(FLOWS)) {
      const mock = flow.mock ? ` [${flow.mock} mock]` : ""
      console.log(`${name.padEnd(pad)}  ${flow.about}${mock}`)
    }
  } else if (command === "down") {
    stopAll()
  } else if (command === "up") {
    console.log(`app  ${await serveApp()}`)
    for (const name of Object.keys(MOCKS))
      console.log(`mock ${name.padEnd(12)} ${await serveMock(name)}`)
    started.length = 0
  } else if (command === "shot") {
    if (!rest[0]?.startsWith("/")) throw new Error("shot needs a path in the app, like /code")
    await shot(rest[0])
  } else {
    const swept = command === "all" ? Object.keys(FLOWS) : [command, ...rest]
    const unknown = swept.filter((name) => !FLOWS[name])
    if (unknown.length) throw new Error(`No flow named ${unknown.join(", ")}; see pnpm e2e list`)
    // A lane runs its own slice of the sweep (round-robin over registry order) and its own mocks;
    // every lane drives the one shared app.
    const names = laneOf(
      swept,
      Number(process.env.E2E_LANES ?? 1),
      Number(process.env.E2E_LANE ?? 0),
    )
    if (jobs > 1) {
      await serveApp()
      await warm()
      const lanes = await Promise.all(
        Array.from({ length: jobs }, (_, lane) => laneRun(lane, jobs, args)),
      )
      console.log(`\nScreenshots: ${shots}\nServer logs: ${logs}`)
      const failures = lanes.flatMap((lane) =>
        [...lane.out.matchAll(/^FAILED: (.+)$/gm)].flatMap((match) => match[1].split(", ")),
      )
      const crashed = lanes.filter((lane) => lane.code !== 0 && !/^FAILED: /m.test(lane.out))
      const passed = lanes.reduce(
        (count, lane) => count + Number(lane.out.match(/^All (\d+) passed$/m)?.[1] ?? 0),
        0,
      )
      // The sweep's own rule made mechanical: a failure under lanes re-runs serially before it
      // counts. Four browsers sharing one dev server flake where one alone passes.
      const still = []
      for (const label of failures) {
        const name =
          Object.keys(FLOWS).find((key) => label === key) ??
          Object.keys(FLOWS).find((key) => label.startsWith(`${key} (`))
        const mock = name ? (/\((\S+) mock\)/.exec(label)?.[1] ?? FLOWS[name].mock ?? "live") : null
        console.log(`\n== serial re-run of ${label}`)
        if (name && (await runFlow(name, mock)) === null) {
          console.log(`passed serially, a lane flake: ${label}`)
          continue
        }
        still.push(label)
      }
      if (still.length || crashed.length) {
        if (still.length) console.log(`FAILED: ${still.join(", ")}`)
        for (const lane of crashed)
          console.log(`FAILED: lane ${lane.lane} of ${jobs} exited ${lane.code} with no summary`)
        process.exitCode = 1
      } else if (failures.length)
        console.log(`All ${passed + failures.length} passed (${failures.length} only serially)`)
      else console.log(`All ${passed} passed across ${jobs} lanes`)
    } else {
      await warm()
      const failed = []
      for (const name of names) {
        const mock = polling && !FLOWS[name].mock ? "polling" : (FLOWS[name].mock ?? "live")
        failed.push(await runFlow(name, mock))
        if (command === "all" && FLOWS[name].alsoPolling && !polling)
          failed.push(await runFlow(name, "polling"))
      }
      const failures = failed.filter(Boolean)
      console.log(`\nScreenshots: ${shots}\nServer logs: ${logs}`)
      if (failures.length) {
        console.log(`FAILED: ${failures.join(", ")}`)
        process.exitCode = 1
      } else console.log(`All ${failed.length} passed`)
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  stopStarted()
}
