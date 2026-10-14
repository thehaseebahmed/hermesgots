// Dev-only stand-in for the Hermes Agent API server (port 8642). It speaks the same wire format
// as gateway/platforms/api_server*.py: chat.completion.chunk frames plus the named SSE events
// `hermes.tool.progress`, `hermes.status` and `approval.request`, and answers approvals on
// POST /v1/runs/{id}/approval. Mention "clean" or "delete" in a message to trigger an approval.
// Cron jobs live on /api/jobs, and their past runs on GET /api/plugins/memento/cron/runs, like a
// Hermes with the Memento plugin (MOCK_NO_PLUGIN=1 leaves it out). As on Hermes, the plugin isn't
// served under /p/<profile>/ (a profile's bot reaches it at /api/plugins/memento/p/<profile>/..., where
// the chat list and the project list are the profile's own and the rest is shared), and an unknown
// route's 404 carries no CORS headers.
// The plugin also keeps the chat list (GET and POST /api/plugins/memento/chats, newer record wins) and
// labels a chat as Memento's on POST /api/plugins/memento/sessions/{id}/label. Its
// GET /api/plugins/memento/sessions/{id}/context reports a keyed session's latest model call.
// GET /api/plugins/memento/usage?provider=… serves two windows (Session + Weekly) whose
// used_percent is MOCK_USAGE_PERCENT (default 94 so the composer banner shows; 0 → no windows).
// Images the agent returns come from GET /api/plugins/memento/media?path=… (a .png path, unless it
// names something missing), and saying "image" has the agent answer with a MEDIA tag: one for the
// chart it serves and one for a file that isn't there.
// The Library tab reads a project's filed files from GET projects/{id}/library (every session's,
// merged by folder) and a session's own from GET sessions/{id}/library (the outputs pill counts
// them); tapping a file opens it from GET library/file?path=… (a .png or .md path).
// It lists Hermes Projects on GET /api/plugins/memento/projects. GET /api/plugins/memento/github and
// github/repos stand in for the host's GitHub account (MOCK_NO_GITHUB=1 leaves it signed out), and
// POST /api/plugins/memento/projects answers at once with a project that clones its repos in the
// background (1.5s each; a repo named like `fail` fails it, as does MOCK_FAIL_CLONE=1), and
// POST projects/{id}, projects/{id}/retry and projects/{id}/remove edit (name, description,
// archived, pinned), retry and delete one. POST projects/{id}/repos clones another repo in (4s; a
// name like `fail` fails it) and POST …/repos/remove takes one out (2s); GET …/usage sums made-up
// usage. While a repo is being added, a new session's workspace is refused, and a session whose repo
// was removed is refused with the reason, which the workspace also reports as `blocked`.
// Chats are titled like Hermes does: a slice of the opener at once, a "model" title a moment later,
// readable on GET /api/sessions/{id}. Sessions are keyed by X-Hermes-Session-Id when a key is sent,
// and their transcripts page back from GET /api/sessions/{id}/messages?order=latest&limit&offset.
// Say "plan" and the agent keeps a todo list with its todo_list tool as it works, which the plugin's
// GET /api/plugins/memento/sessions/{id}/todos reads back from a keyed session's transcript.
// Turns also run on POST /v1/runs, whose events replay from GET /v1/runs/{id}/events?last_seq=N and
// which keep going when the client drops, unlike a chat completion. Say "long" for a slow reply, and
// "fail" for a tool call that fails. Say "tool placement" to replay a real turn whose tool rows
// rendered in the wrong place (add "report" for the longer work-log turn):
// scripts/fixtures/tool-placement.json holds both, with the placement each call really had.
// Project sessions get a worktree in each of the project's repos on
// POST /api/plugins/memento/sessions/{id}/workspace (GET reads it back, POST …/mode changes the
// permission mode, POST …/workspace/remove removes the trees unless a turn mentioned "commit"). In
// plan mode the agent reads a little, writes a structured plan, leaves it pending and the workspace
// names the file the plugin would have saved it to (plan_file). Every session also gets a library
// folder (files_dir) the instructions tell the agent to file its generated files in, with the
// plugin's add_to_library tool. From its second turn, or one that
// says "ship", the agent opens the branch's PRs with the plugin's open_pull_request tool
// (GET …/sessions/{id}/prs reads them; "draft" in that turn drafts them): "merge" or "close" in a
// turn sets their state, a merge resolves the session in the chat list, and "break" fails their
// checks while "pending" runs them for a while before they pass. POST …/close (delete or discard)
// closes them and removes the trees like …/workspace/remove. GET /api/plugins/memento/runs/live lists the sessions with
// a run in flight, and why each one waiting on the user waits. …/sessions/{id}/queue holds what
// the app queued and starts it when the session's run ends, like plugin/outbox.py. The agent asks the user questions
// with Hermes's clarify tool, which the plugin serves on runs: say "ask" for one, or "ask five" for
// five (plan mode asks before planning), the run carries
// `clarify.request` and waits, and POST /api/plugins/memento/runs/{id}/clarify answers it.
// POST /v1/runs/{id}/steer hands a running turn more from the user: like Hermes, it lands as a
// `display_kind: "steer"` user row after the next tool result, and one still unread when the turn
// ends comes back as the run's `pending_steer`. Say "long" for a turn with a tool call every few steps.
// POST /api/plugins/memento/sessions/{id}/attachments saves an attached file under the temp dir, and a
// message that carries attachments (inline images, `<attachment>` lines) gets a reply naming them.
// POST /api/plugins/memento/dictation turns a recorded clip into a fixed sentence after a moment, like
// plugin/dictation.py with faster-whisper; MOCK_DICTATION=off reports it unavailable (the mic hides)
// and MOCK_DICTATION=fail answers every clip with an error. GET /__mock/dictation lists the clips it
// was sent (size, type, hint and the text before each), for the regression script.
// Research missions (GET and POST /api/plugins/memento/research, …/research/{id} and its actions)
// live in mock-research.mjs.
//
//   pnpm mock            # then point Settings at http://localhost:8642/v1

import http from "node:http"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { handleResearch } from "./mock-research.mjs"

// Two real turns whose tool rows rendered in the wrong place (from session exports), replayed by
// saying "tool placement plan" or "tool placement report".
const TOOL_PLACEMENT = JSON.parse(readFileSync(new URL("./fixtures/tool-placement.json", import.meta.url), "utf8"))

const PORT = Number(process.env.PORT ?? 8642)
const pendingApprovals = new Map()
const pendingClarifies = new Map()
const chatTitles = new Map()
/** Sessions the Memento plugin has labelled, which then report `source: "Memento"` (`"Memento Code"` for a project session). */
const labelledSessions = new Map()
/** The plugin's chat list: id -> { at, deleted?, value? }. */
const pluginChats = new Map()
const pluginChatLists = new Map()
/** What the plugin's hook saw last per session: one call's prompt, not the turn's sum. */
const lastCalls = new Map()
const transcripts = new Map()
let lastRowId = 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Hermes-Session-Id",
}

const GITHUB = !process.env.MOCK_NO_GITHUB
// What the media route serves for chart.png: navy sky, teal ground, a sun.
const MOCK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAABLCAIAAAA06NSGAAAAuklEQVR42u3aQQmAABBE0anhxQYW8mIDz0Y0jhFsIII4iDz4Cd5xZzNMiwoFAWjQAg0aNAXQoAX6dsc+Xwf6deI3uEO5Yx3KHetQ7liHcsc6lDvWoEF/T/mJNWjQoEGDBg0aNGjQoEGDBu3W4dYB2j0atIXFZmgFt4L76/CpBNrvHWiBBi3QoEEL9H+gx21VIdCgQQs0aNAIQIMWaNCgKYAGLdCgQVMADVqgQYMWaNACDRq0QIMW6E92AjwFRtd/9tVBAAAAAElFTkSuQmCC",
  "base64",
)
const githubRepos = [
  { full_name: "mock-user/memento", description: "A PWA companion for Hermes", private: false },
  { full_name: "mock-user/theseus", description: "A tiny maze game", private: true },
  { full_name: "mock-user/dotfiles", description: null, private: false },
  { full_name: "mock-org/zigbee-bridge", description: "Zigbee to MQTT glue", private: true },
  { full_name: "mock-user/ha-automations", description: "Home Assistant automations", private: false },
]

/** Pending projects' running clone timers, by project id. */
const cloning = new Map()
/** Clones a pending project's repos one by one (1.5s each); a repo named like `*fail*` fails it. */
function cloneProject(project, root) {
  const step = (i) => {
    if (i >= project.folders.length) {
      cloning.delete(project.id)
      project.id = `p_${randomUUID().slice(0, 8)}`
      project.status = "ready"
      project.folders = [
        { path: root, label: null, is_primary: true, git: false, repo: null, branch: null },
        ...project.folders.map((f) => ({ ...f, git: true, branch: "main", status: undefined })),
      ]
      return
    }
    const folder = project.folders[i]
    folder.status = "cloning"
    cloning.set(project.id, setTimeout(() => {
      if (process.env.MOCK_FAIL_CLONE === "1" || /fail/i.test(folder.repo)) {
        cloning.delete(project.id)
        folder.status = "failed"
        project.status = "failed"
        project.error = `GitHub refused access to ${folder.repo}.`
        for (const other of project.folders) if (other.status === "done") other.status = "queued"
        return
      }
      folder.status = "done"
      step(i + 1)
    }, 1500))
  }
  step(0)
}

/** Why a session can't take another turn, as the plugin's sessions.blocked says it. */
function blockedReason(project, record) {
  if (!project) return "This project was deleted."
  if (project.archived) return "This project is archived."
  if (!record) return null
  const current = new Set(project.folders.filter((f) => f.git).map((f) => f.path))
  const gone = record.repos.filter((r) => !current.has(r.repo_root)).map((r) => r.name)
  if (!gone.length) return null
  return `${gone.join(" and ")} ${gone.length === 1 ? "was" : "were"} removed from this project.`
}

/** Hermes Projects as projects.db holds them, with activity from the sessions in their folders. */
let projects
function mockProjects() {
  projects ??= seedProjects()
  return projects
}

function seedProjects() {
  const now = Date.now() / 1000
  const folder = (path, git = true, label = null) => ({
    path,
    label,
    is_primary: false,
    git,
    // As the plugin reads it from the clone's GitHub origin.
    repo: git ? `${path.includes("zigbee") ? "mock-org" : "mock-user"}/${path.split("/").at(-1)}` : null,
    // The branch a session's worktree starts from.
    branch: git ? "main" : null,
  })
  return [
    {
      id: "p_1a2b3c4d",
      slug: "memento",
      name: "Memento",
      description: null,
      created_at: now - 40 * 86_400,
      last_active: now - 15 * 60,
      folders: [{ ...folder("/home/hermes/code/memento"), is_primary: true }],
    },
    {
      id: "p_5e6f7a8b",
      slug: "theseus",
      name: "theseus",
      description: "A tiny maze game for the phone, written over lunch breaks",
      created_at: now - 20 * 86_400,
      last_active: now - 3 * 3_600,
      folders: [{ ...folder("/home/hermes/code/theseus"), is_primary: true }],
    },
    {
      id: "p_9c0d1e2f",
      slug: "smart-home",
      name: "Smart Home",
      description: null,
      created_at: now - 300 * 86_400,
      last_active: now - 120 * 86_400,
      folders: [
        { ...folder("/home/hermes/code/ha-config"), is_primary: true },
        folder("/home/hermes/code/zigbee-bridge", true, "bridge"),
        folder("/home/hermes/notes/home", false),
      ],
    },
    {
      id: "p_3a4b5c6d",
      slug: "french",
      name: "French",
      description: null,
      created_at: now - 80 * 86_400,
      last_active: null,
      folders: [{ ...folder("/home/hermes/notes/french", false), is_primary: true }],
    },
  ]
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...cors })
  res.end(JSON.stringify(body))
}

/** Like Hermes's transcript: a message's text parts, with each inline image as `[screenshot]`. */
function durable(content) {
  if (!Array.isArray(content)) return String(content ?? "")
  return content
    .map((part) => (part?.type === "text" ? part.text : part?.type === "image_url" ? "[screenshot]" : null))
    .filter((part) => part != null)
    .join("\n")
}

