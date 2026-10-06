import type { ApprovalChoice, PrState, SessionMode, Todo } from "@/lib/db"
import type { Doc } from "@/lib/merge"
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
  /** A completed call's output, as Hermes previews it. */
  result?: string
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
  tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] | string | null
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

/** A row of Hermes's cron execution ledger. */
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

/** One run from Hermes's cron execution ledger, as the Memento plugin serves it. */
export interface CronExecutionRun extends CronExecution {
  id: string
  job_id: string
  /** `delivered`, `failed`, `queued`, `suppressed`, `not_configured`, ... */
  delivery_outcome?: string | null
}

/** Where the Memento Hermes plugin serves its routes on the API server. */
const PLUGIN_ROOT = "/api/plugins/memento"

export const PLUGIN_DOCS = "https://github.com/thehaseebahmed/memento/tree/main/plugin#install"

export const INSTALL_PLUGIN = `hermes plugins install thehaseebahmed/memento/plugin --enable
hermes gateway restart`

/** Each job's newest runs, newest first. A 404 means the Memento plugin isn't installed. */
export async function listCronRuns(
  config: HermesConfig,
  perJob: number,
): Promise<Record<string, CronExecutionRun[]>> {
  const response = await request(
    `${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/cron/runs?per_job=${perJob}`,
    { headers: headers(config) },
  )
  const body = await response.json()
  const jobs: unknown = body?.jobs
  if (!jobs || typeof jobs !== "object") return {}
  return Object.fromEntries(
    Object.entries(jobs).map(([jobId, runs]) => [
      jobId,
      Array.isArray(runs) ? runs.filter((run) => typeof run?.id === "string") : [],
    ]),
  )
}

export interface HermesProjectFolder {
  path: string
  label: string | null
  git: boolean
}

/** A Hermes Project (`hermes project create`), through the Memento plugin. */
export interface HermesProject {
  id: string
  name: string
  description: string | null
  createdAt: number
  /** The newest session in one of its folders; unset when none has run there. */
  lastActiveAt?: number
  /** Primary folder first. */
  folders: HermesProjectFolder[]
}

function toProject(raw: unknown): HermesProject | null {
  if (!raw || typeof raw !== "object") return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== "string" || typeof p.name !== "string") return null
  const seconds = (value: unknown) =>
    typeof value === "number" && value > 0 ? value * 1000 : undefined
  const folders = Array.isArray(p.folders) ? p.folders : []
  return {
    id: p.id,
    name: p.name,
    description: typeof p.description === "string" && p.description.trim() ? p.description : null,
    createdAt: seconds(p.created_at) ?? 0,
    lastActiveAt: seconds(p.last_active),
    folders: folders
      .filter((f): f is Record<string, unknown> => typeof f?.path === "string")
      .map((f) => ({
        path: f.path as string,
        label: typeof f.label === "string" && f.label ? f.label : null,
        git: f.git === true,
      })),
  }
}

/** The profile's Hermes Projects. A 404 (or a CORS-blocked one) means no plugin, or an older one. */
export async function listProjects(config: HermesConfig): Promise<HermesProject[]> {
  const response = await request(`${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/projects`, {
    headers: headers(config),
  })
  const body = await response.json()
  const projects: unknown[] = Array.isArray(body?.projects) ? body.projects : []
  return projects.map(toProject).filter((project): project is HermesProject => project !== null)
}

export interface GitHubStatus {
  connected: boolean
  login?: string
  /** Why a token the server has didn't work. */
  error?: string
}

/** The GitHub account on the bot's Hermes host, which the plugin uses to list and clone repos. */
export async function getGitHubStatus(config: HermesConfig): Promise<GitHubStatus> {
  const response = await request(`${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/github`, {
    headers: headers(config),
  })
  const body = await response.json()
  return {
    connected: body?.connected === true,
    login: typeof body?.login === "string" ? body.login : undefined,
    error: typeof body?.error === "string" ? body.error : undefined,
  }
}

export interface GitHubRepo {
  fullName: string
  description: string | null
  private: boolean
}

/** The host account's repos, most recently pushed first. */
export async function listGitHubRepos(config: HermesConfig): Promise<GitHubRepo[]> {
  const response = await request(`${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/github/repos`, {
    headers: headers(config),
  })
  const body = await response.json()
  const repos: unknown[] = Array.isArray(body?.repos) ? body.repos : []
  return repos.flatMap((raw) => {
    const repo = raw as Record<string, unknown> | null
    if (typeof repo?.full_name !== "string") return []
    return [
      {
        fullName: repo.full_name,
        description: typeof repo.description === "string" ? repo.description : null,
        private: repo.private === true,
      },
    ]
  })
}

