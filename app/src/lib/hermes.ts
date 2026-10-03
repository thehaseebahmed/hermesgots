import type { ApprovalChoice } from "@/lib/db"
import { isNative } from "@/lib/native"

/**
 * Client for the Hermes Agent API server (OpenAI-compatible, default port 8642).
 *
 * Streams `/v1/chat/completions` and parses the SSE ourselves because Hermes interleaves
 * named events (`hermes.tool.progress`, `hermes.status`, `approval.request`) with the
 * standard `chat.completion.chunk` frames; OpenAI SDKs silently drop those.
 */

export interface HermesConfig {
  baseUrl: string
  apiKey: string
}

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface ToolProgressEvent {
  tool: string
  emoji?: string
  label?: string
  /** Runs don't name tool calls; their completions match the oldest running call of the tool. */
  toolCallId?: string
  status: "running" | "completed"
}

export interface ApprovalRequestEvent {
  run_id: string
  command?: string
  description?: string
  choices?: ApprovalChoice[]
}

export interface StreamHandlers {
  onRunId?: (runId: string) => void
  onContent?: (delta: string) => void
  onReasoning?: (delta: string) => void
  /** A whole reasoning block; runs only report them once a non-streaming provider finishes. */
  onReasoningBlock?: (text: string) => void
  onTool?: (event: ToolProgressEvent) => void
  onStatus?: (text: string) => void
  onApproval?: (event: ApprovalRequestEvent) => void
}

/** Hermes sums these over every model call in the turn, tool loops included. */
export interface TurnUsage {
  promptTokens: number
  completionTokens: number
}

export interface StreamResult {
  finishReason: string | null
  usage?: TurnUsage
}