async function readRaw(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function readBody(req) {
  let raw = ""
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

// Cron: per profile, three jobs with a run history. Runs are { start, end, ok, provider } in ms.
const cronByProfile = new Map()
const MINUTE = 60_000
function cronJobs(profile = "default") {
  if (cronByProfile.has(profile)) return cronByProfile.get(profile)
  const seed = [...profile].reduce((n, c) => n + c.charCodeAt(0), 0)
  // `schedule` is a cron expression, else the job runs every `every` minutes.
  const make = (n, name, schedule, every, { paused = false, streak = 0, history = 30 } = {}) => {
    const now = Date.now()
    const runs = Array.from({ length: history }, (_, i) => {
      // The latest run was a third of a period ago, so the next one is still ahead.
      const start = now - (history - i - 0.67) * every * MINUTE
      const failed = i >= history - streak || (i * 7 + seed) % 11 === 0
      const end = start + 20_000 + ((i * 13) % 50) * 1000
      return { start, end, ok: !failed, provider: failed && i % 2 === 0 }
    })
    return { id: `${seed.toString(16)}a${n}c0ffee`.slice(0, 12), name, schedule, every, paused, runs }
  }
  const jobs = [
    make(1, "Inbox triage", null, 60),
    make(2, "Uptime check", null, 15, { streak: 2 }),
    make(3, "Morning digest", "0 8 * * *", 1440, { paused: true, history: 9 }),
    make(4, "Standup notes", "30 9 * * 1-5", 1440, { history: 12 }),
  ]
  cronByProfile.set(profile, jobs)
  return jobs
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null)

function jobRecord(job) {
  const last = job.runs.at(-1)
  const lastDone = job.runs.findLast((run) => run.end)
  let streak = 0
  for (const run of [...job.runs].reverse()) {
    if (!run.end) continue
    if (run.ok) break
    streak += 1
  }
  return {
    id: job.id,
    name: job.name,
    // As Hermes's parse_schedule stores it.
    schedule: job.schedule
      ? { kind: "cron", expr: job.schedule, display: job.schedule }
      : { kind: "interval", minutes: job.every, display: `every ${job.every}m` },
    schedule_display: job.schedule ?? `every ${job.every}m`,
    enabled: !job.paused,
    state: job.paused ? "paused" : last && !last.end ? "running" : "scheduled",
    next_run_at: job.paused ? null : iso((last?.start ?? Date.now()) + job.every * MINUTE),
    last_run_at: iso(lastDone?.end),
    last_status: lastDone ? (lastDone.ok ? "ok" : "error") : null,
    last_error: lastDone && !lastDone.ok ? RUN_ERROR : null,
    failure_streak: streak,
    latest_execution: last && {
      status: !last.end ? "running" : last.ok ? "completed" : "failed",
      claimed_at: iso(last.start - 500),
      started_at: iso(last.start),
      finished_at: iso(last.end),
      error: last.end && !last.ok ? RUN_ERROR : null,
    },
  }
}

const PLUGIN = process.env.MOCK_NO_PLUGIN !== "1"
// Research missions (mock-research.mjs); MOCK_RESEARCH=0 serves a plugin without them, and
// MOCK_RESEARCH_WRITERS=off a host that doesn't let a mission be rewritten with another model.
const RESEARCH = process.env.MOCK_RESEARCH !== "0"
const RESEARCH_WRITERS = process.env.MOCK_RESEARCH_WRITERS !== "off"

/** How long a pull request's checks run after a turn says "pending", before they pass. */
const PENDING_CHECK_S = 12

/** Project sessions as the plugin's memento.db holds them, by Hermes session id. */
const projectSessions = new Map()
// The plugin's pull request instruction (prompt_builder._PR_INSTRUCTIONS), word for word.
const PR_INSTRUCTIONS = "When the work is done and you've checked it, ship it yourself with the open_pull_request tool: it commits what's left, pushes this branch and opens a pull request, or updates the open one. Don't ask first, and don't use git push or gh for it. Write the description from the repo's pull request template when it has one (named below), else with Summary, Changes and How to test sections."
// The plugin's done-work emphasis (prompt_builder._DONE_INSTRUCTIONS), word for word.
const DONE_INSTRUCTIONS = "Two things the run's prompt emphasises once the work is done: don't share the pull request url or the commit message in your reply — the open_pull_request result and the session's pull request list already surface them where the user sees them. And before you finish, update your todo list to its final state: every item completed, or cancelled where it was dropped."
// Theseus runs in Auto with the skill's gates on top, and keeps its mode for the whole session.
const MODES = ["accept_edits", "auto", "plan", "theseus"]
// The plugin's Theseus instructions (theseus.INSTRUCTIONS), shortened: the paths are the host's.
const THESEUS_INSTRUCTIONS = "This session is a Theseus run: the user decides, you build in small checkpoints that each pass four gates. Follow the tha-theseus skill. Reviews (coverage, gates 2 and 3) are done by the theseus_review tool, which asks another model and records its verdict itself."
// MOCK_THESEUS=<stage> starts every Theseus run there; MOCK_THESEUS=unavailable says the host has no Node.
let THESEUS_START = process.env.MOCK_THESEUS ?? "discovery"
const theseusRuns = new Map()
const THESEUS_STAGES = ["discovery", "planning", "plan", "checkpoints", "building", "approval", "closing", "done"]

const theseusPass = (extra = {}) => ({ red: "pass", tests: "pass", visual: "pass", review: "pass", ...extra })
const theseusCheckpoints = (stage) => {
  const base = [
    { id: "CP1", title: "Schedules in words become Hermes schedules", done: "'weekdays at 9:30' and 'every 15 minutes' map to Hermes's cron and interval shapes", ui: false, tests: ["weekdays at 9:30 becomes cron 30 9 * * 1-5", "every 15 minutes becomes an interval of 15", "an unknown phrase is refused with a message"] },
    { id: "CP2", title: "Creating a routine through Hermes", done: "a valid routine is created, and Hermes's refusal comes back as its message", ui: false, tests: ["a valid routine is posted and returned with its id", "a 400 from Hermes surfaces its error text", "a 501 reads as cron not available"] },
    { id: "CP3", title: "Routine editor, empty and error states", done: "the pop-up matches the mock when empty and when Hermes refuses the schedule", ui: true, tests: ["the form opens empty, Save disabled", "a refused schedule shows Hermes's message under the field", "Save is enabled once name, prompt and schedule are filled"] },
    { id: "CP4", title: "Editing an existing routine", done: "a routine opens filled in, and saving keeps its run history", ui: true, tests: ["the form opens with the routine's values", "saving keeps last_run_at and runs"] },
    { id: "CP5", title: "Pause, resume and delete in the editor", done: "each action updates the list at once and survives a reload", ui: true, tests: ["pause shows Paused", "delete asks first, then removes the row"] },
    { id: "CP6", title: "New routines in the Routines list", done: "a new routine shows its schedule in words and its next run", ui: true, tests: ["the new row reads 'Weekdays at 9:30 AM'"] },
  ]
  const item = (reviewer, round, items, via) => ({ reviewer, round, findings: items.length, isolation: "model", via, verdict: items.length ? "FINDINGS" : "PASS", summary: items.length ? "One thing to fix." : "Nothing to fix.", items })
  const finding = { text: "routine-editor.tsx:48", where: "routine-editor.tsx:48", what: "The schedule error is cleared on every keystroke, before Hermes answers.", rule: "Keep the server's message until the next answer replaces it", fix: "Clear it when the next validation returns." }
  const tests = { cmd: "pnpm test", exit: 0, passed: true, tail: "✓ routine-editor.test.tsx (3)\n\nTest Files  1 passed (1)\n     Tests  3 passed (3)" }
  if (["discovery", "planning", "plan"].includes(stage)) return []
  if (stage === "checkpoints") return base.map((cp) => ({ ...cp, status: "pending", approved: false, gates: null, evidence: {}, screenshots: [] }))
  const done = (cp) => ({ ...cp, status: "done", approved: true, gates: null, evidence: { tests, ...(cp.ui ? {} : { visual: { skip: { reason: "No screen changed." } } }) }, screenshots: [] })
  const three = {
    ...base[2],
    approved: true,
    screenshots: ["reference.svg", "build.svg"],
  }
  const reviews = (rounds) => ({ reviewers: {}, history: rounds })
  if (stage === "building")
    return [done(base[0]), done(base[1]), { ...three, status: "building", gates: { ...theseusPass(), review: "findings" }, evidence: { tests, review: reviews([item("a", 1, [finding], "anthropic/claude-opus-5-5"), item("b", 1, [], "openai/gpt-5")]) } }, ...base.slice(3).map((cp) => ({ ...cp, status: "pending", approved: true, gates: null, evidence: {}, screenshots: [] }))]
  if (stage === "approval")
    return [done(base[0]), done(base[1]), { ...three, status: "awaiting-approval", gates: theseusPass(), evidence: { tests, review: reviews([item("a", 1, [finding], "anthropic/claude-opus-5-5"), item("b", 1, [], "openai/gpt-5"), item("a", 2, [], "anthropic/claude-opus-5-5"), item("b", 2, [], "openai/gpt-5")]) } }, ...base.slice(3).map((cp) => ({ ...cp, status: "pending", approved: true, gates: null, evidence: {}, screenshots: [] }))]
  return base.map((cp) => done(cp))
}

const THESEUS_PLAN = {
  task: "Create and edit routines from the Routines screen",
  goal: "Routines can be made and changed in the app, not only on the Hermes host.",
  acceptance_criteria: ["A new routine with a name, prompt and schedule appears in the list and runs on time", "Editing a routine keeps its run history", "A schedule Hermes can't parse is refused with Hermes's own message"],
  scope_boundaries: ["Delivery targets other than the chat", "Routine templates"],
  user_proposed_approach: "A form in a pop-up, posting to Hermes's jobs API.",
  recommended_approach: "The same pop-up, with the schedule typed in words and shown back as Hermes reads it, through POST /api/jobs and PATCH /api/jobs/{id}.",
  approach_rationale: "Hermes already validates schedules, so the app shows its answer rather than parsing cron itself.",
  rejected_alternatives: [{ alternative: "A cron expression field", reason: "Most routines are 'every weekday at 9', which words say better." }],
  verification: { automated: [{ prerequisites: "none", action: "pnpm test routines", expected: "every case passes" }], manual: [{ prerequisites: "the app running", action: "Make a routine for two minutes from now", expected: "it runs, and its run shows in the list" }] },
}

const theseusOptions = () => ({
  autonomy: { label: "approve", options: [{ value: "step" }, { value: "batch:3" }, { value: "unattended" }] },
  visual: { label: "visual", options: [{ value: "on" }, { value: "off" }] },
  reviewers: { label: "code reviewers", options: [{ value: "2" }, { value: "1" }, { value: "0" }] },
})

const theseusNext = {
  discovery: "finish requirements discovery in chat (task, behaviour, approach and open decisions), then: theseus.js plan --file F",
  planning: "load the checkpoints: theseus.js checkpoints --file F",
  plan: "human confirms the requirements plan in the viewer; agent runs: theseus.js wait",
  checkpoints: "human approves the plan (CP1, CP2, CP3, CP4, CP5, CP6) in the viewer; agent runs: theseus.js wait",
  building: "gate 3 for CP3: two isolated reviewers",
  approval: "human approves CP3 in the viewer; agent runs: theseus.js wait",
  closing: "human confirms the run complete in the viewer (or keeps it open); agent runs: theseus.js wait",
  done: "run routine-editor is completed — nothing left to do; it stays in History",
}

function theseusRecord(id) {
  let run = theseusRuns.get(id)
  if (!run) {
    run = { stage: THESEUS_STAGES.includes(THESEUS_START) ? THESEUS_START : "discovery", settings: { autonomy: "step", visual: "on", reviewers: "2", granularity: "s-m" }, models: { review: [], visual: [] } }
    theseusRuns.set(id, run)
  }
  return run
}

function theseusView(id) {
  const run = theseusRecord(id)
  const stage = run.stage
  const checkpoints = theseusCheckpoints(stage)
  const status = stage === "closing" ? "completing" : stage === "done" ? "completed" : "open"
  const plan = ["discovery"].includes(stage) ? undefined : { ...THESEUS_PLAN, status: stage === "plan" ? "pending" : "confirmed" }
  return {
    object: "memento.theseus",
    stage,
    models: run.models,
    unavailable: THESEUS_START === "unavailable" ? "Theseus needs Node 20 or newer on the Hermes host, and there is none." : null,
    state: {
      run: { key: "routine-editor", reference: "docs/routine-mock.html", testCmd: "pnpm test", status, planRequired: true, ...run.settings, plan },
      settings: { ...run.settings, options: theseusOptions() },
      checkpoints,
      next: theseusNext[stage],
      learnings: stage === "discovery" || stage === "planning" || stage === "plan" ? [] : [{ source: "human", text: "Show Hermes's own error text; never rephrase a server refusal.", cp: null }, ...(["building", "approval", "closing", "done"].includes(stage) ? [{ source: "reviewer", cp: "CP3", text: "Keep a server's validation message until the next answer replaces it." }] : [])],
      feedback: [],
      log: [],
      runs: [],
    },
  }
}

// The sessions each session delegated to with delegate_task (the plugin reads them from state.db),
// each a transcript of its own at GET /api/sessions/{id}/messages.
const delegations = new Map()

/** A delegated agent at work: its transcript grows a step every 1.2s, then it reports back. */
async function runDelegation(parent, goal, out) {
  const id = `${parent}-agent-${(delegations.get(parent)?.length ?? 0) + 1}`
  const agent = { id, goal, model: "claude-opus-5-5", started_at: Date.now() / 1000, ended_at: null, end_reason: null, tool_calls: 0, status: "running" }
  delegations.set(parent, [...(delegations.get(parent) ?? []), agent])
  const rows = []
  transcripts.set(id, rows)
  const add = (row) => rows.push({ id: ++lastRowId, session_id: id, timestamp: Date.now() / 1000, ...row })
  add({ role: "user", content: goal })
  noteEvent("runs")
  const steps = [
    ["terminal", { command: "du -sh /var/log/* | sort -rh | head -5" }, JSON.stringify({ output: "2.1G\t/var/log/journal\n410M\t/var/log/nginx", exit_code: 0 })],
    ["read_file", { path: "/etc/systemd/journald.conf" }, JSON.stringify({ content: "[Journal]\n#SystemMaxUse=" })],
    ["search_files", { pattern: "SystemMaxUse", path: "/etc" }, JSON.stringify({ matches: ["/etc/systemd/journald.conf:3"] })],
    ["terminal", { command: "journalctl --disk-usage" }, JSON.stringify({ output: "Archived and active journals take up 2.0G", exit_code: 0 })],
  ]
  for (const [i, [tool, args, result]] of steps.entries()) {
    if (out.closed()) break
    const call = `${id}-call-${i}`
    add({ role: "assistant", content: i === 0 ? "Measuring the folders first." : null, tool_calls: [{ id: call, function: { name: tool, arguments: JSON.stringify(args) } }] })
    await sleep(1200)
    add({ role: "tool", tool_call_id: call, tool_name: tool, content: result })
    agent.tool_calls += 1
  }
  const report = "The journal takes 2.0G of the 2.5G: journald has no SystemMaxUse cap. nginx is next with 410M."
  if (!out.closed()) add({ role: "assistant", content: report })
  Object.assign(agent, { ended_at: Date.now() / 1000, end_reason: out.closed() ? "interrupted" : "agent_close", status: out.closed() ? "stopped" : "done" })
  noteEvent("runs")
  return report
}

// A wireframe for a gate 2 capture; the reference is dashed, the build is solid.
const theseusCapture = (reference) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="#fff"/><rect x="1" y="1" width="298" height="398" fill="none" stroke="#888" ${reference ? 'stroke-dasharray="6 4"' : ""}/><rect x="24" y="28" width="130" height="12" rx="6" fill="#333"/><rect x="24" y="68" width="252" height="34" rx="10" fill="none" stroke="#999"/><rect x="24" y="116" width="252" height="68" rx="10" fill="none" stroke="#999"/><rect x="24" y="198" width="252" height="34" rx="10" fill="none" stroke="#d33"/><rect x="24" y="242" width="170" height="8" rx="4" fill="#d33"/><rect x="170" y="344" width="106" height="34" rx="17" fill="#7a8cff"/></svg>`

// The plugin's plan-mode instructions (prompt_builder._PLAN_INSTRUCTIONS), word for word.
const PLAN_INSTRUCTIONS = `You are in plan mode: change nothing. Read what you need. Then, before you write the plan, settle every choice the user would otherwise be left to make: ask with the clarify tool, every question in one call, your recommended answer first. If you can't ask (no clarify tool, or no answer came), decide it yourself and record the decision under Risks and assumptions. Then make your whole final reply the plan below and stop; the user approves it before you act. It is saved to a file as written, so write it for someone who hasn't read this chat, and a plan with an open question isn't finished. Use this Markdown shape exactly:

# Plan: <short title>

## Overview
What was asked, the problem it solves and the outcome, in two to five sentences.

## Approach
The design you chose and why. One line each for the alternatives you rejected.

## Changes
One entry per file or area: its path, what changes and why, and the existing functions you'd reuse.

## Checkpoints
Split the work into checkpoints that each leave the code building and worth committing, in order. For each:
### Checkpoint N: <name>
- Commit: \`type(scope): summary\` in Conventional Commits form, unless the user asked for another style
- Steps: the concrete edits
- Done when: how you'd know it works

## Verification
How to test the whole change end to end: commands, what to look at, expected results.

## Risks and assumptions
What could go wrong, and each decision you made without the user: what you chose and why. Nothing here is left for the user to decide.`
const userTurns = (sessionId) => (transcripts.get(sessionId) ?? []).filter((r) => r.role === "user")
// A session's filed files as the plugin's library routes would list them: in-memory stand-ins,
// newest first within each folder, so the Library tab and the outputs pill have something to show.
const sessionLibrary = (record) => {
  const worktree = record.files_dir.split("/").pop()
  const at = (minutesAgo) => Date.now() - minutesAgo * 60_000
  const file = (folder, name, size, minutesAgo) => ({
    worktree,
    folder,
    name,
    path: `${record.files_dir}/${folder}/${name}`,
    size,
    at: at(minutesAgo),
  })
  return [
    {
      name: "library-tab",
      files: [
        file("library-tab", "dashboard-light.png", 20480, 4),
        file("library-tab", "dashboard-dark.png", 19456, 2),
      ],
    },
    {
      name: "log-cleanup",
      files: [file("log-cleanup", "cleanup-report.md", 1843, 9)],
    },
  ]
}
// Every session's files in one project, merged by folder, as the plugin's project route walks it.
const projectLibrary = (projectId) => {
  const folders = new Map()
  for (const record of projectSessions.values()) {
    if (record.project_id !== projectId) continue
    for (const folder of sessionLibrary(record)) {
      folders.set(folder.name, [...(folders.get(folder.name) ?? []), ...folder.files])
    }
  }
  return [...folders.entries()]
    .map(([name, files]) => ({ name, files: files.sort((a, b) => b.at - a.at) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
const RUN_ERROR = "Timed out waiting for https://status.example.com"

/** A run as a row of Hermes's cron execution ledger. */
function ledgerRow(job, run) {
  return {
    id: `${job.id}-${run.start}`,
    job_id: job.id,
    source: "schedule",
    status: !run.end ? "running" : run.ok ? "completed" : "failed",
    claimed_at: iso(run.start - 500),
    started_at: iso(run.start),
    finished_at: iso(run.end),
    error: run.end && !run.ok ? (run.provider ? "The model provider didn't respond." : RUN_ERROR) : null,
    delivery_outcome: run.ok ? "delivered" : null,
  }
}

function titleChat(req, opener) {
  const sessionId = sessionOf(req)
  if (!sessionId || !req.headers.authorization || chatTitles.has(sessionId)) return
  const line = opener.trim().split("\n")[0]
  chatTitles.set(sessionId, line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line)
  const words = line.replace(/[^\p{L}\p{N}\s-]/gu, "").split(/\s+/).filter(Boolean).slice(0, 4)
  const title = words.length > 1 ? words.join(" ").replace(/^./, (c) => c.toUpperCase()) : "Friendly greeting"
  setTimeout(() => {
    chatTitles.set(sessionId, title)
    noteEvent("title", sessionId)
  }, 2000)
}

// A running turn's steer delivery by session, which Hermes makes after each tool result.
const steerPoints = new Map()

/** Stores a transcript row the way Hermes's session DB does, for keyed sessions only. */
function record(req, row) {
  const sessionId = sessionOf(req)
  if (!sessionId || !req.headers.authorization) return
  if (!transcripts.has(sessionId)) transcripts.set(sessionId, [])
  transcripts.get(sessionId).push({ id: ++lastRowId, session_id: sessionId, timestamp: Date.now() / 1000, ...row })
  if (row.role === "tool") steerPoints.get(sessionId)?.()
}

const STEER_OPEN = "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]"
const STEER_CLOSE = "[/OUT-OF-BAND USER MESSAGE]"

/** Hermes pages `latest` back from the newest row but returns each page oldest first. */
function pageRows(rows, params) {
  const limit = Math.min(Number(params.get("limit") ?? 500), 500)
  const offset = Number(params.get("offset") ?? 0)
  return params.get("order") === "oldest"
    ? rows.slice(offset, offset + limit)
    : rows.slice().reverse().slice(offset, offset + limit).reverse()
}

/**
 * The scripted turn behind both endpoints. `out` sends it over the wire: `say` streams a piece of the
 * reply, `status` a status line, `tool` a tool's progress, and `approve` asks and resolves to a choice.
 */
async function playTurn(req, body, last, out) {
  let pieces = 0
  let spoken = ""
  titleChat(req, last)
  record(req, { role: "user", content: last })
  const say = async (text, pace = 25) => {
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
      if (out.closed()) return
      pieces += 1
      spoken += piece
      out.say(piece)
      await sleep(pace)
    }
  }

  out.status("Thinking…")
  await sleep(500)

  // Hermes's clarify tool: a tool call whose result is the user's answers, which the plugin shows
  // on runs; a chat completion can't show it and the result says so.
  const ask = async (questions) => {
    const id = `call_${randomUUID().slice(0, 8)}`
    out.tool({ tool: "clarify", emoji: "❓", label: questions[0].question, toolCallId: id, status: "running" })
    record(req, { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "clarify", arguments: JSON.stringify({ questions }) } }] })
    const { answers, outcome } = await out.ask(questions.map((q, i) => ({ id: `q${i}`, ...q })))
    const result = JSON.stringify({
      responses: questions.map((q, i) => {
        const answer = answers[`q${i}`]
        return { question: q.question, choices_offered: q.choices ?? null, status: answer ? "answered" : outcome === "submitted" ? "skipped" : "unanswered", user_response: answer ?? null }
      }),
      outcome,
      ...(outcome === "undelivered" ? { notice: "This client can't show questions on this turn; ask in your reply instead." } : {}),
    })
    out.tool({ tool: "clarify", toolCallId: id, status: "completed", result })
    record(req, { role: "tool", tool_call_id: id, tool_name: "clarify", content: result })
    return { answers, outcome }
  }

  // In plan mode the plugin blocks every tool that changes anything, so the agent reads and plans.
  const workspace = projectSessions.get(sessionOf(req, body))
  if (workspace) workspace.plan_pending = 0
  // A Theseus agent that has settled the requirements submits the plan and waits for the user.
  if (workspace?.mode === "theseus" && theseusRecord(workspace.session_id).stage === "discovery") theseusRecord(workspace.session_id).stage = "plan"
  if (workspace?.mode === "plan") {
    // Read-only calls, on the stream and in the transcript: what a client without the stream polls.
    const reads = [
      ["terminal", "💻", { command: "git log --oneline -5" }, JSON.stringify({ output: "4f69069 style(chat): keep the pills on one line\n17189b0 feat(chat): sessions span every repo", exit_code: 0, error: null })],
      ["read_file", "📄", { path: "scripts/rotate-logs.sh" }, "#!/bin/sh\nfind /var/log -name '*.gz' -mtime +14 -delete\n"],
    ]
    for (const [tool, emoji, args, result] of reads) {
      if (out.closed()) break
      const id = `call_${randomUUID().slice(0, 8)}`
      out.tool({ tool, emoji, label: Object.values(args)[0], toolCallId: id, status: "running" })
      record(req, { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] })
      await sleep(1500)
      out.tool({ tool, toolCallId: id, status: "completed", result })
      record(req, { role: "tool", tool_call_id: id, tool_name: tool, content: result })
    }
    // The instructions ask the agent to settle every open choice before it writes the plan.
    const { answers, outcome } = await ask([
      { question: "What should `--dry-run` print?", choices: ["Each file it would delete", "Only a count and the total size"] },
      { question: "Anything the rotation must keep, whatever its age?" },
    ])
    const counts = answers.q0 === "Only a count and the total size"
    const keep = answers.q1 ? `You asked to keep ${answers.q1}, so the dry run flags any such file it finds.` : ""
    const assumption = outcome === "submitted"
      ? `You chose ${counts ? "a count and the total size" : "a list of each file"} for the dry run's output. ${keep}`.trim()
      : "No answer came for what the dry run should print, so it lists each file: that is what a cron log needs to be checked against."
    await say(
      "# Plan: Add a dry run to log rotation\n\n" +
        "## Overview\nRotation deletes old logs with no way to preview what goes. A `--dry-run` flag lists the files it would remove, so the cron job can be checked before it runs for real.\n\n" +
        "## Approach\nAdd the flag to the existing script rather than a second script, so both paths share one `find` expression. A separate preview script was rejected: the two would drift.\n\n" +
        "## Changes\n- `scripts/rotate-logs.sh`: parse `--dry-run`; print instead of `-delete` when set.\n- `tests/rotate-logs.bats`: a case for each path.\n- `README.md`: document the flag.\n\n" +
        "## Checkpoints\n### Checkpoint 1: The flag\n- Commit: `feat(rotate): add a --dry-run flag that lists what would go`\n- Steps: parse the flag; switch `-delete` for " + (counts ? "a count and `du -ch`" : "`-print`") + " when set.\n- Done when: `./rotate-logs.sh --dry-run` lists files and deletes nothing.\n\n" +
        "### Checkpoint 2: Tests and docs\n- Commit: `test(rotate): cover --dry-run and document it`\n- Steps: add the bats cases; a README paragraph.\n- Done when: `bats tests/` passes.\n\n" +
        "## Verification\nRun `bats tests/`, then `./rotate-logs.sh --dry-run` against a folder with an old `.gz`: it's listed and still there.\n\n" +
        `## Risks and assumptions\n${assumption} None of the callers pass flags today, so nothing else changes.`,
    )
    if (!out.closed()) {
      workspace.plan_pending = 1
      // The plugin saves the reply as plans/<branch slug>-<stamp>.md under the project's folder.
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
      workspace.plan_file = `plans/${workspace.branch.replace(/^hermes\//, "")}-${stamp}.md`
    }
    record(req, { role: "assistant", content: spoken, finish_reason: "stop" })
    return { spoken, prompt_tokens: 6000, completion_tokens: pieces }
  }

  // "delegate": the agent hands the digging to a delegated agent (delegate_task), whose own session
  // the plugin lists for the chat's agent card.
  if (/delegat/i.test(last) && sessionOf(req, body)) {
    const goal = "Find what fills /var/log on this host and say which setting would cap it."
    const id = `call_${randomUUID().slice(0, 8)}`
    out.tool({ tool: "delegate_task", emoji: "🔀", label: goal, toolCallId: id, status: "running" })
    record(req, { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ goal }) } }] })
    const report = await runDelegation(sessionOf(req, body), goal, out)
    const result = JSON.stringify({ results: [{ status: "completed", summary: report }] })
    out.tool({ tool: "delegate_task", toolCallId: id, status: "completed", result })
    record(req, { role: "tool", tool_call_id: id, tool_name: "delegate_task", content: result })
    await say(`The delegated agent looked into it. ${report} Setting \`SystemMaxUse=500M\` in journald.conf would cap it.`)
    record(req, { role: "assistant", content: spoken, finish_reason: "stop" })
    return { spoken, prompt_tokens: 5200, completion_tokens: pieces }
  }

  // The tool-placement replay: one assistant row per step (its text beside its calls, as the session
  // exports carry them) and the run's `output` the final message only, like Hermes's `final_response`
  // — the shape whose settle scattered tool rows into the reply. It runs nothing else, so the thread
  // holds exactly the exported turn.
  const placement = /tool placement/i.test(last)
    ? TOOL_PLACEMENT[/\breport\b/i.test(last) ? "report" : "plan"]
    : undefined
  if (placement) {
    for (const step of placement.steps) {
      if (out.closed()) break
      if (step.text) await say(spoken ? `\n\n${step.text}` : step.text, 5)
      const calls = step.tools.map((tool) => ({
        id: `call_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: { name: tool.tool, arguments: JSON.stringify(tool.args) },
      }))
      if (step.text || calls.length)
        record(req, { role: "assistant", content: step.text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      for (const [i, tool] of step.tools.entries()) {
        const id = calls[i].id
        out.tool({ tool: tool.tool, emoji: "🧰", label: tool.label, toolCallId: id, status: "running" })
        await sleep(150)
        const result = JSON.stringify(tool.result)
        out.tool({ tool: tool.tool, toolCallId: id, status: "completed", result })
        record(req, { role: "tool", tool_call_id: id, tool_name: tool.tool, content: result })
      }
    }
    if (!out.closed())
      record(req, { role: "assistant", content: placement.output, finish_reason: "stop" })
    return {
      spoken,
      output: out.closed() ? spoken : placement.output,
      prompt_tokens: 4000 + Math.round(spoken.length / 4),
      completion_tokens: pieces,
    }
  }

  // Like Hermes's todo_list: every call returns the whole list, and the result is a transcript row.
  const planned = /plan/i.test(last)
  // Hermes restores the list's revision from the transcript, so it keeps counting across turns.
  const lastTodos = (transcripts.get(sessionOf(req)) ?? []).findLast((r) => r.tool_name === "todo_list")
  let todoRevision = lastTodos ? JSON.parse(lastTodos.content).revision : 0
  const steps = ["Check disk use under /var/log", "Read the log rotation script", "Summarise where the space goes"]
  const writeTodos = async (done) => {
    if (!planned || out.closed()) return
    const todos = steps.map((content, i) => ({
      id: String(i + 1),
      content,
      status: i < done ? "completed" : i === done ? "in_progress" : "pending",
    }))
    const id = `call_${randomUUID().slice(0, 8)}`
    const result = JSON.stringify({ todos, revision: ++todoRevision, summary: { total: todos.length } })
    // Hermes's preview for the call (agent/display.py's _preview_todo_list).
    out.tool({ tool: "todo_list", emoji: "📋", label: `planning ${todos.length} task(s)`, toolCallId: id, status: "running" })
    await sleep(300)
    // The run stream's preview is cut at 500 characters, as on Hermes.
    out.tool({ tool: "todo_list", toolCallId: id, status: "completed", result: result.length > 500 ? `${result.slice(0, 497)}...` : result })
    record(req, { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "todo_list", arguments: JSON.stringify({ todos }) } }] })
    record(req, { role: "tool", tool_call_id: id, tool_name: "todo_list", content: result })
  }
  await writeTodos(0)

  const toolCallId = `call_${randomUUID().slice(0, 8)}`
  out.tool({ tool: "terminal", emoji: "💻", label: "du -sh /var/log/* | sort -rh | head", toolCallId, status: "running" })
  await sleep(1400)
  // Hermes's terminal tool returns a JSON envelope.
  // Long enough that the run stream's preview is cut, as Hermes cuts it at 500 characters.
  const logs = ["nginx", "postgres", "app", "journal", "apt", "installer", "unattended-upgrades", "dist-upgrade", "cups", "private", "redis", "mysql", "letsencrypt", "sysstat", "landscape", "fontconfig.log", "dpkg.log", "auth.log", "kern.log", "syslog", "btmp", "wtmp", "lastlog", "faillog"]
  const duOutput = JSON.stringify({ output: logs.map((name, i) => `${(2100 / (i + 1)).toFixed(1)}M\t/var/log/${name}`).join("\n"), exit_code: 0, error: null })
  out.tool({ tool: "terminal", toolCallId, status: "completed", result: duOutput.length > 500 ? `${duOutput.slice(0, 497)}...` : duOutput })
  record(req, { role: "assistant", content: null, tool_calls: [{ id: toolCallId, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "du -sh /var/log/* | sort -rh | head" }) } }] })
  record(req, { role: "tool", tool_call_id: toolCallId, tool_name: "terminal", content: duOutput })
  await writeTodos(1)

  const readId = `call_${randomUUID().slice(0, 8)}`
  const readPath = "/etc/logrotate.d/rotate.py"
  out.tool({ tool: "read_file", emoji: "📖", label: readPath, toolCallId: readId, status: "running" })
  await sleep(400)
  const source = [
    "import gzip, shutil",
    "from pathlib import Path",
    "",
    "def rotate(path: Path, keep: int = 7) -> None:",
    "    # Compress yesterday's log and drop the oldest.",
    '    with path.open("rb") as src, gzip.open(f"{path}.1.gz", "wb") as dst:',
    "        shutil.copyfileobj(src, dst)",
    "    for old in sorted(path.parent.glob(f\"{path.name}.*.gz\"))[keep:]:",
    "        old.unlink()",
    "",
    ...Array.from({ length: 6 }, (_, n) => [
      `def prune_${n}(root: Path, days: int = ${(n + 1) * 30}) -> list[Path]:`,
      `    """Remove logs older than ${(n + 1) * 30} days under root, returning what was deleted so the caller can report it."""`,
      "    cutoff = time.time() - days * 86400",
      "    removed = [p for p in root.rglob('*.gz') if p.stat().st_mtime < cutoff]",
      "    for p in removed:",
      "        p.unlink()",
      "    return removed",
      "",
    ]).flat(),
  ].map((line, i) => `${i + 1}|${line}`).join("\n")
  const readOutput = JSON.stringify({ content: source, total_lines: source.split("\n").length, file_size: 312, truncated: false })
  out.tool({ tool: "read_file", toolCallId: readId, status: "completed", result: readOutput })
  record(req, { role: "assistant", content: null, tool_calls: [{ id: readId, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: readPath }) } }] })
  record(req, { role: "tool", tool_call_id: readId, tool_name: "read_file", content: readOutput })
  await writeTodos(2)

  // A search, a patch and a new file, so the group's mixed title and diff badges show up.
  const searchId = `call_${randomUUID().slice(0, 8)}`
  out.tool({ tool: "search_files", emoji: "🔎", label: "def rotate", toolCallId: searchId, status: "running" })
  await sleep(300)
  const searchOutput = JSON.stringify({ matches: [{ path: "/etc/logrotate.d/rotate.py", line: 4 }] })
  out.tool({ tool: "search_files", toolCallId: searchId, status: "completed", result: searchOutput })
  record(req, { role: "assistant", content: null, tool_calls: [{ id: searchId, type: "function", function: { name: "search_files", arguments: JSON.stringify({ pattern: "def rotate" }) } }] })
  record(req, { role: "tool", tool_call_id: searchId, tool_name: "search_files", content: searchOutput })

  const patchId = `call_${randomUUID().slice(0, 8)}`
  out.tool({ tool: "patch", emoji: "🔧", label: readPath, toolCallId: patchId, status: "running" })
  await sleep(300)
  const patchOutput = JSON.stringify({
    success: true,
    diff: `--- a${readPath}\n+++ b${readPath}\n@@ -4,2 +4,3 @@\n-def rotate(path: Path, keep: int = 7) -> None:\n-    # Compress yesterday's log and drop the oldest.\n+def rotate(path: Path, keep: int = 14) -> None:\n+    # Compress yesterday's log and keep two weeks.\n+    keep = max(keep, 1)\n`,
    files_modified: [readPath],
  })
  out.tool({ tool: "patch", toolCallId: patchId, status: "completed", result: patchOutput })
  record(req, { role: "assistant", content: null, tool_calls: [{ id: patchId, type: "function", function: { name: "patch", arguments: JSON.stringify({ mode: "replace", path: readPath, old_string: "keep: int = 7", new_string: "keep: int = 14" }) } }] })
  record(req, { role: "tool", tool_call_id: patchId, tool_name: "patch", content: patchOutput })

  const writeId = `call_${randomUUID().slice(0, 8)}`
  const notesPath = "/etc/logrotate.d/NOTES-on-rotating-and-pruning-logs.md"
  const notes = Array.from({ length: 38 }, (_, n) => `- note ${n + 1}`).join("\n") + "\n"
  out.tool({ tool: "write_file", emoji: "✍️", label: notesPath, toolCallId: writeId, status: "running" })
  await sleep(300)
  const writeOutput = JSON.stringify({ bytes_written: notes.length, dirs_created: false })
  out.tool({ tool: "write_file", toolCallId: writeId, status: "completed", result: writeOutput })
  record(req, { role: "assistant", content: null, tool_calls: [{ id: writeId, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: notesPath, content: notes }) } }] })
  record(req, { role: "tool", tool_call_id: writeId, tool_name: "write_file", content: writeOutput })

  // From its second turn, or when told to "ship", the agent opens the pull request with the plugin's tool.
  const sid = sessionOf(req, body)
  if (workspace && !workspace.opened && !workspace.closed && (/ship/i.test(last) || userTurns(sid).length >= 2)) {
    const prId = `call_${randomUUID().slice(0, 8)}`
    const title = "feat: add a dry-run flag to log rotation"
    const prArgs = { title, body: "## Summary\n\nAdds `--dry-run` to the rotation script.\n\n## Changes\n\n- rotate.py\n\n## How to test\n\nRun it with `--dry-run`.", commit_message: title }
    out.tool({ tool: "open_pull_request", emoji: "🚀", label: title, toolCallId: prId, status: "running" })
    await sleep(900)
    workspace.opened = { title, draft: /draft/i.test(last) }
    const prResult = JSON.stringify({ results: workspace.repos.map((repo, i) => ({ name: repo.name, committed: randomUUID().slice(0, 7), pushed: true, pr: { repo: repo.name, number: 27 + i, title, url: `https://github.com/${repo.name}/pull/${27 + i}`, state: workspace.opened.draft ? "draft" : "open", checks: null } })) })
    out.tool({ tool: "open_pull_request", toolCallId: prId, status: "completed", result: prResult })
    record(req, { role: "assistant", content: null, tool_calls: [{ id: prId, type: "function", function: { name: "open_pull_request", arguments: JSON.stringify(prArgs) } }] })
    record(req, { role: "tool", tool_call_id: prId, tool_name: "open_pull_request", content: prResult })
  }

  const steered = out.steered?.() ?? []
  if (steered.length) await say(`Noted: ${steered.join(" / ")}. I'll take that into account.\n\n`)
  await say(
    "Here's where the space is going under `/var/log`:\n\n" +
      "- `nginx/access.log.*` — **2.1 GB** across 34 files\n" +
      "- `postgres/*.log` — 1.4 GB, the oldest from March\n" +
      "- `app/debug.log.*` — 0.7 GB, left over from the verbose-logging experiment\n\n"
  )

  const attached = [...last.matchAll(/^<attachment name="([^"]*)"/gm)].map((m) => m[1])
  if (attached.length) {
    const images = (last.match(/^\[screenshot\]$/gm) ?? []).length
    await say(
      `Got ${attached.length === 1 ? attached[0] : `${attached.length} attachments: ${attached.join(", ")}`}` +
        (images ? `, ${images === 1 ? "an image" : `${images} images`} I can see` : "") +
        ".",
    )
  } else if (/ask five/i.test(last)) {
    const { answers, outcome } = await ask([
      { question: "Which environment should this run against?", choices: ["staging", "production"] },
      { question: "Which services are in scope?", choices: ["api", "worker", "web", "cron"], multi_select: true },
      { question: "What should the change be called?" },
      { question: "How should existing data be handled?", choices: ["Migrate it in place", "Leave it and write new rows only", "Back it up first, then migrate"] },
      { question: "Who should review it?", choices: ["Platform", "Product"], multi_select: true },
    ])
    const given = Object.values(answers).filter(Boolean).length
    await say(outcome === "submitted" ? `\nGot ${given} of 5 answers.\n` : "\nNo answers came, so I'll use the defaults.\n")
  } else if (/\bask\b/i.test(last)) {
    const { answers, outcome } = await ask([
      { question: "Which logs should I count as old?", choices: ["Older than 90 days", "Older than 30 days"] },
    ])
    await say(outcome === "submitted" && answers.q0
      ? `Got it, I'll count anything in the "${answers.q0}" group.`
      : "No answer came, so I'll count anything older than 90 days.")
  } else if (/fail/i.test(last)) {
    const failId = `call_${randomUUID().slice(0, 8)}`
    const command = "journalctl --vacuum-size=500M"
    out.tool({ tool: "terminal", emoji: "💻", label: command, toolCallId: failId, status: "running" })
    await sleep(900)
    const failOutput = JSON.stringify({ output: "Failed to vacuum: Permission denied", exit_code: 1, error: "Permission denied" })
    out.tool({ tool: "terminal", toolCallId: failId, status: "failed", result: failOutput })
    record(req, { role: "assistant", content: null, tool_calls: [{ id: failId, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command }) } }] })
    record(req, { role: "tool", tool_call_id: failId, tool_name: "terminal", content: failOutput })
    // Like Hermes's read_file for a missing file: an `error` in the envelope.
    const readFailId = `call_${randomUUID().slice(0, 8)}`
    const missing = "/etc/logrotate.d/journal"
    out.tool({ tool: "read_file", emoji: "📄", label: missing, toolCallId: readFailId, status: "running" })
    await sleep(400)
    const readFail = JSON.stringify({ content: "", error: `File not found: ${missing}`, similar_files: ["/etc/logrotate.d/rsyslog"] })
    out.tool({ tool: "read_file", toolCallId: readFailId, status: "failed", result: readFail })
    record(req, { role: "assistant", content: null, tool_calls: [{ id: readFailId, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: missing }) } }] })
    record(req, { role: "tool", tool_call_id: readFailId, tool_name: "read_file", content: readFail })
    await say("I tried to trim the journal too, but I don't have permission to, and there's no rotation config for it.")
  } else if (/dockerfile/i.test(last)) {
    // A long command, to check that the approval card stays within the screen.
    const lines = ["FROM nousresearch/hermes-agent:v2026.9.24", ""]
    for (const pkg of ["jq", "gpg", "curl", "wget", "git", "ripgrep", "fd-find", "htop", "tmux", "unzip"])
      lines.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${pkg} \\`, "    && rm -rf /var/lib/apt/lists/*", "")
    const command = `cat > /home/hermes/Dockerfile << 'EOF'\n${lines.join("\n")}EOF`
    const dockerId = `call_${randomUUID().slice(0, 8)}`
    out.tool({ tool: "terminal", emoji: "💻", label: "cat > /home/hermes/Dockerfile", toolCallId: dockerId, status: "running" })
    const choice = await out.approve({ command, pattern_key: "heredoc_write", description: "Write the Dockerfile", allow_permanent: true, allow_session: true })
    out.tool({ tool: "terminal", toolCallId: dockerId, status: "completed" })
    await say(choice === "deny" || choice === "timeout" ? "\nOkay, I left it alone." : "\nWrote the Dockerfile.")
  } else if (/clean|delete/i.test(last)) {
    await say("The live logs and anything written in the last 90 days stay untouched. Here is the command I want to run:\n\n```bash\nfind /var/log -name '*.log.*' -mtime +90 -delete\n```\n")
    const cleanupId = `call_${randomUUID().slice(0, 8)}`
    out.tool({ tool: "terminal", emoji: "💻", label: "find /var/log -name '*.log.*' -mtime +90 -delete", toolCallId: cleanupId, status: "running" })
    // In Auto the plugin turns Hermes's own approval bypass on for the run, so nothing is asked.
    const choice = ["auto", "theseus"].includes(projectSessions.get(sessionOf(req, body))?.mode) ? "once" : await out.approve({
      command: "find /var/log -name '*.log.*' -mtime +90 -delete",
      pattern_key: "recursive_delete",
      description: "Delete 34 rotated log files older than 90 days (4.2 GB) under /var/log",
      allow_permanent: true,
      allow_session: true,
    })
    out.tool({ tool: "terminal", toolCallId: cleanupId, status: "completed" })
    await say(choice === "deny" || choice === "timeout"
      ? "\nOkay, I left everything as it is."
      : "\nDone — freed **4.2 GB**. The live logs are untouched.")
  } else if (/long|slow/i.test(last)) {
    // Long enough to turn the screen off (or cut the network) halfway through.
    for (let i = 1; i <= 20 && !out.closed(); i++) {
      await say(`Step ${i} of 20 is done.\n\n`)
      await sleep(1000)
      if (i % 5 === 0 && i < 20) {
        // A tool call every few steps, after which a steer reaches the agent.
        const id = `call_${randomUUID().slice(0, 8)}`
        const command = `ls /var/log | head -${i}`
        out.tool({ tool: "terminal", emoji: "💻", label: command, toolCallId: id, status: "running" })
        await sleep(800)
        const result = JSON.stringify({ output: "nginx\npostgres\napp", exit_code: 0, error: null })
        out.tool({ tool: "terminal", toolCallId: id, status: "completed", result })
        record(req, { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command }) } }] })
        record(req, { role: "tool", tool_call_id: id, tool_name: "terminal", content: result })
        const heard = out.steered?.() ?? []
        if (heard.length) await say(`Noted: ${heard.at(-1)}.\n\n`)
      }
    }
  } else if (/image|chart/i.test(last)) {
    await say(
      "Here's the chart:\n\n" +
        "MEDIA:/var/tmp/memento-mock/chart.png\n\n" +
        "And the shots from the run, all together:\n\n" +
        "MEDIA:/var/tmp/memento-mock/shot-1.png\n" +
        "MEDIA:/var/tmp/memento-mock/shot-2.png\n" +
        "MEDIA:/var/tmp/memento-mock/shot-3.png\n\n" +
        "And one for a file I can't find:\n\n" +
        "MEDIA:/var/tmp/memento-mock/missing.png\n",
    )
  } else {
    await say("Want me to clean up the rotated files older than 90 days? Just say *clean them up*.")
  }

  await writeTodos(steps.length)

  // Like Hermes, usage sums every model call in the turn: a fixed system prompt plus the transcript,
  // counted once per call (this turn makes one call per tool, plus the reply).
  // A keyed session's history comes from the session store, not the body, as on Hermes.
  const sessionId = sessionOf(req, body)
  const keyed = sessionId && req.headers.authorization && transcripts.get(sessionId)
  const context = keyed ? keyed.filter((row) => row.role !== "tool") : (body.messages ?? body.input ?? [])
  const transcript = context.reduce((n, m) => n + String(m.content ?? "").length, 0)
  const calls = /clean|delete|\bask\b/i.test(last) ? 3 : 2
  const prompt_tokens = calls * (6000 + Math.round(transcript / 4))
  if (keyed) {
    lastCalls.set(sessionId, {
      prompt_tokens: 6000 + Math.round(transcript / 4),
      output_tokens: pieces,
      context_length: 200000,
    })
  }
  record(req, { role: "assistant", content: spoken, finish_reason: "stop" })
  return { spoken, prompt_tokens, completion_tokens: pieces }
}

async function waitForApproval(id) {
  const decision = new Promise((resolve) => pendingApprovals.set(id, resolve))
  const choice = await Promise.race([decision, sleep(120_000).then(() => "timeout")])
  pendingApprovals.delete(id)
  return choice
}

/** Like Hermes, a dropped connection interrupts the turn: the agent stops where it was. */
async function streamCompletion(req, res, body) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model ?? "hermes-agent"
  const last = durable([...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content)
  let closed = false
  res.on("close", () => (closed = true))

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors })
  const frame = (data, event) => {
    if (!closed) res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
  }
  const chunk = (delta, finish_reason = null, extra = {}) =>
    frame({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })

  chunk({ role: "assistant" })
  const { prompt_tokens, completion_tokens } = await playTurn(req, body, last, {
    closed: () => closed,
    say: (piece) => chunk({ content: piece }),
    status: (text) => frame({ kind: "thinking", text }, "hermes.status"),
    // Completions carry no result on this stream.
    // Only the run stream says whether a call failed.
    tool: ({ result: _result, ...event }) =>
      frame({ ...event, status: event.status === "failed" ? "completed" : event.status }, "hermes.tool.progress"),
    approve(event) {
      frame({ ...event, event: "approval.request", run_id: id, timestamp: Date.now() / 1000, choices: ["once", "session", "always", "deny"] }, "approval.request")
      return waitForApproval(id)
    },
    ask: () => Promise.resolve({ answers: {}, outcome: "undelivered" }),
  })
  chunk({}, "stop", { usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens } })
  if (!closed) res.end("data: [DONE]\n\n")
}

// Runs carry on whether or not anyone is listening. Each keeps its events, numbered by `seq`, so a
// client that reconnects with ?last_seq= gets what it missed; MOCK_RUN_BACKLOG shrinks the buffer
// to exercise `replay.truncated`, and MOCK_DROP_EVENTS_MS cuts every event stream after that long,
// like a phone whose screen went off. MOCK_NO_RUNS=1 turns runs off, like an older Hermes.
// MOCK_BLOCK_RUN_EVENTS=1 is Hermes v2026.9.24: the event stream has no CORS headers, and the run
// forgets its events once that (blocked) subscriber leaves, so only GET /v1/runs/{id} is left.
// MOCK_STALL_EVENTS_MS detaches a stream's listener after that long: the run and its keepalives
// carry on, but no further events reach the client, like a server whose event fan-out went quiet.
const runs = new Map()
const PLUGIN_VERSION = process.env.MOCK_PLUGIN_VERSION || "0.29.1"
const DICTATION = process.env.MOCK_DICTATION ?? "on"
const dictationClips = []
const EVENTS = process.env.MOCK_NO_EVENTS !== "1"
const RUNS = process.env.MOCK_NO_RUNS !== "1"
const RUN_BACKLOG = Number(process.env.MOCK_RUN_BACKLOG ?? 1000)
const DROP_EVENTS_MS = Number(process.env.MOCK_DROP_EVENTS_MS ?? 0)
const BLOCK_RUN_EVENTS = process.env.MOCK_BLOCK_RUN_EVENTS === "1"
const STALL_EVENTS_MS = Number(process.env.MOCK_STALL_EVENTS_MS ?? 0)

// The plugin's change stream: one log per profile (the "" key is the default one). Runs and sessions
// belong to no profile here, so they go to every log.
const pushSubscriptions = new Map()
// The main model the plugin's `model` route set, per profile ("" is the default one).
const hostModels = new Map()
// Whether a refresh has probed the custom endpoint in /api/model/options.
let customProbed = false
const eventLogs = new Map()
const eventStreams = new Set()
function logOf(profile) {
  if (!eventLogs.has(profile)) eventLogs.set(profile, { rows: [], seq: 0 })
  return eventLogs.get(profile)
}
function noteEvent(kind, sessionId, profile) {
  for (const key of profile === undefined ? new Set([...eventLogs.keys(), ""]) : [profile]) {
    const log = logOf(key)
    log.rows.push({ id: ++log.seq, kind, session_id: sessionId })
    if (log.rows.length > 2000) log.rows.shift()
  }
  for (const stream of eventStreams) stream()
}

function streamEvents(req, res, profile, since) {
  const log = logOf(profile)
  res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
  const send = (kind, data) => res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`)
  let cursor = since ?? log.seq
  send("hello", { cursor, version: PLUGIN_VERSION })
  if (since !== undefined && (since > log.seq || (since < log.seq && (log.rows[0]?.id ?? 0) > since + 1))) {
    cursor = log.seq
    send("reset", { cursor })
  }
  const flush = () => {
    for (const row of log.rows.filter((r) => r.id > cursor)) {
      cursor = row.id
      send(row.kind, { cursor, ...(row.session_id ? { session_id: row.session_id } : {}) })
    }
  }
  eventStreams.add(flush)
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000)
  req.on("close", () => {
    clearInterval(ping)
    eventStreams.delete(flush)
  })
  flush()
}

