// Dev-only stand-in for the Hermes Agent API server (port 8642). It speaks the same wire format
// as gateway/platforms/api_server*.py: chat.completion.chunk frames plus the named SSE events
// `hermes.tool.progress`, `hermes.status` and `approval.request`, and answers approvals on
// POST /v1/runs/{id}/approval. Mention "clean" or "delete" in a message to trigger an approval.
// Cron jobs live on /api/jobs, and their past runs on GET /api/plugins/memento/cron/runs, like a
// Hermes with the Memento plugin (MOCK_NO_PLUGIN=1 leaves it out). As on Hermes, the plugin isn't
// served under /p/<profile>/, and an unknown route's 404 carries no CORS headers.
// The plugin also keeps the chat list (GET and POST /api/plugins/memento/chats, newer record wins) and
// labels a chat as Memento's on POST /api/plugins/memento/sessions/{id}/label. Its
// GET /api/plugins/memento/sessions/{id}/context reports a keyed session's latest model call.
// Chats are titled like Hermes does: a slice of the opener at once, a "model" title a moment later,
// readable on GET /api/sessions/{id}. Sessions are keyed by X-Hermes-Session-Id when a key is sent,
// and their transcripts page back from GET /api/sessions/{id}/messages?order=latest&limit&offset.
// Turns also run on POST /v1/runs, whose events replay from GET /v1/runs/{id}/events?last_seq=N and
// which keep going when the client drops, unlike a chat completion. Say "long" for a slow reply.
//
//   pnpm mock            # then point Settings at http://localhost:8642/v1

import http from "node:http"
import { randomUUID } from "node:crypto"

const PORT = Number(process.env.PORT ?? 8642)
const pendingApprovals = new Map()
const chatTitles = new Map()
/** Sessions the Memento plugin has labelled, which then report `source: "memento"`. */
const labelledSessions = new Set()
/** The plugin's chat list: id -> { at, deleted?, value? }. */
const pluginChats = new Map()
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

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...cors })
  res.end(JSON.stringify(body))
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
  const make = (n, name, display, every, { paused = false, streak = 0, history = 30 } = {}) => {
    const now = Date.now()
    const runs = Array.from({ length: history }, (_, i) => {
      // The latest run was a third of a period ago, so the next one is still ahead.
      const start = now - (history - i - 0.67) * every * MINUTE
      const failed = i >= history - streak || (i * 7 + seed) % 11 === 0
      const end = start + 20_000 + ((i * 13) % 50) * 1000
      return { start, end, ok: !failed, provider: failed && i % 2 === 0 }
    })
    return { id: `${seed.toString(16)}a${n}c0ffee`.slice(0, 12), name, display, every, paused, runs }
  }
  const jobs = [
    make(1, "Inbox triage", "every 60m", 60),
    make(2, "Uptime check", "every 15m", 15, { streak: 2 }),
    make(3, "Morning digest", "0 8 * * *", 1440, { paused: true, history: 9 }),
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
    schedule: { kind: "interval", display: job.display },
    schedule_display: job.display,
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
  setTimeout(() => chatTitles.set(sessionId, title), 2000)
}

