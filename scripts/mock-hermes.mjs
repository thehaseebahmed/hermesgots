// Dev-only stand-in for the Hermes Agent API server (port 8642). It speaks the same wire format
// as gateway/platforms/api_server*.py: chat.completion.chunk frames plus the named SSE events
// `hermes.tool.progress`, `hermes.status` and `approval.request`, and answers approvals on
// POST /v1/runs/{id}/approval. Mention "clean" or "delete" in a message to trigger an approval.
//
//   pnpm mock            # then point Settings at http://localhost:8642/v1

import http from "node:http"
import { randomUUID } from "node:crypto"

const PORT = Number(process.env.PORT ?? 8642)
const pendingApprovals = new Map()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

async function streamCompletion(req, res, body) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 29)}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model ?? "hermes-agent"
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? ""
  let closed = false
  let pieces = 0
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
      return json(res, 200, { model: "claude-sonnet-4.5", provider: "openrouter", providers: [] })
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