const sessionOf = (req, body) => req.headers["x-hermes-session-id"] ?? body?.session_id

// The plugin's queue (outbox.py): per session, what waits, what it started, and the run body to
// start a leftover steer with. It starts the next item when the session's run is over, unless the
// last run was stopped after the user last sent one.
const queues = new Map()
function queueOf(sessionId) {
  if (!queues.has(sessionId)) queues.set(sessionId, { items: [], sent: [], resumedAt: 0, template: null })
  return queues.get(sessionId)
}
const sessionRuns = (sessionId) => [...runs.values()].filter((run) => run.sessionId === sessionId)
function pumpQueue(sessionId) {
  const queue = queues.get(sessionId)
  if (!queue) return
  const all = sessionRuns(sessionId)
  if (all.some((run) => ["running", "waiting_for_approval"].includes(run.status))) return
  const latest = all.at(-1)
  if (latest?.pendingSteer && latest.output !== undefined && !latest.requeued && queue.template) {
    latest.requeued = true
    const text = latest.pendingSteer
    queue.items.unshift({ id: `s_${latest.id}`, text, attachments: [], created_at: Date.now(), body: { ...queue.template, input: [{ role: "user", content: text }] } })
    noteEvent("session", sessionId)
  }
  const next = queue.items[0]
  if (!next || next.error) return
  if (latest?.status === "cancelled" && (latest.endedAt ?? 0) > queue.resumedAt) return
  queue.items.shift()
  // As the plugin does, with the key the app queued it with.
  const run = startRun({ headers: { "idempotency-key": next.id, authorization: queue.authorization } }, { ...next.body, session_id: sessionId })
  queue.sent.push({ ...next, run_id: run.id, sent_at: Date.now() })
  noteEvent("session", sessionId)
}
const queueView = (sessionId) => {
  const queue = queueOf(sessionId)
  const all = sessionRuns(sessionId)
  const latest = all.at(-1)
  const item = ({ body: _body, ...rest }) => ({ run_id: null, sent_at: null, error: null, ...rest })
  return {
    object: "memento.queue",
    items: queue.items.map(item),
    sent: queue.sent.map((sent) => ({ ...item(sent), run_status: runs.get(sent.run_id)?.status ?? null })),
    paused: latest?.status === "cancelled" && (latest.endedAt ?? 0) > queue.resumedAt,
  }
}