export class HermesError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "HermesError"
    this.status = status
  }
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`
}

/** Root of the server (strips a trailing `/v1`), for non-OpenAI routes like `/health`. */
function serverRoot(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function headers(config: HermesConfig, extra?: Record<string, string>) {
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra }
  if (config.apiKey) h.Authorization = `Bearer ${config.apiKey}`
  return h
}

async function request(url: string, init: RequestInit) {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error
    throw new HermesError(networkHint(url))
  }
  if (!response.ok) {
    throw new HermesError(await errorMessage(response), response.status)
  }
  return response
}

function networkHint(url: string) {
  const insecure = url.startsWith("http://")
  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(url)
  if (insecure && !local && !isNative && window.location.protocol === "https:") {
    return "Can't reach Hermes: this page is HTTPS, so the browser blocks plain-HTTP servers on other hosts. Put Hermes behind HTTPS (e.g. Tailscale Serve or a Cloudflare Tunnel)."
  }
  return `Can't reach Hermes. Check it's running and that API_SERVER_CORS_ORIGINS includes ${window.location.origin}.`
}

async function errorMessage(response: Response) {
  try {
    const body = await response.json()
    const message = body?.error?.message ?? body?.message
    if (message) return String(message)
  } catch {
    // Not JSON; fall through.
  }
  if (response.status === 401) return "Hermes rejected the API key."
  return `Hermes returned ${response.status} ${response.statusText}`.trim()
}

/** Yields `{event, data}` for each SSE frame in the body. */
async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
        let event = "message"
        const data: string[] = []
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith(":")) continue
          const colon = line.indexOf(":")
          const field = colon === -1 ? line : line.slice(0, colon)
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
          if (field === "event") event = value
          else if (field === "data") data.push(value)
        }
        if (data.length) yield { event, data: data.join("\n") }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function streamChat(
  config: HermesConfig,
  options: {
    model: string
    messages: ChatMessage[]
    sessionId?: string
    signal?: AbortSignal
  },
  handlers: StreamHandlers,
): Promise<StreamResult> {
  // Hermes only accepts X-Hermes-Session-Id when an API key is configured.
  const sessionHeader: Record<string, string> =
    options.sessionId && config.apiKey ? { "X-Hermes-Session-Id": options.sessionId } : {}

  const response = await request(endpoint(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: headers(config, sessionHeader),
    body: JSON.stringify({ model: options.model, messages: options.messages, stream: true }),
    signal: options.signal,
  })
  if (!response.body) throw new HermesError("Hermes returned an empty response.")

  let finishReason: string | null = null
  let usage: TurnUsage | undefined
  let runId: string | null = null

  for await (const { event, data } of readSse(response.body)) {
    if (data === "[DONE]") break
    let payload: any
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }

    switch (event) {
      case "hermes.tool.progress":
        handlers.onTool?.(payload as ToolProgressEvent)
        break
      case "hermes.status":
        if (payload?.text) handlers.onStatus?.(String(payload.text))
        break
      case "approval.request":
        handlers.onApproval?.(payload as ApprovalRequestEvent)
        break
      default: {
        if (payload?.error) {
          throw new HermesError(payload.error.message ?? "Hermes reported an error.")
        }
        if (!runId && typeof payload?.id === "string") {
          runId = payload.id
          handlers.onRunId?.(payload.id)
        }
        const choice = payload?.choices?.[0]
        const delta = choice?.delta
        if (delta?.reasoning_content) handlers.onReasoning?.(delta.reasoning_content)
        if (delta?.content) handlers.onContent?.(delta.content)
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (payload?.usage) {
          usage = {
            promptTokens: Number(payload.usage.prompt_tokens) || 0,
            completionTokens: Number(payload.usage.completion_tokens) || 0,
          }
        }
      }
    }
  }

  return { finishReason, usage }
}

/** Answer a dangerous-command prompt raised mid-stream. `runId` is the completion id. */
export async function respondToApproval(
  config: HermesConfig,
  runId: string,
  choice: ApprovalChoice,
) {
  await request(endpoint(config.baseUrl, `/runs/${encodeURIComponent(runId)}/approval`), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ choice }),
  })
}

export async function listModels(config: HermesConfig): Promise<string[]> {
  const response = await request(endpoint(config.baseUrl, "/models"), {
    headers: headers(config),
  })
  const body = await response.json()
  return Array.isArray(body?.data) ? body.data.map((m: { id: string }) => m.id) : []
}

export interface Skill {
  name: string
  description?: string | null
  category?: string | null
}

export async function listSkills(config: HermesConfig): Promise<Skill[]> {
  const response = await request(endpoint(config.baseUrl, "/skills"), {
    headers: headers(config),
  })
  const body = await response.json()
  // The code returns an OpenAI-style list; the docs show a bare array. Accept both.
  const data: unknown = Array.isArray(body) ? body : body?.data
  return Array.isArray(data)
    ? data.filter((s): s is Skill => typeof s?.name === "string" && s.name.length > 0)
    : []
}

export interface ModelInfo {
  model?: string
  provider?: string
}

/** The LLM and provider behind the profile. Newer Hermes only, so callers treat null as unknown. */
export async function getModelInfo(config: HermesConfig): Promise<ModelInfo | null> {
  try {
    const response = await request(`${serverRoot(config.baseUrl)}/api/model/options`, {
      headers: headers(config),
    })
    const body = await response.json()
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
    return { model: text(body?.model), provider: text(body?.provider) }
  } catch {
    return null
  }
}

export async function checkHealth(config: HermesConfig) {
  const response = await request(`${serverRoot(config.baseUrl)}/health`, {
    headers: headers(config),
  })
  return response.json().catch(() => ({}))
}

/** The title Hermes gave a session (it auto-titles chats in the background). Best effort. */
export async function getSessionTitle(
  config: HermesConfig,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const response = await request(
      `${serverRoot(config.baseUrl)}/api/sessions/${encodeURIComponent(sessionId)}`,
      { headers: headers(config) },
    )
    const body = await response.json()
    const title = body?.session?.title
    return typeof title === "string" && title.trim() ? title.trim() : undefined
  } catch {
    return undefined
  }
}

/** A stored transcript row, as `GET /api/sessions/{id}/messages` returns it. */
export interface SessionMessage {
  id: number
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null
  tool_call_id?: string | null
  tool_calls?: { id?: string; function?: { name?: string } }[] | string | null
  tool_name?: string | null
  /** Unix seconds. */
  timestamp?: number | null
  reasoning?: string | null
  reasoning_content?: string | null
  display_kind?: string | null
  finish_reason?: string | null
}

/**
 * One page of a session's transcript, counted back from the newest row (`offset` rows skipped)
 * but returned oldest first. A 404 means Hermes has no such session.
 */
export async function listSessionMessages(
  config: HermesConfig,
  sessionId: string,
  { limit, offset }: { limit: number; offset: number },
): Promise<SessionMessage[]> {
  const query = new URLSearchParams({ order: "latest", limit: `${limit}`, offset: `${offset}` })
  try {
    const response = await request(
      `${serverRoot(config.baseUrl)}/api/sessions/${encodeURIComponent(sessionId)}/messages?${query}`,
      { headers: headers(config) },
    )
    const body = await response.json()
    const data: unknown = body?.data
    return Array.isArray(data) ? data.filter((m) => typeof m?.id === "number") : []
  } catch (error) {
    if (error instanceof HermesError && error.status === 404) return []
    throw error
  }
}

/** Hermes's newest execution-ledger row for a job (newer versions only). */
export interface CronExecution {
  status: "claimed" | "running" | "completed" | "failed" | "unknown"
  claimed_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  error?: string | null
}

export interface CronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  /** `scheduled`, `paused`, `running`, `completed` or `error`. */
  state?: string
  nextRunAt?: string | null
  lastRunAt?: string | null
  /** `ok`, `error` or `delivery_failed`. */
  lastStatus?: string | null
  lastError?: string | null
  failureStreak: number
  latestExecution?: CronExecution | null
}

function toCronJob(raw: any): CronJob | null {
  if (typeof raw?.id !== "string") return null
  const schedule = raw.schedule_display ?? raw.schedule?.display ?? raw.schedule?.expr
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
    schedule: typeof schedule === "string" ? schedule : "",
    enabled: raw.enabled !== false,
    state: raw.state ?? undefined,
    nextRunAt: raw.next_run_at,
    lastRunAt: raw.last_run_at,
    lastStatus: raw.last_status,
    lastError: raw.last_error,
    failureStreak: Number(raw.failure_streak) || 0,
    latestExecution: raw.latest_execution,
  }
}

/** Every cron job on the profile, paused ones included. */
export async function listCronJobs(config: HermesConfig): Promise<CronJob[]> {
  const response = await request(`${serverRoot(config.baseUrl)}/api/jobs?include_disabled=true`, {
    headers: headers(config),
  })
  const body = await response.json()
  const jobs: unknown[] = Array.isArray(body?.jobs) ? body.jobs : []
  return jobs.map(toCronJob).filter((job): job is CronJob => job !== null)
}

export async function controlCronJob(
  config: HermesConfig,
  jobId: string,
  action: "pause" | "resume" | "run",
) {
  await request(`${serverRoot(config.baseUrl)}/api/jobs/${encodeURIComponent(jobId)}/${action}`, {
    method: "POST",
    headers: headers(config),
    body: "{}",
  })
}

export interface CronSession {
  id: string
  started_at?: number | string | null
  ended_at?: number | string | null
  end_reason?: string | null
}

const ERROR_FINISH_REASONS = new Set(["error", "agent_error", "content_filter"])

/**
 * Whether a session ended on a failed turn. Hermes closes a turn that died on provider errors with
 * its own assistant row, so the run is booked `cron_complete` anyway. Undefined when unknown.
 */
export async function cronSessionFailed(
  config: HermesConfig,
  sessionId: string,
): Promise<boolean | undefined> {
  try {
    const response = await request(
      `${serverRoot(config.baseUrl)}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=1&order=latest`,
      { headers: headers(config) },
    )
    const body = await response.json()
    const last = Array.isArray(body?.data) ? body.data.at(-1) : undefined
    if (!last) return undefined
    return last.display_kind === "failed_turn" || ERROR_FINISH_REASONS.has(last.finish_reason)
  } catch {
    return undefined
  }
}

/** Sessions cron runs left behind, the only run history the API server exposes. Best effort. */
export async function listCronSessions(config: HermesConfig): Promise<CronSession[]> {
  try {
    const response = await request(
      `${serverRoot(config.baseUrl)}/api/sessions?source=cron&limit=200`,
      {
        headers: headers(config),
      },
    )
    const body = await response.json()
    const data: unknown = Array.isArray(body) ? body : body?.data
    return Array.isArray(data) ? data.filter((s) => typeof s?.id === "string") : []
  } catch {
    return []
  }
}

const runSupport = new Map<string, Promise<boolean>>()

/** Whether the server takes `/v1/runs`, which keep going when the client drops off. */
export function supportsRuns(config: HermesConfig) {
  const key = `${config.baseUrl}\n${config.apiKey}`
  let pending = runSupport.get(key)
  if (!pending) {
    pending = request(endpoint(config.baseUrl, "/capabilities"), { headers: headers(config) })
      .then((response) => response.json())
      .then((body) => Boolean(body?.features?.run_submission && body?.features?.run_events_sse))
      .catch(() => false)
    runSupport.set(key, pending)
    // A failed probe (server down, older version) gets another chance on a later turn.
    void pending.then((ok) => ok || runSupport.delete(key))
  }
  return pending
}

export type RunStatus = "completed" | "failed" | "cancelled" | "interrupted"

export interface RunOutcome {
  status: RunStatus
  output?: string
  error?: string
  usage?: TurnUsage
  /** Events were lost on the way, so `output` should replace what streamed. */
  replaceContent?: boolean
}

const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted"])

function runOutcome(payload: any): RunOutcome {
  const usage = payload?.usage
  return {
    status: payload.status,
    output: typeof payload?.output === "string" ? payload.output : undefined,
    error: payload?.error ? String(payload.error) : payload?.turn_exit_reason,
    usage: usage
      ? {
          promptTokens: Number(usage.input_tokens) || 0,
          completionTokens: Number(usage.output_tokens) || 0,
        }
      : undefined,
  }
}

/**
 * Starts a turn on `/v1/runs`. Unlike a chat completion, Hermes doesn't interrupt a run when its
 * event stream drops, so a phone that sleeps mid-reply can pick it up again.
 */
export async function startRun(
  config: HermesConfig,
  options: {
    model: string
    messages: ChatMessage[]
    sessionId?: string
    /** Makes a retried POST return the run it already started. */
    idempotencyKey: string
  },
) {
  // Like X-Hermes-Session-Id, a keyed session holds the history, so only the new message goes.
  const keyed = Boolean(options.sessionId && config.apiKey)
  const input = keyed ? options.messages.slice(-1) : options.messages
  const response = await request(endpoint(config.baseUrl, "/runs"), {
    method: "POST",
    headers: headers(config, { "Idempotency-Key": options.idempotencyKey }),
    body: JSON.stringify({
      model: options.model,
      input,
      ...(keyed ? { session_id: options.sessionId } : {}),
    }),
  })
  const body = await response.json()
  if (typeof body?.run_id !== "string") throw new HermesError("Hermes didn't start the run.")
  return body.run_id as string
}

/**
 * Follows a run's events from after `lastSeq` (Hermes replays what it buffered). Resolves with the
 * outcome, or null when Hermes closes the stream before the run ends (a subscriber that fell behind).
 */
export async function followRun(
  config: HermesConfig,
  runId: string,
  options: { lastSeq: number; signal?: AbortSignal },
  handlers: StreamHandlers & {
    onSeq?: (seq: number) => void
    /** Hermes no longer had every event after `lastSeq`. */
    onTruncated?: () => void
  },
): Promise<RunOutcome | null> {
  // CORS doesn't allow Last-Event-ID, so the cursor goes in the query.
  const query = options.lastSeq >= 0 ? `?last_seq=${options.lastSeq}` : ""
  const response = await request(
    endpoint(config.baseUrl, `/runs/${encodeURIComponent(runId)}/events${query}`),
    { headers: headers(config), signal: options.signal },
  )
  if (!response.body) throw new HermesError("Hermes returned an empty response.")

  for await (const { data } of readSse(response.body)) {
    let payload: any
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    const name = String(payload?.event ?? "")
    switch (name) {
      case "message.delta":
        if (payload.delta) handlers.onContent?.(String(payload.delta))
        break
      case "message.interim":
        if (payload.text && !payload.already_streamed) handlers.onContent?.(`${payload.text}\n\n`)
        break
      case "reasoning.available":
        if (payload.text) handlers.onReasoningBlock?.(String(payload.text))
        break
      case "tool.started":
        handlers.onTool?.({
          tool: String(payload.tool ?? "tool"),
          label: payload.preview ? String(payload.preview) : undefined,
          toolCallId: `${runId}:${payload.seq}`,
          status: "running",
        })
        break
      case "tool.completed":
        handlers.onTool?.({ tool: String(payload.tool ?? "tool"), status: "completed" })
        break
      case "approval.request":
        handlers.onApproval?.(payload as ApprovalRequestEvent)
        break
      case "replay.truncated":
        handlers.onTruncated?.()
        break
      default:
        if (name.startsWith("run.") && TERMINAL_RUN_STATUSES.has(name.slice(4))) {
          return runOutcome({ ...payload, status: name.slice(4) })
        }
    }
    if (typeof payload?.seq === "number") handlers.onSeq?.(payload.seq)
  }
  return null
}

/** The run's status; `outcome` is set once it has finished. */
export async function getRun(config: HermesConfig, runId: string, signal?: AbortSignal) {
  const response = await request(endpoint(config.baseUrl, `/runs/${encodeURIComponent(runId)}`), {
    headers: headers(config),
    signal,
  })
  const body = await response.json()
  return {
    status: String(body?.status ?? ""),
    outcome: TERMINAL_RUN_STATUSES.has(body?.status) ? runOutcome(body) : undefined,
  }
}

export async function stopRun(config: HermesConfig, runId: string) {
  await request(endpoint(config.baseUrl, `/runs/${encodeURIComponent(runId)}/stop`), {
    method: "POST",
    headers: headers(config),
  })
}