/** Stores a transcript row the way Hermes's session DB does, for keyed sessions only. */
function record(req, row) {
  const sessionId = sessionOf(req)
  if (!sessionId || !req.headers.authorization) return
  if (!transcripts.has(sessionId)) transcripts.set(sessionId, [])
  transcripts.get(sessionId).push({ id: ++lastRowId, session_id: sessionId, timestamp: Date.now() / 1000, ...row })
}

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
  const say = async (text) => {
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
      if (out.closed()) return
      pieces += 1
      spoken += piece
      out.say(piece)
      await sleep(25)
    }
  }

  out.status("Thinking…")
  await sleep(500)

  const toolCallId = `call_${randomUUID().slice(0, 8)}`
  out.tool({ tool: "terminal", emoji: "💻", label: "du -sh /var/log/* | sort -rh | head", toolCallId, status: "running" })
  await sleep(1400)
  // Hermes's terminal tool returns a JSON envelope.
  const duOutput = JSON.stringify({ output: "2.1G nginx\n1.4G postgres\n0.7G app", exit_code: 0, error: null })
  out.tool({ tool: "terminal", toolCallId, status: "completed", result: duOutput })
  record(req, { role: "assistant", content: null, tool_calls: [{ id: toolCallId, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "du -sh /var/log/* | sort -rh | head" }) } }] })
  record(req, { role: "tool", tool_call_id: toolCallId, tool_name: "terminal", content: duOutput })

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

  await say(
    "Here's where the space is going under `/var/log`:\n\n" +
      "- `nginx/access.log.*` — **2.1 GB** across 34 files\n" +
      "- `postgres/*.log` — 1.4 GB, the oldest from March\n" +
      "- `app/debug.log.*` — 0.7 GB, left over from the verbose-logging experiment\n\n"
  )

  if (/clean|delete/i.test(last)) {
    await say("The live logs and anything written in the last 90 days stay untouched. Here is the command I want to run:\n\n```bash\nfind /var/log -name '*.log.*' -mtime +90 -delete\n```\n")
    const cleanupId = `call_${randomUUID().slice(0, 8)}`
    out.tool({ tool: "terminal", emoji: "💻", label: "find /var/log -name '*.log.*' -mtime +90 -delete", toolCallId: cleanupId, status: "running" })
    const choice = await out.approve({
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
    }
  } else {
    await say("Want me to clean up the rotated files older than 90 days? Just say *clean them up*.")
  }

  // Like Hermes, usage sums every model call in the turn: a fixed system prompt plus the transcript,
  // counted once per call (this turn makes one call per tool, plus the reply).
  // A keyed session's history comes from the session store, not the body, as on Hermes.
  const sessionId = sessionOf(req, body)
  const keyed = sessionId && req.headers.authorization && transcripts.get(sessionId)
  const context = keyed ? keyed.filter((row) => row.role !== "tool") : (body.messages ?? body.input ?? [])
  const transcript = context.reduce((n, m) => n + String(m.content ?? "").length, 0)
  const calls = /clean|delete/i.test(last) ? 3 : 2
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
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? ""
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
    tool: ({ result: _result, ...event }) => frame(event, "hermes.tool.progress"),
    approve(event) {
      frame({ ...event, event: "approval.request", run_id: id, timestamp: Date.now() / 1000, choices: ["once", "session", "always", "deny"] }, "approval.request")
      return waitForApproval(id)
    },
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
const runs = new Map()
const RUNS = process.env.MOCK_NO_RUNS !== "1"
const RUN_BACKLOG = Number(process.env.MOCK_RUN_BACKLOG ?? 1000)
const DROP_EVENTS_MS = Number(process.env.MOCK_DROP_EVENTS_MS ?? 0)
const BLOCK_RUN_EVENTS = process.env.MOCK_BLOCK_RUN_EVENTS === "1"

const sessionOf = (req, body) => req.headers["x-hermes-session-id"] ?? body?.session_id

function startRun(req, body) {
  const key = req.headers["idempotency-key"]
  const replay = key && [...runs.values()].find((run) => run.key === key)
  if (replay) return replay
  const id = `run_${randomUUID().replace(/-/g, "")}`
  const run = { id, key, status: "running", events: [], seq: 0, listeners: new Set(), stopped: false }
  runs.set(id, run)
  const push = (name, fields = {}) => {
    const event = { event: name, run_id: id, timestamp: Date.now() / 1000, ...fields, seq: run.seq++ }
    run.events.push(event)
    if (run.events.length > RUN_BACKLOG) run.events.shift()
    for (const listener of run.listeners) listener(event)
  }
  const input = Array.isArray(body.input) ? body.input : [{ role: "user", content: String(body.input ?? "") }]
  const last = input.at(-1)?.content ?? ""
  // Rows go to the session named in the body, as on Hermes.
  const sessionReq = { headers: { ...req.headers, "x-hermes-session-id": body.session_id } }
  void playTurn(sessionReq, body, last, {
    closed: () => run.stopped,
    say: (delta) => push("message.delta", { delta }),
    status: () => {},
    tool: ({ tool, label, status, result }) =>
      push(status === "running" ? "tool.started" : "tool.completed", status === "running" ? { tool, preview: label } : { tool, duration: 1.4, error: false, preview: result ?? "" }),
    approve(event) {
      run.status = "waiting_for_approval"
      push("approval.request", { ...event, choices: ["once", "session", "always", "deny"] })
      return waitForApproval(id).finally(() => (run.status = "running"))
    },
  }).then(({ spoken, prompt_tokens, completion_tokens }) => {
    run.status = run.stopped ? "cancelled" : "completed"
    run.output = spoken
    run.usage = { input_tokens: prompt_tokens, output_tokens: completion_tokens, total_tokens: prompt_tokens + completion_tokens }
    push(`run.${run.status}`, { completed: !run.stopped, interrupted: run.stopped, output: spoken, usage: run.usage })
    for (const listener of run.listeners) listener(null)
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
  res.on("close", () => run.listeners.delete(listener))
  if (DROP_EVENTS_MS) setTimeout(() => res.destroy(), DROP_EVENTS_MS)
}

const runStatus = (run) => ({
  object: "hermes.run",
  run_id: run.id,
  status: run.status,
  ...(run.output !== undefined ? { output: run.output, usage: run.usage } : {}),
})

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
    if (req.method === "OPTIONS") return res.writeHead(200, cors).end()
    // Like a gateway with multiplex_profiles: other profiles live under /p/<profile>/.
    const profile = /^\/p\/([^/]+)(?=\/)/.exec(url.pathname)?.[1]
    if (profile) url.pathname = url.pathname.slice(profile.length + 3)
    if (url.pathname === "/health") return json(res, 200, { status: "ok", platform: "mock-hermes" })
    if (url.pathname === "/v1/models") {
      // Named profiles advertise their name as the model id.
      const id = profile ?? "hermes-agent"
      return json(res, 200, { object: "list", data: [{ id, object: "model", owned_by: "hermes" }] })
    }
    if (url.pathname === "/api/model/options") {
      // Named profiles report a model models.dev doesn't know, to exercise manual entry.
      const model = profile ? `mock-model-${profile}` : "anthropic/claude-sonnet-4.5"
      return json(res, 200, { model, provider: "openrouter", providers: [] })
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
        version: "0.3.0",
        features: ["cron_runs", "session_label", "chats", "context"],
      })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/cron/runs") {
      const perJob = Math.max(1, Math.min(Number(url.searchParams.get("per_job") ?? 24) || 24, 200))
      const jobs = Object.fromEntries(
        cronJobs().map((job) => [job.id, job.runs.slice(-perJob).reverse().map((run) => ledgerRow(job, run))]),
      )
      return json(res, 200, { object: "cron_runs", jobs })
    }
    if (PLUGIN && !profile && url.pathname === "/api/plugins/memento/chats") {
      if (req.method === "POST") {
        const { chats } = await readBody(req)
        if (!chats || typeof chats !== "object") {
          return json(res, 400, { error: { message: "chats must be an object" } })
        }
        for (const [id, entry] of Object.entries(chats)) {
          if (entry.at > (pluginChats.get(id)?.at ?? -1)) pluginChats.set(id, entry)
        }
      }
      return json(res, 200, { object: "memento.chats", chats: Object.fromEntries(pluginChats) })
    }
    const sessionLabel = /^\/api\/plugins\/memento\/sessions\/([^/]+)\/label$/.exec(url.pathname)
    if (PLUGIN && !profile && req.method === "POST" && sessionLabel) {
      const id = decodeURIComponent(sessionLabel[1])
      if (!chatTitles.has(id)) return json(res, 404, { error: { message: "Session not found" } })
      labelledSessions.add(id)
      return json(res, 200, { id, source: "memento" })
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
    const chatSession = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
    if (req.method === "GET" && chatSession) {
      const id = decodeURIComponent(chatSession[1])
      if (!chatTitles.has(id)) return json(res, 404, { error: { message: "Session not found" } })
      return json(res, 200, { object: "hermes.session", session: {
          id,
          source: labelledSessions.has(id) ? "memento" : "api_server",
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
        features: { chat_completions: true, chat_completions_streaming: true, run_submission: RUNS, run_events_sse: RUNS, run_stop: RUNS },
      })
    }
    if (RUNS && req.method === "POST" && url.pathname === "/v1/runs") {
      const run = startRun(req, await readBody(req))
      return json(res, 202, { run_id: run.id, status: "started", replayed: false })
    }
    const runPath = /^\/v1\/runs\/([^/]+)(\/events|\/stop)?$/.exec(url.pathname)
    if (RUNS && runPath) {
      const run = runs.get(runPath[1])
      if (!run) return json(res, 404, { error: { message: `Run not found: ${runPath[1]}`, code: "run_not_found" } })
      if (runPath[2] === "/events") return streamRunEvents(req, res, run, Number(url.searchParams.get("last_seq") ?? -1))
      if (runPath[2] === "/stop" && req.method === "POST") {
        run.stopped = true
        pendingApprovals.get(run.id)?.("deny")
        return json(res, 200, { run_id: run.id, status: "stopping" })
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