function startRun(req, body) {
  const key = req.headers["idempotency-key"]
  const replay = key && [...runs.values()].find((run) => run.key === key)
  if (replay) return replay
  const id = `run_${randomUUID().replace(/-/g, "")}`
  const run = { id, key, sessionId: body.session_id, status: "running", events: [], seq: 0, listeners: new Set(), stopped: false }
  runs.set(id, run)
  noteEvent("runs", run.sessionId)
  const push = (name, fields = {}) => {
    const event = { event: name, run_id: id, timestamp: Date.now() / 1000, ...fields, seq: run.seq++ }
    run.events.push(event)
    if (run.events.length > RUN_BACKLOG) run.events.shift()
    for (const listener of run.listeners) listener(event)
  }
  const input = Array.isArray(body.input) ? body.input : [{ role: "user", content: String(body.input ?? "") }]
  const last = durable(input.at(-1)?.content)
  // Rows go to the session named in the body, as on Hermes.
  const sessionReq = { headers: { ...req.headers, "x-hermes-session-id": body.session_id } }
  // Steers the agent has read and not yet answered.
  let heard = []
  if (run.sessionId)
    steerPoints.set(run.sessionId, () => {
      if (!run.pendingSteer) return
      const text = run.pendingSteer
      run.pendingSteer = undefined
      heard.push(text)
      record(sessionReq, { role: "user", display_kind: "steer", content: `${STEER_OPEN}\n${text}\n${STEER_CLOSE}` })
    })
  void playTurn(sessionReq, body, last, {
    closed: () => run.stopped,
    steered: () => {
      const read = heard
      heard = []
      return read
    },
    say: (delta) => push("message.delta", { delta }),
    status: () => {},
    tool: ({ tool, label, status, result }) =>
      push(status === "running" ? "tool.started" : "tool.completed", status === "running" ? { tool, preview: label } : { tool, duration: 1.4, error: status === "failed", preview: result ?? "" }),
    approve(event) {
      run.status = "waiting_for_approval"
      noteEvent("runs", run.sessionId)
      // The status and the event share the request's timestamp, as on Hermes.
      run.approval = { ...event, run_id: id, timestamp: Date.now() / 1000, choices: ["once", "session", "always", "deny"] }
      push("approval.request", run.approval)
      return waitForApproval(id).then(async (choice) => {
        run.status = "running"
        run.approval = undefined
        noteEvent("runs", run.sessionId)
        // Hermes's route says so for an answer, the plugin for a timeout or its own Auto answer.
        if (!run.stopped) push("approval.responded", { choice })
        // The agent takes a moment to carry on, so the card is seen to go before the reply ends.
        if (choice === "timeout") await sleep(4000)
        return choice
      })
    },
    async ask(questions) {
      const clarify_id = randomUUID().replace(/-/g, "").slice(0, 12)
      run.status = "waiting_for_approval"
      run.clarify = { event: "clarify.request", run_id: id, timestamp: Date.now() / 1000, clarify_id, questions }
      push("clarify.request", { clarify_id, questions })
      const reply = new Promise((resolve) => pendingClarifies.set(id, { clarify_id, resolve }))
      const { answers, outcome } = await Promise.race([reply, sleep(120_000).then(() => ({ answers: {}, outcome: "timed_out" }))])
      pendingClarifies.delete(id)
      run.status = "running"
      run.clarify = undefined
      push("clarify.responded", { clarify_id, outcome, answers })
      return { answers, outcome }
    },
  }).then(({ spoken, output, prompt_tokens, completion_tokens }) => {
    if (steerPoints.get(run.sessionId)) steerPoints.delete(run.sessionId)
    run.status = run.stopped ? "cancelled" : "completed"
    run.endedAt = Date.now()
    // A scenario can name the final message alone, as Hermes's `final_response` carries it.
    const final = output ?? spoken
    run.output = final
    run.usage = { input_tokens: prompt_tokens, output_tokens: completion_tokens, total_tokens: prompt_tokens + completion_tokens }
    // A hard stop drops an unread steer, as on Hermes; otherwise it goes back to the client.
    if (run.stopped) run.pendingSteer = undefined
    noteEvent("session", run.sessionId)
    noteEvent("runs", run.sessionId)
    push(`run.${run.status}`, { completed: !run.stopped, interrupted: run.stopped, output: final, usage: run.usage, ...(run.pendingSteer ? { pending_steer: run.pendingSteer } : {}) })
    for (const listener of run.listeners) listener(null)
    setTimeout(() => pumpQueue(run.sessionId), 300)
  })
  return run
}