/**
 * Clones a GitHub repo onto the Hermes host and adds it to a project, or to a new one named
 * `projectName`. Can take minutes for a big repo.
 */
/** Creates a project in the profile's `projects/` folder on the server, with each repo cloned into it. */
export async function createProject(
  config: HermesConfig,
  project: { name: string; description?: string; repos: string[] },
): Promise<{ id: string; path: string }> {
  const response = await request(`${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/projects`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(project),
  })
  const body = await response.json()
  return { id: String(body?.id ?? ""), path: String(body?.path ?? "") }
}

/**
 * Merges this device's chat list into the one the Memento plugin keeps, newer record winning, and
 * returns the merged list. A 404 (or a CORS-blocked one, with no status) means no plugin, or an older one.
 */
export async function mergeChatList<T>(config: HermesConfig, chats: Doc<T>): Promise<Doc<T>> {
  const response = await request(`${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/chats`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ chats }),
  })
  const body = await response.json()
  if (!body?.chats || typeof body.chats !== "object") throw new Error("Unexpected chat list")
  return body.chats
}

export interface SessionContext {
  /** Prompt tokens of the session's latest model call. */
  tokens: number
  /** The context window Hermes runs that model with. */
  window?: number
}

/**
 * A session's context use as the Memento plugin recorded it, following compression to the live
 * session. Null when it has nothing for the session yet.
 */
export async function getSessionContext(
  config: HermesConfig,
  sessionId: string,
): Promise<SessionContext | null> {
  const response = await request(
    `${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/sessions/${encodeURIComponent(sessionId)}/context`,
    { headers: headers(config) },
  )
  const body = await response.json()
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  const tokens = count(body?.prompt_tokens)
  return tokens ? { tokens, window: count(body?.context_length) } : null
}

export interface SessionTodos {
  revision: number
  items: Todo[]
}

const TODO_STATUSES = new Set<string>(["pending", "in_progress", "completed", "cancelled"])

/** Reads a `todo_list` result (`{ todos, revision }`), or null when it isn't one. */
export function parseTodos(value: unknown): SessionTodos | null {
  const body = value as { todos?: unknown; revision?: unknown } | null
  if (!body || !Array.isArray(body.todos)) return null
  const items: Todo[] = []
  for (const raw of body.todos) {
    const id = raw?.id
    if ((typeof id !== "string" && typeof id !== "number") || typeof raw?.content !== "string")
      continue
    if (!TODO_STATUSES.has(raw.status)) continue
    const parent = raw.parent
    items.push({
      id: String(id),
      content: raw.content,
      status: raw.status,
      ...(typeof parent === "string" || typeof parent === "number"
        ? { parent: String(parent) }
        : {}),
    })
  }
  const revision = typeof body.revision === "number" && body.revision >= 0 ? body.revision : 0
  return { revision, items }
}

/**
 * The agent's todo list in a session (and the ones it was compressed from), read from the
 * transcript by the Memento plugin. Null when the agent hasn't written one.
 */
export async function getSessionTodos(
  config: HermesConfig,
  sessionId: string,
): Promise<SessionTodos | null> {
  const response = await request(
    `${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/sessions/${encodeURIComponent(sessionId)}/todos`,
    { headers: headers(config) },
  )
  return parseTodos(await response.json())
}

/** A project session's worktree and permission mode, as the Memento plugin keeps them. */
export interface SessionWorkspace {
  projectId: string
  repoRoot: string
  path: string
  branch: string
  mode: SessionMode
  planPending: boolean
}

const MODES = new Set<string>(["accept_edits", "auto", "plan"])

function parseWorkspace(raw: unknown): SessionWorkspace | null {
  const body = raw as Record<string, unknown> | null
  if (
    !body ||
    typeof body.path !== "string" ||
    typeof body.branch !== "string" ||
    typeof body.repo_root !== "string"
  )
    return null
  const mode = typeof body.mode === "string" && MODES.has(body.mode) ? body.mode : "accept_edits"
  return {
    projectId: String(body.project_id ?? ""),
    repoRoot: body.repo_root,
    path: body.path,
    branch: body.branch,
    mode: mode as SessionMode,
    planPending: Boolean(body.plan_pending),
  }
}

function pluginSession(config: HermesConfig, sessionId: string, path: string) {
  return `${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/sessions/${encodeURIComponent(sessionId)}${path}`
}

/**
 * Gives a project session its worktree (made on the first call) and points its tools into it. The
 * pointer only lives in the gateway's memory, so this runs before every turn.
 */
