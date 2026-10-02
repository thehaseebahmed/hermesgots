// Dev-only stand-in for the Hermes Agent API server (port 8642). It speaks the same wire format
// as gateway/platforms/api_server*.py: chat.completion.chunk frames plus the named SSE events
// `hermes.tool.progress`, `hermes.status` and `approval.request`, and answers approvals on
// POST /v1/runs/{id}/approval. Mention "clean" or "delete" in a message to trigger an approval.
// Cron jobs live on /api/jobs, and their past runs show up as /api/sessions?source=cron. Like
// Hermes, a run that died on provider errors still ends `cron_complete`, behind a `failed_turn` row.
// Chats are titled like Hermes does: a slice of the opener at once, a "model" title a moment later,
// readable on GET /api/sessions/{id}. Sessions are keyed by X-Hermes-Session-Id when a key is sent.
//
//   pnpm mock            # then point Settings at http://localhost:8642/v1

import http from "node:http"
import { randomUUID } from "node:crypto"

const PORT = Number(process.env.PORT ?? 8642)
const pendingApprovals = new Map()
const chatTitles = new Map()
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
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace(/-|:/g, "").replace("T", "_")

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
    last_error: lastDone && !lastDone.ok ? "Timed out waiting for https://status.example.com" : null,
    failure_streak: streak,
    latest_execution: last && {
      status: !last.end ? "running" : last.ok ? "completed" : "failed",
      claimed_at: iso(last.start - 500),
      started_at: iso(last.start),
      finished_at: iso(last.end),
      error: last.end && !last.ok ? "Timed out waiting for https://status.example.com" : null,
    },
  }
}

function cronSessions(profile) {
  // Like Hermes, a session per agent run; ended_at stays null while it runs.
  return cronJobs(profile).flatMap((job) =>
    job.runs.map((run) => ({
      id: `cron_${job.id}_${stamp(run.start)}`,
      source: "cron",
      title: job.name,
      started_at: run.start / 1000,
      ended_at: run.end ? run.end / 1000 : null,
      end_reason: !run.end
        ? null
        : run.ok || run.provider
          ? "cron_complete"
          : "cron_incomplete_no_output",
    })),
  ).sort((a, b) => b.started_at - a.started_at)
}

function cronSessionTail(profile, sessionId) {
  const run = cronJobs(profile)
    .flatMap((job) => job.runs.map((run) => ({ run, id: `cron_${job.id}_${stamp(run.start)}` })))
    .find((entry) => entry.id === sessionId)?.run
  if (!run) return undefined
  if (run.ok) return { role: "assistant", content: "All good.", finish_reason: "stop" }
  if (run.provider) {
    return { role: "assistant", content: "The model provider didn't respond.", display_kind: "failed_turn" }
  }
  return { role: "tool", content: "{}" }
}

function titleChat(req, opener) {
  const sessionId = req.headers["x-hermes-session-id"]
  if (!sessionId || !req.headers.authorization || chatTitles.has(sessionId)) return
  const line = opener.trim().split("\n")[0]
  chatTitles.set(sessionId, line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line)
  const words = line.replace(/[^\p{L}\p{N}\s-]/gu, "").split(/\s+/).filter(Boolean).slice(0, 4)
  const title = words.length > 1 ? words.join(" ").replace(/^./, (c) => c.toUpperCase()) : "Friendly greeting"
  setTimeout(() => chatTitles.set(sessionId, title), 2000)
}