function streamRunEvents(req, res, run, lastSeq) {
  if (run.eventsDropped) return json(res, 404, { error: { message: `Run not found: ${run.id}`, code: "run_not_found" } })
  if (BLOCK_RUN_EVENTS) res.on("close", () => (run.eventsDropped = true))
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...(BLOCK_RUN_EVENTS ? {} : cors) })
  res.write(": open\n\n")
  const send = (event) => res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
  const replay = run.events.filter((event) => event.seq > lastSeq)
  if (replay.length && replay[0].seq > lastSeq + 1) {
    res.write(`data: ${JSON.stringify({ event: "replay.truncated", run_id: run.id, oldest_retained_seq: replay[0].seq })}\n\n`)
  }
  replay.forEach(send)
  if (run.status === "completed" || run.status === "cancelled") return res.end(": stream closed\n\n")
  const listener = (event) => (event ? send(event) : res.end(": stream closed\n\n"))
  run.listeners.add(listener)
  // Like Hermes, a comment every 10s while nothing else is sent, so the app can tell a live stream from a dead one.
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 10_000)
  res.on("close", () => {
    clearInterval(keepalive)
    run.listeners.delete(listener)
  })
  if (DROP_EVENTS_MS) setTimeout(() => res.destroy(), DROP_EVENTS_MS)
  if (STALL_EVENTS_MS) setTimeout(() => run.listeners.delete(listener), STALL_EVENTS_MS)
}