export async function ensureWorkspace(
  config: HermesConfig,
  sessionId: string,
  options: { projectId: string; repoRoot: string; task?: string; mode?: SessionMode },
): Promise<SessionWorkspace> {
  const response = await request(pluginSession(config, sessionId, "/workspace"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      project_id: options.projectId,
      repo_root: options.repoRoot,
      task: options.task,
      mode: options.mode,
    }),
  })
  const workspace = parseWorkspace((await response.json())?.workspace)
  if (!workspace) throw new HermesError("The plugin didn't return a workspace.")
  return workspace
}

/** The session's workspace, or null when it has none (or the plugin predates them). */
export async function getWorkspace(
  config: HermesConfig,
  sessionId: string,
): Promise<SessionWorkspace | null> {
  const response = await request(pluginSession(config, sessionId, "/workspace"), {
    headers: headers(config),
  })
  return parseWorkspace((await response.json())?.workspace)
}

/** Changes a session's permission mode; also clears a pending plan. 404 before the first turn. */
export async function setWorkspaceMode(
  config: HermesConfig,
  sessionId: string,
  mode: SessionMode,
): Promise<SessionWorkspace | null> {
  const response = await request(pluginSession(config, sessionId, "/mode"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ mode }),
  })
  return parseWorkspace((await response.json())?.workspace)
}

/** Asks the plugin to remove the worktree; it keeps one with uncommitted or unpushed work. */
export async function removeWorkspace(
  config: HermesConfig,
  sessionId: string,
): Promise<{ removed: boolean; reason?: "dirty" | "unpushed" | "missing" }> {
  const response = await request(pluginSession(config, sessionId, "/workspace/remove"), {
    method: "POST",
    headers: headers(config),
  })
  const body = await response.json()
  const reason = body?.reason
  return {
    removed: Boolean(body?.removed),
    ...(reason === "dirty" || reason === "unpushed" || reason === "missing" ? { reason } : {}),
  }
}

export interface PullRequest {
  number: number
  title: string
  state: PrState
  url: string | null
}

const PR_STATES = new Set<string>(["open", "draft", "merged", "closed"])

/** The pull request from the session's worktree branch, or null. Needs the Memento plugin. */
export async function getSessionPr(
  config: HermesConfig,
  sessionId: string,
): Promise<PullRequest | null> {
  const response = await request(pluginSession(config, sessionId, "/pr"), {
    headers: headers(config),
  })
  const pr = (await response.json())?.pr
  if (!pr || typeof pr.number !== "number" || !PR_STATES.has(pr.state)) return null
  return {
    number: pr.number,
    title: typeof pr.title === "string" ? pr.title : "",
    state: pr.state,
    url: typeof pr.url === "string" ? pr.url : null,
  }
}

export type LiveRunStatus = "running" | "waiting_for_approval"

/** Sessions with a run in flight on the server, by Hermes session id. Needs the Memento plugin. */
export async function listLiveRuns(config: HermesConfig): Promise<Record<string, LiveRunStatus>> {
  const response = await request(`${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/runs/live`, {
    headers: headers(config),
  })
  const sessions: unknown = (await response.json())?.sessions
  if (!sessions || typeof sessions !== "object") return {}
  return Object.fromEntries(
    Object.entries(sessions).filter(
      (entry): entry is [string, LiveRunStatus] =>
        entry[1] === "running" || entry[1] === "waiting_for_approval",
    ),
  )
}

/** Marks a session as Memento's, so the Hermes dashboard labels it. Needs the Memento plugin. */
export async function labelSession(config: HermesConfig, sessionId: string) {
  try {
    await request(
      `${serverRoot(config.baseUrl)}${PLUGIN_ROOT}/sessions/${encodeURIComponent(sessionId)}/label`,
      { method: "POST", headers: headers(config) },
    )
  } catch {
    // Without the plugin the chat just keeps the API server's label.
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
 * Sent as a run's `instructions`, which Hermes adds to the system prompt. `todo_list` is a deferred
 * tool by default, so without it the agent rarely keeps the list the chat shows. Fixed per mode, so
 * the prompt cache holds across the turns of one mode.
 */
const PLAN_HINT =
  "When a task takes three or more steps, plan it first with the todo_list tool (load it through " +
  "tool search if it isn't loaded yet), keep exactly one item in progress, and update the list as " +
  "each step is done."
/** Plan mode: the Memento plugin blocks tools that change anything; this tells the agent why. */
const PLAN_MODE_HINT =
  "You are in plan mode: change nothing. Read what you need, then present a numbered plan of the " +
  "changes you would make in your reply and stop; the user approves it before you act."

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
    /** A project session's permission mode. */
    mode?: SessionMode
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
      instructions: options.mode === "plan" ? `${PLAN_HINT}\n${PLAN_MODE_HINT}` : PLAN_HINT,
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
        handlers.onTool?.({
          tool: String(payload.tool ?? "tool"),
          status: "completed",
          result: payload.preview ? String(payload.preview) : undefined,
        })
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