async function streamCompletion(req, res, body) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model ?? "hermes-agent"
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? ""
  let closed = false
  let pieces = 0
  titleChat(req, last)
  req.on("close", () => (closed = true))

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors })
  const frame = (data, event) => {
    if (!closed) res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
  }
  const chunk = (delta, finish_reason = null, extra = {}) =>
    frame({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })
  const say = async (text) => {
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
      if (closed) return
      pieces += 1
      chunk({ content: piece })
      await sleep(25)
    }
  }

  chunk({ role: "assistant" })
  frame({ kind: "thinking", text: "Thinking…" }, "hermes.status")
  await sleep(500)

  const toolCallId = `call_${randomUUID().slice(0, 8)}`
  frame({ tool: "terminal", emoji: "💻", label: "du -sh /var/log/* | sort -rh | head", toolCallId, status: "running" }, "hermes.tool.progress")
  await sleep(1400)
  frame({ tool: "terminal", toolCallId, status: "completed" }, "hermes.tool.progress")

  await say(
    "Here's where the space is going under `/var/log`:\n\n" +
      "- `nginx/access.log.*` — **2.1 GB** across 34 files\n" +
      "- `postgres/*.log` — 1.4 GB, the oldest from March\n" +
      "- `app/debug.log.*` — 0.7 GB, left over from the verbose-logging experiment\n\n"
  )

  if (/clean|delete/i.test(last)) {
    await say("The live logs and anything written in the last 90 days stay untouched. Here is the command I want to run:\n\n```bash\nfind /var/log -name '*.log.*' -mtime +90 -delete\n```\n")
    const cleanupId = `call_${randomUUID().slice(0, 8)}`
    frame({ tool: "terminal", emoji: "💻", label: "find /var/log -name '*.log.*' -mtime +90 -delete", toolCallId: cleanupId, status: "running" }, "hermes.tool.progress")
    const decision = new Promise((resolve) => pendingApprovals.set(id, resolve))
    frame(
      {
        command: "find /var/log -name '*.log.*' -mtime +90 -delete",
        pattern_key: "recursive_delete",
        description: "Delete 34 rotated log files older than 90 days (4.2 GB) under /var/log",
        allow_permanent: true,
        allow_session: true,
        event: "approval.request",
        run_id: id,
        timestamp: Date.now() / 1000,
        choices: ["once", "session", "always", "deny"],
      },
      "approval.request"
    )
    const choice = await Promise.race([decision, sleep(120_000).then(() => "timeout")])
    pendingApprovals.delete(id)
    frame({ tool: "terminal", toolCallId: cleanupId, status: "completed" }, "hermes.tool.progress")
    await say(choice === "deny" || choice === "timeout"
      ? "\nOkay, I left everything as it is."
      : "\nDone — freed **4.2 GB**. The live logs are untouched.")
  } else {
    await say("Want me to clean up the rotated files older than 90 days? Just say *clean them up*.")
  }

  // Like Hermes, usage sums every model call in the turn: a fixed system prompt plus the transcript,
  // counted once per call (this turn makes one call per tool, plus the reply).
  const transcript = (body.messages ?? []).reduce((n, m) => n + String(m.content ?? "").length, 0)
  const calls = /clean|delete/i.test(last) ? 3 : 2
  const prompt_tokens = calls * (6000 + Math.round(transcript / 4))
  const completion_tokens = pieces
  chunk({}, "stop", { usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens } })
  if (!closed) res.end("data: [DONE]\n\n")
}

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
    if (url.pathname === "/api/sessions") {
      const source = url.searchParams.get("source")
      const limit = Number(url.searchParams.get("limit") ?? 50)
      const data = source === "cron" ? cronSessions(profile).slice(0, limit) : []
      return json(res, 200, { object: "list", data, limit, offset: 0, has_more: false })
    }
    const chatSession = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
    if (req.method === "GET" && chatSession) {
      const id = decodeURIComponent(chatSession[1])
      if (!chatTitles.has(id)) return json(res, 404, { error: { message: "Session not found" } })
      return json(res, 200, { object: "hermes.session", session: { id, source: "api_server", title: chatTitles.get(id) } })
    }
    const sessionMessages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
    if (sessionMessages) {
      const id = decodeURIComponent(sessionMessages[1])
      const tail = cronSessionTail(profile, id)
      if (!tail) return json(res, 404, { error: { message: "Session not found" } })
      return json(res, 200, { object: "list", session_id: id, data: [{ session_id: id, ...tail }] })
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return streamCompletion(req, res, await readBody(req))
    }
    const approval = /^\/v1\/runs\/([^/]+)\/approval$/.exec(url.pathname)
    if (req.method === "POST" && approval) {
      const resolve = pendingApprovals.get(approval[1])
      if (!resolve) return json(res, 409, { error: { message: "Run has no pending approval", code: "approval_not_pending" } })
      const { choice } = await readBody(req)
      resolve(choice)
      return json(res, 200, { object: "hermes.run.approval_response", run_id: approval[1], choice, resolved: 1 })
    }
    json(res, 404, { error: { message: "Not found" } })
  })
  .listen(PORT, () => console.log(`Mock Hermes on http://localhost:${PORT}/v1`))