const runStatus = (run) => ({
  object: "hermes.run",
  run_id: run.id,
  status: run.status,
  ...(run.status === "waiting_for_approval" && run.approval ? { approval: run.approval } : {}),
  ...(run.clarify ? { clarify: run.clarify } : {}),
  ...(run.output !== undefined ? { output: run.output, usage: run.usage } : {}),
  ...(run.pendingSteer && run.output !== undefined ? { pending_steer: run.pendingSteer } : {}),
})

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
    if (req.method === "OPTIONS") return res.writeHead(200, cors).end()
    // Like a gateway with multiplex_profiles: other profiles live under /p/<profile>/.
    const profile = /^\/p\/([^/]+)(?=\/)/.exec(url.pathname)?.[1]
    if (profile) url.pathname = url.pathname.slice(profile.length + 3)
    // The plugin's own prefix carries the profile, since Hermes's /p/<profile>/ catch-all comes first.
    const pluginProfile = /^\/api\/plugins\/memento\/p\/([^/]+)(?=\/)/.exec(url.pathname)?.[1]
    if (pluginProfile) url.pathname = `/api/plugins/memento${url.pathname.slice(pluginProfile.length + 23)}`
    if (url.pathname === "/health") return json(res, 200, { status: "ok", platform: "mock-hermes" })
    if (url.pathname === "/v1/models") {
      // Named profiles advertise their name as the model id.
      const id = profile ?? "hermes-agent"
      return json(res, 200, { object: "list", data: [{ id, object: "model", owned_by: "hermes" }] })
    }
    if (url.pathname === "/api/model/options") {
      // Named profiles report a model models.dev doesn't know, to exercise manual entry.
      const configured = profile ? `mock-model-${profile}` : "anthropic/claude-sonnet-4.5"
      const set = hostModels.get(profile ?? "")
      const model = set?.model ?? configured
      // Hermes's picker inventory: a skeleton row without credentials is left out of the picker.
      const providers = [
        {
          slug: "openrouter",
          name: "OpenRouter",
          is_current: true,
          authenticated: true,
          models: [
            configured,
            "anthropic/claude-opus-4.1",
            "anthropic/claude-haiku-4.5",
            "openai/gpt-5",
            "openai/gpt-5-mini",
            "google/gemini-2.5-pro",
            "google/gemini-2.5-flash",
            "x-ai/grok-4",
            "deepseek/deepseek-chat-v3.1",
          ],
        },
        { slug: "anthropic", name: "Anthropic", is_current: false, authenticated: true, models: ["claude-sonnet-4-5", "claude-opus-4-1"] },
        { slug: "nous", name: "Nous Portal", is_current: false, authenticated: false, models: [] },
        // A custom endpoint lists its models only once a refresh has probed it.
        {
          slug: "custom:my-router",
          name: "My Router",
          is_current: false,
          is_user_defined: true,
          authenticated: true,
          api_url: "https://router.example/v1",
          models: customProbed || url.searchParams.get("refresh") === "true" ? ["meta/llama-4"] : [],
        },
      ]
      if (url.searchParams.get("refresh") === "true") customProbed = true
      return json(res, 200, { model, provider: set?.provider ?? "openrouter", providers })
    }
    if (url.pathname === "/v1/skills") {
      return json(res, 200, {
        object: "list",
        data: [
          { name: "github-pr-workflow", description: "Open, review and land pull requests.", category: "github" },
          { name: "log-triage", description: "Find the noisy lines in a pile of logs.", category: "ops" },
          { name: "plan", description: "Write a step-by-step plan before touching anything.", category: null },
        ],
      })
    }
    if (url.pathname === "/api/jobs") {
      const all = url.searchParams.get("include_disabled") === "true"
      const jobs = cronJobs(profile).filter((job) => all || !job.paused)
      return json(res, 200, { jobs: jobs.map(jobRecord) })
    }
    const jobAction = /^\/api\/jobs\/([^/]+)\/(pause|resume|run)$/.exec(url.pathname)
    if (req.method === "POST" && jobAction) {
      const job = cronJobs(profile).find((j) => j.id === jobAction[1])
      if (!job) return json(res, 404, { error: "Job not found" })
      noteEvent("cron", undefined, profile ?? "")
      if (jobAction[2] === "pause") job.paused = true
      if (jobAction[2] === "resume") job.paused = false
      if (jobAction[2] === "run") {
        const run = { start: Date.now(), end: null, ok: true }
        job.runs.push(run)
        setTimeout(() => (run.end = Date.now()), 4000)
      }
      return json(res, 200, { job: jobRecord(job) })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/info") {
      return json(res, 200, {
        name: "memento",
        version: PLUGIN_VERSION,
        features: ["cron_runs", "session_label", "chats", "context", "todos", "projects", "projects_async", "project_repos", "project_usage", "github", "sessions", "runs", "prs", "plans", "clarify", "attachments", "media", "profile_routes", "pr_tool", "close", "merge_resolve", "theseus", ...(EVENTS ? ["events"] : []), "push", "host_model", "queue", "dictation", ...(RESEARCH ? ["research", "research_followup", "research_rewrite"] : [])],
        clarify: true,
        hooks: true,
        theseus: THESEUS_START === "unavailable"
          ? { skill: "mock", api: 1, node: null, ready: false, reason: "Theseus needs Node 20 or newer on the Hermes host, and there is none.", reviewers: { llm: true, model: true, provider: true } }
          : { skill: "mock", api: 1, node: "22.0.0", ready: true, reason: null, reviewers: { llm: true, model: process.env.MOCK_THESEUS_MODELS !== "0", provider: process.env.MOCK_THESEUS_MODELS !== "0" } },
        research: { ready: true, reason: null, writers: { model: RESEARCH_WRITERS, provider: RESEARCH_WRITERS } },
        dictation: DICTATION === "off"
          ? { ready: false, reason: "faster-whisper isn't installed on the host. Run `hermes tools` and pick Local Whisper.", model: "base" }
          : { ready: true, model: "base", language: "en" },
      })
    }
    if (PLUGIN && RESEARCH && !profile && (await handleResearch(req, res, url.pathname, { json, readBody, noteEvent })))
      return
    // Web Push: the mock keeps subscriptions but sends nothing.
    if (PLUGIN && !profile && req.method === "POST" && url.pathname === "/api/plugins/memento/push") {
      const { subscription, device, vapid_key, subject, categories } = await readBody(req)
      if (!subscription?.endpoint || !subscription.keys?.p256dh || !device || !vapid_key || !subject) {
        return json(res, 400, { error: { message: "Missing subscription fields." } })
      }
      pushSubscriptions.set(subscription.endpoint, { device, categories })
      return json(res, 200, { object: "memento.push", subscribed: true })
    }
    if (PLUGIN && !profile && req.method === "POST" && url.pathname === "/api/plugins/memento/push/mute") {
      const { muted, bot } = await readBody(req)
      if (typeof muted !== "boolean") return json(res, 400, { error: { message: "Missing muted" } })
      if (bot !== undefined && !/^[a-z0-9-]{1,32}$/.test(String(bot))) {
        return json(res, 400, { error: { message: "Not a bot" } })
      }
      return json(res, 200, { object: "memento.push.mute", muted })
    }
    if (PLUGIN && !profile && req.method === "POST" && url.pathname === "/api/plugins/memento/push/remove") {
      const { endpoint } = await readBody(req)
      pushSubscriptions.delete(endpoint)
      return json(res, 200, { object: "memento.push", subscribed: false })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/media") {
      const path = url.searchParams.get("path") ?? ""
      if (/\.png$/i.test(path) && !/missing/i.test(path)) {
        res.writeHead(200, { "Content-Type": "image/png", ...cors })
        return res.end(MOCK_PNG)
      }
      return json(res, 404, { error: { message: "No such image." } })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/library/file") {
      // A filed file for opening it: an image as png bytes, markdown as text, anything else as
      // an octet-stream the browser downloads.
      const path = url.searchParams.get("path") ?? ""
      if (/\.png$/i.test(path)) {
        res.writeHead(200, { "Content-Type": "image/png", ...cors })
        return res.end(MOCK_PNG)
      }
      if (/\.md$/i.test(path)) {
        res.writeHead(200, { "Content-Type": "text/markdown", ...cors })
        return res.end("# Cleanup report\n\nEverything tidied, nothing renamed.\n")
      }
      return json(res, 404, { error: { message: "No such file." } })
    }
    if (PLUGIN && EVENTS && !profile && url.pathname === "/api/plugins/memento/events") {
      const since = url.searchParams.get("since")
      return streamEvents(req, res, pluginProfile ?? "", since === null ? undefined : Number(since))
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/cron/runs") {
      const perJob = Math.max(1, Math.min(Number(url.searchParams.get("per_job") ?? 24) || 24, 200))
      const jobs = Object.fromEntries(
        cronJobs().map((job) => [job.id, job.runs.slice(-perJob).reverse().map((run) => ledgerRow(job, run))]),
      )
      return json(res, 200, { object: "cron_runs", jobs })
    }
    if (PLUGIN && !profile && req.method === "POST" && url.pathname === "/api/plugins/memento/model") {
      const { provider, model } = await readBody(req)
      if (typeof provider !== "string" || !provider.trim() || typeof model !== "string" || !model.trim()) {
        return json(res, 400, { error: { message: "provider and model are required" } })
      }
      if (!["openrouter", "anthropic"].includes(provider.trim())) {
        return json(res, 400, { error: { message: `Unknown provider '${provider}'.` } })
      }
      hostModels.set(pluginProfile ?? "", { provider: provider.trim(), model: model.trim() })
      return json(res, 200, { object: "memento.host_model", provider: provider.trim(), model: model.trim() })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/github") {
      return json(res, 200, GITHUB ? { connected: true, source: "gh", login: "mock-user" } : { connected: false })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/github/repos") {
      if (!GITHUB) return json(res, 409, { error: { message: "No GitHub account on the server." } })
      return json(res, 200, { object: "memento.github.repos", repos: githubRepos })
    }
    if (PLUGIN && !profile && req.method === "POST" && url.pathname === "/api/plugins/memento/projects") {
      const { name, description, repos = [] } = await readBody(req)
      if (!String(name ?? "").trim()) return json(res, 400, { error: { message: "Name the project." } })
      const bad = repos.find((repo) => !/^[\w-]+\/[\w.-]+$/.test(repo))
      if (bad !== undefined) return json(res, 400, { error: { message: `${bad} isn't owner/name.` } })
      setTimeout(() => noteEvent("projects", undefined, ""), 50)
      const all = mockProjects()
      const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"
      let slug = base
      for (let n = 2; all.some((p) => p.slug === slug); n++) slug = `${base}-${n}`
      const root = `/home/hermes/.hermes/projects/${slug}`
      const names = repos.map((repo) => repo.split("/")[1])
      const project = {
        id: `pending-${slug}`,
        slug,
        name: name.trim(),
        description: String(description ?? "").trim() || null,
        created_at: Date.now() / 1000,
        last_active: null,
        status: "cloning",
        error: null,
        folders: repos.map((repo, i) => ({
          path: `${root}/${names.filter((n) => n === names[i]).length > 1 ? repo.replace("/", "-") : names[i]}`,
          label: names[i],
          is_primary: false,
          git: false,
          repo,
          status: "queued",
        })),
      }
      all.push(project)
      cloneProject(project, root)
      return json(res, 202, { object: "memento.project", ...project })
    }
    const projectRoute = /^\/api\/plugins\/memento\/projects\/([^/]+)(\/remove|\/retry|\/repos|\/repos\/remove|\/usage|\/library)?$/.exec(url.pathname)
    if (PLUGIN && !profile && projectRoute?.[2] === "/library") {
      // The project's filed files, every session's merged by folder; a missing project 404s.
      const found = mockProjects().find((p) => p.id === decodeURIComponent(projectRoute[1]))
      if (!found || found.status === "cloning" || found.status === "failed")
        return json(res, 404, { error: { message: "No such project." } })
      return json(res, 200, {
        object: "memento.library",
        project_id: found.id,
        folders: projectLibrary(found.id),
      })
    }
    if (PLUGIN && !profile && projectRoute?.[2] === "/usage") {
      const found = mockProjects().find((p) => p.id === decodeURIComponent(projectRoute[1]))
      if (!found || found.status === "cloning" || found.status === "failed")
        return json(res, 404, { error: { message: "No such project." } })
      const own = [...projectSessions.entries()].filter(([, r]) => r.project_id === found.id)
      const titles = ["Restore tool call details", "Design bot self-registration", "Roadmap item 23", "How context window usage is counted", "Take over earlier session", "Fix the exit toast", "Add usage breakdown"]
      // Made-up use: the project's own sessions plus a few older ones, mostly cache reads.
      const threads = [...own.map(([id]) => id), ...titles.map((_, i) => `memento-old-${i}`)].map((id, i) => {
        const scale = 1 / (i + 1)
        const model = i === 2 ? "anthropic/claude-sonnet-5.5" : i === 5 ? "gpt-5.5" : "claude-opus-5-5"
        return {
          id,
          title: id.startsWith("memento-old-") ? titles[i - own.length] ?? null : null,
          started_at: Date.now() / 1000 - i * 86_400,
          last_active: Date.now() / 1000 - i * 43_200,
          models: [{
            model,
            input_tokens: Math.round(48_000 * scale),
            output_tokens: Math.round(310_000 * scale),
            cache_read_tokens: Math.round(98_000_000 * scale),
            cache_write_tokens: Math.round(1_900_000 * scale),
            cost_usd: model === "gpt-5.5" ? 3.2 * scale : null,
          }],
        }
      })
      const sum = (key) => threads.reduce((all, t) => all + t.models[0][key], 0)
      return json(res, 200, {
        object: "memento.project.usage",
        sessions: threads.length,
        input_tokens: sum("input_tokens"),
        output_tokens: sum("output_tokens"),
        cache_read_tokens: sum("cache_read_tokens"),
        cache_write_tokens: sum("cache_write_tokens"),
        cost_usd: 3.2 / 6,
        threads,
      })
    }
    if (PLUGIN && !profile && req.method === "POST" && projectRoute) {
      const all = mockProjects()
      const found = all.find((p) => p.id === decodeURIComponent(projectRoute[1]))
      if (!found) return json(res, 404, { error: { message: "No such project." } })
      if (projectRoute[2] === "/repos" || projectRoute[2] === "/repos/remove") {
        if (found.status === "cloning" || found.status === "failed")
          return json(res, 409, { error: { message: "The project is still being created." } })
        const { repo } = await readBody(req)
        const folder = found.folders.find((f) => f.repo === repo)
        if (projectRoute[2] === "/repos/remove") {
          if (!folder) return json(res, 404, { error: { message: "That repo isn't in this project." } })
          if (folder.status === "cloning" || folder.status === "failed") {
            clearTimeout(folder.timer)
            found.folders.splice(found.folders.indexOf(folder), 1)
          } else if (folder.status !== "removing") {
            folder.git = false
            folder.status = "removing"
            setTimeout(() => found.folders.splice(found.folders.indexOf(folder), 1), 2000)
          }
          return json(res, 202, { object: "memento.project.repo", removed: true })
        }
        if (!/^[\w-]+\/[\w.-]+$/.test(String(repo ?? ""))) return json(res, 400, { error: { message: "repo must be owner/name." } })
        if (folder?.status === "removing") return json(res, 409, { error: { message: `${repo} is still being removed.` } })
        if (folder && !folder.status) return json(res, 409, { error: { message: `${repo} is already in this project.` } })
        const added = folder ?? { path: `/home/hermes/.hermes/projects/${found.slug}/${repo.split("/")[1]}`, label: null, is_primary: false, git: false, repo }
        if (!folder) found.folders.push(added)
        added.status = "cloning"
        added.error = undefined
        Object.defineProperty(added, "timer", {
          enumerable: false,
          writable: true,
          value: setTimeout(() => {
            if (process.env.MOCK_FAIL_CLONE === "1" || /fail/i.test(repo)) {
              added.status = "failed"
              added.error = `GitHub refused access to ${repo}.`
              return
            }
            added.status = undefined
            added.error = undefined
            added.git = true
            added.branch = "main"
          }, Number(process.env.MOCK_REPO_CLONE_MS ?? 4000)),
        })
        return json(res, 202, { object: "memento.project.repo", project_id: found.id, repo, path: added.path, status: "cloning" })
      }
      if (projectRoute[2] === "/retry") {
        if (found.status !== "failed") return json(res, 404, { error: { message: "No failed project to retry." } })
        for (const folder of found.folders) folder.status = "queued"
        found.status = "cloning"
        found.error = null
        cloneProject(found, found.folders[0].path.replace(/\/[^/]+$/, ""))
        return json(res, 202, { object: "memento.project", ...found })
      }
      if (projectRoute[2]) {
        clearTimeout(cloning.get(found.id))
        cloning.delete(found.id)
        all.splice(all.indexOf(found), 1)
        return json(res, 200, { object: "memento.project", removed: true })
      }
      if (found.status !== "ready") return json(res, 409, { error: { message: "The project is still being created." } })
      const { name, description, archived, pinned } = await readBody(req)
      if (name !== undefined && !String(name).trim()) return json(res, 400, { error: { message: "Name the project." } })
      if (name !== undefined) found.name = String(name).trim()
      if (description !== undefined) found.description = String(description).trim() || null
      if (archived !== undefined) found.archived = Boolean(archived)
      if (pinned !== undefined) found.pinned_at = pinned ? (found.pinned_at ?? Math.floor(Date.now() / 1000)) : null
      return json(res, 200, { object: "memento.project", id: found.id })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/projects") {
      return json(res, 200, { object: "memento.projects", projects: pluginProfile ? [] : mockProjects() })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/chats") {
      const key = pluginProfile ?? ""
      if (!pluginChatLists.has(key)) pluginChatLists.set(key, key ? new Map() : pluginChats)
      const chatList = pluginChatLists.get(key)
      if (req.method === "POST") {
        const { chats } = await readBody(req)
        let changed = false
        if (!chats || typeof chats !== "object") {
          return json(res, 400, { error: { message: "chats must be an object" } })
        }
        for (const [id, entry] of Object.entries(chats)) {
          if (entry.at > (chatList.get(id)?.at ?? -1)) {
            chatList.set(id, entry)
            changed = true
          }
        }
        if (changed) noteEvent("chats", undefined, key)
      }
      return json(res, 200, { object: "memento.chats", chats: Object.fromEntries(chatList) })
    }
    const sessionLabel = /^\/api\/plugins\/memento\/sessions\/([^/]+)\/label$/.exec(url.pathname)
    if (PLUGIN && !profile && req.method === "POST" && sessionLabel) {
      const id = decodeURIComponent(sessionLabel[1])
      if (!chatTitles.has(id)) return json(res, 404, { error: { message: "Session not found" } })
      const source = projectSessions.has(id) ? "Memento Code" : "Memento"
      labelledSessions.set(id, source)
      return json(res, 200, { id, source })
    }
    const sessionContext = /^\/api\/plugins\/memento\/sessions\/([^/]+)\/context$/.exec(url.pathname)
    if (PLUGIN && !profile && req.method === "GET" && sessionContext) {
      const id = decodeURIComponent(sessionContext[1])
      const call = lastCalls.get(id)
      return json(res, 200, {
        object: "memento.context",
        session_id: id,
        prompt_tokens: call?.prompt_tokens ?? null,
        output_tokens: call?.output_tokens ?? null,
        context_length: call?.context_length ?? null,
        model: call ? "anthropic/claude-sonnet-4.5" : null,
        provider: call ? "openrouter" : null,
        at: call ? Date.now() : null,
      })
    }
    const usageRoute = /^\/api\/plugins\/memento\/usage$/.exec(url.pathname)
    if (PLUGIN && !profile && req.method === "GET" && usageRoute) {
      const provider = url.searchParams.get("provider") || ""
      const pct = Number(process.env.MOCK_USAGE_PERCENT ?? 94)
      // Like a provider's, a window resets at a fixed time, so reading it again changes nothing.
      const next = (ms) => new Date(Math.ceil((Date.now() + 1) / ms) * ms).toISOString()
      const windows = pct > 0
        ? [
            { label: "Session", used_percent: pct, resets_at: next(2 * 3600_000), detail: null },
            { label: "Weekly", used_percent: Math.min(100, pct * 0.8), resets_at: next(7 * 86400_000), detail: null },
          ]
        : []
      return json(res, 200, { object: "memento.usage", provider, plan: "Pro", windows })
    }
    const sessionTodos = /^\/api\/plugins\/memento\/sessions\/([^/]+)\/todos$/.exec(url.pathname)
    if (PLUGIN && !profile && req.method === "GET" && sessionTodos) {
      const id = decodeURIComponent(sessionTodos[1])
      const row = (transcripts.get(id) ?? []).findLast((r) => r.role === "tool" && r.tool_name === "todo_list")
      const found = row ? JSON.parse(row.content) : null
      return json(res, 200, { object: "memento.todos", session_id: id, revision: found?.revision ?? null, todos: found?.todos ?? null })
    }
    const sessionAgents = /^\/api\/plugins\/memento\/sessions\/([^/]+)\/agents$/.exec(url.pathname)
    if (PLUGIN && !profile && req.method === "GET" && sessionAgents) {
      const id = decodeURIComponent(sessionAgents[1])
      return json(res, 200, { object: "memento.agents", session_id: id, agents: delegations.get(id) ?? [] })
    }
    const clarifyRoute = /^\/api\/plugins\/memento\/runs\/([^/]+)\/clarify$/.exec(url.pathname)
    if (PLUGIN && !profile && req.method === "POST" && clarifyRoute) {
      const pending = pendingClarifies.get(clarifyRoute[1])
      const { clarify_id, answers, outcome } = await readBody(req)
      if (!pending || (clarify_id && clarify_id !== pending.clarify_id)) return json(res, 409, { error: { message: `Run has no pending question: ${clarifyRoute[1]}` } })
      // A missing or blank answer is a skipped question.
      const given = Object.fromEntries(Object.entries(answers ?? {}).map(([k, v]) => [k, Array.isArray(v) ? (v.filter(Boolean).length ? v.filter(Boolean) : null) : (String(v ?? "").trim() || null)]))
      pending.resolve({ answers: given, outcome: outcome === "cancelled" ? "cancelled" : "submitted" })
      return json(res, 200, { object: "memento.clarify_response", run_id: clarifyRoute[1], clarify_id: pending.clarify_id, resolved: true })
    }
    if (PLUGIN && !profile && req.method === "POST" && url.pathname === "/api/plugins/memento/dictation/warm") {
      return json(res, 200, { object: "memento.dictation_warm", warmed: DICTATION !== "off", ms: 0 })
    }
    if (PLUGIN && !profile && req.method === "POST" && url.pathname === "/api/plugins/memento/dictation") {
      const data = await readRaw(req)
      if (!data.length) return json(res, 400, { error: { message: "The recording is empty." } })
      dictationClips.push({ bytes: data.length, type: req.headers["content-type"], hint: url.searchParams.get("hint"), context: url.searchParams.get("context") })
      if (DICTATION === "off") return json(res, 409, { error: { message: "faster-whisper isn't installed on the host." } })
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (DICTATION === "fail") return json(res, 502, { error: { message: "Local transcription failed: the model ran out of memory." } })
      return json(res, 200, { object: "memento.dictation", text: "Let's ship the dictation feature today.", ms: 700 })
    }
    const attachmentRoute = /^\/api\/plugins\/memento\/sessions\/([^/]+)\/attachments$/.exec(url.pathname)
    if (PLUGIN && !profile && req.method === "POST" && attachmentRoute) {
      const data = await readRaw(req)
      if (!data.length) return json(res, 400, { error: { message: "The file is empty." } })
      const dir = join(tmpdir(), "mock-hermes-attachments", basename(attachmentRoute[1]))
      mkdirSync(dir, { recursive: true })
      const name = basename(url.searchParams.get("name") || "file")
      let path = join(dir, name)
      for (let n = 2; existsSync(path); n++) path = join(dir, name.replace(/(\.[^.]*)?$/, `-${n}$1`))
      writeFileSync(path, data)
      return json(res, 200, { object: "memento.attachment", name: basename(path), path, size: data.length })
    }
    const queueRoute = /^\/api\/plugins\/memento\/sessions\/([^/]+)\/queue(?:\/([^/]+)\/(remove|send|steer))?$/.exec(url.pathname)
    if (PLUGIN && !profile && queueRoute) {
      const id = decodeURIComponent(queueRoute[1])
      const queue = queueOf(id)
      if (req.method === "GET") return json(res, 200, queueView(id))
      if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } })
      if (!queueRoute[2]) {
        const { text, attachments, body } = await readBody(req)
        if (!Array.isArray(body?.input) || !body.input.length) return json(res, 400, { error: { message: "body.input must hold the message" } })
        const { input: _input, ...template } = body
        queue.template = { ...template, session_id: id }
        queue.authorization = req.headers.authorization
        const item = { id: `q_${randomUUID().replace(/-/g, "").slice(0, 20)}`, text: String(text ?? ""), attachments: attachments ?? [], created_at: Date.now(), body: { ...body, session_id: id } }
        queue.items.push(item)
        noteEvent("session", id)
        setTimeout(() => pumpQueue(id), 50)
        return json(res, 200, { object: "memento.queued", item: { ...item, body: undefined, run_id: null, sent_at: null, error: null } })
      }
      const index = queue.items.findIndex((item) => item.id === queueRoute[2])
      if (queueRoute[3] === "remove") {
        if (index >= 0) queue.items.splice(index, 1)
        noteEvent("session", id)
        return json(res, 200, { object: "memento.queue.removed", removed: index >= 0 })
      }
      if (index < 0) return json(res, 404, { error: { message: "That message isn't waiting any more." } })
      if (queueRoute[3] === "send") {
        const [item] = queue.items.splice(index, 1)
        queue.items.unshift({ ...item, error: undefined })
        queue.resumedAt = Date.now()
        setTimeout(() => pumpQueue(id), 50)
        return json(res, 200, queueView(id))
      }
      const running = sessionRuns(id).findLast((run) => run.status === "running" && !run.stopped)
      if (!running) return json(res, 409, { error: { message: "The reply isn't running, so it can't be steered." } })
      const item = queue.items[index]
      if (item.attachments?.length) return json(res, 409, { error: { message: "Only text can steer a reply." } })
      queue.items.splice(index, 1)
      running.pendingSteer = running.pendingSteer ? `${running.pendingSteer}\n${item.text}` : item.text
      const event = { event: "run.steered", run_id: running.id, timestamp: Date.now() / 1000, accepted: true, seq: running.seq++ }
      running.events.push(event)
      for (const listener of running.listeners) listener(event)
      noteEvent("session", id)
      return json(res, 200, { object: "memento.queue.steered", id: item.id, run_id: running.id, text: item.text })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/runs/live") {
      const sessions = {}
      const run_ids = {}
      for (const [runId, run] of runs.entries()) {
        if (!run.sessionId || !["running", "waiting_for_approval"].includes(run.status)) continue
        if (sessions[run.sessionId] !== "waiting_for_approval") {
          sessions[run.sessionId] = run.status
          run_ids[run.sessionId] = runId
        }
      }
      // Why each session waits: its run's questions or approval, else a plan to review.
      const waiting = {}
      for (const run of runs.values()) {
        if (!run.sessionId || run.status !== "waiting_for_approval") continue
        if (run.clarify) waiting[run.sessionId] = { kind: "question", count: run.clarify.questions?.length || 1 }
        else waiting[run.sessionId] ??= { kind: "approval", ...(run.approval?.command ? { command: run.approval.command } : {}) }
      }
      for (const record of projectSessions.values()) if (record.plan_pending) waiting[record.session_id] ??= { kind: "plan" }
      for (const record of projectSessions.values())
        if (record.mode === "theseus" && ["plan", "checkpoints", "approval", "closing"].includes(theseusRecord(record.session_id).stage))
          waiting[record.session_id] ??= { kind: "theseus", stage: theseusRecord(record.session_id).stage }
      for (const [id, reason] of Object.entries(waiting)) {
        const record = projectSessions.get(id)
        const name = record && mockProjects().find((p) => p.id === record.project_id)?.name
        if (name) reason.project = name
      }
      return json(res, 200, { object: "memento.runs", sessions, run_ids, waiting })
    }
    // Dev only: POST { stage } moves every Theseus run (and the next ones) to that stage.
    if (url.pathname === "/__mock/dictation" && req.method === "GET") {
      return json(res, 200, { clips: dictationClips })
    }
    // Dev only: POST { outcome } ends every pending approval without the app. "timeout" is a host
    // with the plugin (the run says so and carries on); "lost" one without it, which keeps the
    // stale request on the run's status and refuses an answer with approval_not_pending.
    if (url.pathname === "/__mock/approvals" && req.method === "POST") {
      const { outcome } = await readBody(req)
      for (const [id, resolve] of [...pendingApprovals]) {
        if (outcome === "lost") pendingApprovals.delete(id)
        else resolve("timeout")
      }
      return json(res, 200, { ok: true })
    }
    if (url.pathname === "/__mock/theseus" && req.method === "POST") {
      const { stage } = await readBody(req)
      if (!THESEUS_STAGES.includes(stage)) return json(res, 400, { error: { message: "No such stage." } })
      THESEUS_START = stage
      for (const run of theseusRuns.values()) run.stage = stage
      return json(res, 200, { ok: true })
    }
    const sessionRoute = /^\/api\/plugins\/memento\/sessions\/([^/]+)\/(workspace|workspace\/remove|mode|prs|library|close|theseus|theseus\/models|theseus\/evidence\/[^/]+\/[^/]+)$/.exec(url.pathname)
    if (PLUGIN && !profile && sessionRoute) {
      const id = decodeURIComponent(sessionRoute[1])
      const route = sessionRoute[2]
      const workspace = projectSessions.get(id)
      // What the plugin tells the agent about its worktrees, with every run, and in plan mode the
      // plan's shape (the plugin's PLAN_INSTRUCTIONS; keep them the same).
      const worktreeLine = (record) =>
        record.repos.length === 1
          ? `You are working in a git worktree of ${record.repos[0].name} at ${record.repos[0].path} (branch ${record.branch}). Keep all work inside it.`
          : `You are working in git worktrees of this project's repos, all on branch ${record.branch}:\n${record.repos.map((r, i) => `- ${r.name} at ${r.path}${i === 0 ? " (your current directory)" : ""}`).join("\n")}\nKeep all work inside them.`
      // The plugin's library line (sessions._files_line), word for word, with the session's path.
      const filesLine = (record) =>
        `Files you make for the user — screenshots, images, charts, reports, markdown — belong in this session's library at ${record.files_dir}, not in the worktree. File each one with the library_add tool (its path and a folder name, one level): name folders after the flow or change the files belong to, kebab-case — library-tab for work on the library tab, library-tab-tree-view for a follow-up change to it — not the file type, and file names kebab-case with their extension (dashboard-light.png). The tool makes ${record.files_dir}/<folder> if it needs to, moves the file there and answers with its new path; a name that isn't kebab-case, or a file of that name already in the folder, is an error — fix the name and call again. Return an image's new path in a MEDIA:<path> tag so the user sees it. Source edits stay in the worktree.`
      // A session's filed files, as the plugin's library routes would list them (see
      // `sessionLibrary` at module scope, shared with the project route).
      const instructions = (record) =>
        [worktreeLine(record), filesLine(record), PR_INSTRUCTIONS, DONE_INSTRUCTIONS, record.mode === "plan" ? PLAN_INSTRUCTIONS : "", record.mode === "theseus" ? THESEUS_INSTRUCTIONS : ""].filter(Boolean).join("\n")
      const answer = (record) =>
        json(res, 200, {
          object: "memento.workspace",
          workspace: record,
          instructions: record ? instructions(record) : null,
          blocked: record ? blockedReason(mockProjects().find((p) => p.id === record.project_id), record) : null,
        })
      if (route === "workspace" && req.method === "POST") {
        const { project_id, mode } = await readBody(req)
        const project = mockProjects().find((p) => p.id === String(project_id ?? ""))
        if (!project) return json(res, 400, { error: { message: "No such project." } })
        const reason = blockedReason(project, workspace)
        if (reason) return json(res, 409, { error: { message: reason } })
        if (!workspace && project.folders.some((f) => f.status === "cloning"))
          return json(res, 409, { error: { message: "A repository is still being added to this project." } })
        const gitFolders = project.folders.filter((f) => f.git)
        if (!gitFolders.length) return json(res, 400, { error: { message: "This project has no git repository." } })
        if (mode !== undefined && !MODES.includes(mode))
          return json(res, 400, { error: { message: "mode must be accept_edits, auto, plan or theseus." } })
        let record = workspace
        if (!record) {
          await sleep(800 * gitFolders.length)
          const pick = (words) => words[Math.floor(Math.random() * words.length)]
          const slug = `${pick(["jazzy", "cosmic", "fuzzy", "zesty", "nimble"])}-${pick(["hopper", "otter", "comet", "waffle", "quokka"])}-${randomUUID().slice(0, 4)}`
          const repos = gitFolders.map((f) => ({ name: f.repo, repo_root: f.path, path: `${f.path}/.worktrees/${slug}`, branch: `hermes/${slug}` }))
          record = { session_id: id, project_id: project.id, repo_root: repos[0].repo_root, path: repos[0].path, branch: repos[0].branch, mode: mode ?? "accept_edits", plan_pending: 0, created_at: Date.now(), repos, files_dir: `${repos[0].repo_root}/files/${slug}`, plan_file: null }
          projectSessions.set(id, record)
        } else if (mode && mode !== record.mode) {
          if (mode === "theseus" || record.mode === "theseus")
            return json(res, 409, { error: { message: record.mode === "theseus" ? "A Theseus session keeps its mode." : "Theseus can only start a new session." } })
          record.mode = mode
          record.plan_pending = 0
        }
        return answer(record)
      }
      if (route === "workspace") return answer(workspace ?? null)
      if (route.startsWith("theseus")) {
        if (workspace?.mode !== "theseus") return json(res, 404, { error: { message: "This isn't a Theseus session." } })
        const run = theseusRecord(id)
        if (route.startsWith("theseus/evidence/"))
          return (res.writeHead(200, { "Content-Type": "image/svg+xml", ...cors }), res.end(theseusCapture(route.endsWith("reference.svg"))))
        if (route === "theseus/models" && req.method === "POST") {
          const body = await readBody(req)
          const pick = (list) => (Array.isArray(list) ? list : []).slice(0, 2).map((m) => ({ provider: m?.provider || null, model: m?.model || null }))
          run.models = { review: pick(body.review), visual: pick(body.visual) }
        }
        if (route === "theseus" && req.method === "POST") {
          const body = await readBody(req)
          const need = (stage, what) => run.stage === stage || (json(res, 409, { error: { message: what } }), false)
          const step = {
            confirm_plan: () => need("plan", "there is no plan waiting for review") && ((run.stage = "planning"), setTimeout(() => (run.stage = "checkpoints"), 1500), true),
            revise_plan: () => need("plan", "there is no plan waiting for review") && ((run.stage = "discovery"), true),
            approve_checkpoints: () => need("checkpoints", "there are no checkpoints waiting for approval") && ((run.stage = "building"), true),
            approve: () => need("approval", "no checkpoint is awaiting approval") && ((run.stage = "closing"), true),
            request_changes: () => need("approval", "no checkpoint is awaiting approval") && ((run.stage = "building"), true),
            close: () => need("closing", "the run isn't waiting to be closed") && ((run.stage = body.decision === "confirm" ? "done" : "building"), true),
            settings: () => {
              for (const key of ["autonomy", "visual", "reviewers", "granularity"]) if (typeof body[key] === "string") run.settings[key] = body[key]
              return true
            },
          }[body.action]
          if (!step) return json(res, 400, { error: { message: `Unknown action ${body.action}.` } })
          if (!step()) return
        }
        return json(res, 200, theseusView(id))
      }
      if (route === "mode" && req.method === "POST") {
        const { mode } = await readBody(req)
        if (!MODES.includes(mode)) return json(res, 400, { error: { message: "mode must be accept_edits, auto, plan or theseus." } })
        if (!workspace) return json(res, 404, { error: { message: "This session has no workspace yet" } })
        // A Theseus session keeps its mode for good (mock of the planned plugin rule).
        if (mode !== workspace.mode && (mode === "theseus" || workspace.mode === "theseus"))
          return json(res, 409, { error: { message: workspace.mode === "theseus" ? "A Theseus session keeps its mode." : "Theseus can only start a new session." } })
        workspace.mode = mode
        workspace.plan_pending = 0
        // Switching to Auto answers what a run of the session already waits on, like the plugin.
        if (mode === "auto")
          for (const run of runs.values())
            if (run.sessionId === id && run.status === "waiting_for_approval") pendingApprovals.get(run.id)?.("once")
        return answer(workspace)
      }
      if (route === "workspace/remove" && req.method === "POST") {
        if (!workspace) return json(res, 200, { object: "memento.workspace.removed", removed: false, kept: [] })
        // The first repo keeps its tree after a turn that said "commit" (unpushed work).
        if (userTurns(id).some((r) => /commit/i.test(r.content)))
          return json(res, 200, { object: "memento.workspace.removed", removed: false, kept: [{ name: workspace.repos[0].name, reason: "unpushed" }] })
        projectSessions.delete(id)
        return json(res, 200, { object: "memento.workspace.removed", removed: true, kept: [] })
      }
      if (route === "close" && req.method === "POST") {
        if (!workspace) return json(res, 200, { object: "memento.closed", removed: true, kept: [], results: [] })
        const open = workspace.opened && !workspace.closed && !userTurns(id).some((r) => /merge|close/i.test(r.content))
        const results = workspace.opened ? workspace.repos.map((repo, i) => ({ name: repo.name, closed: open ? 27 + i : null, branch_deleted: true })) : []
        workspace.closed = true
        // The first repo keeps its tree after a turn that said "commit" (unpushed work).
        if (userTurns(id).some((r) => /commit/i.test(r.content)))
          return json(res, 200, { object: "memento.closed", removed: false, kept: [{ name: workspace.repos[0].name, reason: "unpushed" }], results })
        projectSessions.delete(id)
        return json(res, 200, { object: "memento.closed", removed: true, kept: [], results })
      }
      if (route === "library" && req.method === "GET") {
        // One worktree's filed files; an unknown session answers an empty tree, never a 404.
        return json(res, 200, {
          object: "memento.library",
          session_id: id,
          worktree: workspace ? workspace.files_dir.split("/").pop() : null,
          folders: workspace ? sessionLibrary(workspace) : [],
        })
      }
      if (route === "prs" && req.method === "GET") {
        // A PR per repo once the agent opened them; "merge" merges them, "break" fails their
        // checks, and "pending" runs them for a while before they pass.
        const turns = userTurns(id)
        const said = (word) => turns.some((r) => new RegExp(word, "i").test(r.content))
        const state = workspace?.closed || said("close") ? "closed" : said("merge") ? "merged" : workspace?.opened?.draft ? "draft" : "open"
        const pendingTurn = turns.findLast((r) => /pending/i.test(r.content))
        const checksRunning =
          pendingTurn && Date.now() / 1000 - pendingTurn.timestamp < PENDING_CHECK_S

        const prs = workspace?.opened
          ? workspace.repos.map((repo, i) => ({
              repo: repo.name,
              number: 27 + i,
              title: workspace.opened.title,
              url: `https://github.com/${repo.name}/pull/${27 + i}`,
              state,
              checks: said("break") ? "failure" : checksRunning ? "pending" : "success",
            }))
          : []
        // Like the plugin: a merge resolves the session in the chat list, once.
        if (prs.length && prs.every((pr) => pr.state === "merged") && !workspace.mergeResolved) {
          workspace.mergeResolved = true
          for (const [chatId, entry] of pluginChats)
            if (entry.value?.hermesSessionId === id && !entry.value.resolvedAt)
              pluginChats.set(chatId, { at: Math.max(Date.now(), entry.at + 1), value: { ...entry.value, resolvedAt: Date.now() } })
        }
        return json(res, 200, { object: "memento.prs", prs })
      }
    }
    const chatSession = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
    if (req.method === "GET" && chatSession) {
      const id = decodeURIComponent(chatSession[1])
      if (!chatTitles.has(id)) return json(res, 404, { error: { message: "Session not found" } })
      return json(res, 200, { object: "hermes.session", session: {
          id,
          source: labelledSessions.get(id) ?? "api_server",
          title: chatTitles.get(id),
        },
      })
    }
    const sessionMessages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
    if (sessionMessages) {
      const id = decodeURIComponent(sessionMessages[1])
      if (!transcripts.has(id)) return json(res, 404, { error: { message: "Session not found" } })
      const data = pageRows(transcripts.get(id), url.searchParams)
      return json(res, 200, { object: "list", session_id: id, data })
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return streamCompletion(req, res, await readBody(req))
    }
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        object: "hermes.api_server.capabilities",
        features: { chat_completions: true, chat_completions_streaming: true, run_submission: RUNS, run_events_sse: RUNS, run_stop: RUNS, run_steer: RUNS },
      })
    }
    if (RUNS && req.method === "POST" && url.pathname === "/v1/runs") {
      const run = startRun(req, await readBody(req))
      return json(res, 202, { run_id: run.id, status: "started", replayed: false })
    }
    const runPath = /^\/v1\/runs\/([^/]+)(\/events|\/stop|\/steer)?$/.exec(url.pathname)
    if (RUNS && runPath) {
      const run = runs.get(runPath[1])
      if (!run) return json(res, 404, { error: { message: `Run not found: ${runPath[1]}`, code: "run_not_found" } })
      if (runPath[2] === "/events") return streamRunEvents(req, res, run, Number(url.searchParams.get("last_seq") ?? -1))
      if (runPath[2] === "/stop" && req.method === "POST") {
        run.stopped = true
        pendingApprovals.get(run.id)?.("deny")
        return json(res, 200, { run_id: run.id, status: "stopping" })
      }
      if (runPath[2] === "/steer" && req.method === "POST") {
        if (run.status !== "running" || run.stopped) return json(res, 409, { error: { message: `Run is not currently accepting steer input: ${run.id}`, code: "run_not_accepting_steer" } })
        const { input, message, text } = await readBody(req)
        const steer = String(input || message || text || "").trim()
        if (!steer) return json(res, 400, { error: { message: "Missing non-empty steer text; expected 'input', 'message', or 'text'.", code: "invalid_steer_input" } })
        run.pendingSteer = run.pendingSteer ? `${run.pendingSteer}\n${steer}` : steer
        const event = { event: "run.steered", run_id: run.id, timestamp: Date.now() / 1000, accepted: true, seq: run.seq++ }
        run.events.push(event)
        for (const listener of run.listeners) listener(event)
        return json(res, 200, { object: "hermes.run.steer", run_id: run.id, accepted: true })
      }
      if (!runPath[2]) return json(res, 200, runStatus(run))
    }
    const approval = /^\/v1\/runs\/([^/]+)\/approval$/.exec(url.pathname)
    if (req.method === "POST" && approval) {
      const resolve = pendingApprovals.get(approval[1])
      if (!resolve) return json(res, 409, { error: { message: "Run has no pending approval", code: "approval_not_pending" } })
      const { choice } = await readBody(req)
      resolve(choice)
      return json(res, 200, { object: "hermes.run.approval_response", run_id: approval[1], choice, resolved: 1 })
    }
    // aiohttp raises its unmatched-route 404 past Hermes's CORS middleware, so browsers block it.
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Not found" } }))
  })
  .listen(PORT, () => console.log(`Mock Hermes on http://localhost:${PORT}/v1`))
