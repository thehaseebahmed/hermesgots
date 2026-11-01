import { connectionKey } from "@/lib/connection"
import { heardOf } from "@/lib/dictation-log"
import { readHeardBy, type HeardBy, type SpeechPatch } from "@/lib/speech"
import { pluginRoot, serverRoot } from "@/lib/host-url"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import type {
  ApprovalChoice,
  ClarifyAnswers,
  ClarifyQuestion,
  ModelChoice,
  PrChecks,
  PrState,
  SessionMode,
  Todo,
  TodoProgress,
} from "@/lib/db"
import { MAX_TODO_DEPTH } from "@/lib/db"
import type { Doc } from "@/lib/merge"
import { pickFields } from "@/lib/model-pick"
import type { ModelUsage } from "@/lib/pricing"
import { parsePipeline, parseStage, type AfkStage, type SessionPipeline } from "@/lib/pipeline"
import {
  parseWorkflowEntry,
  parseWorkflowLibrary,
  skillNames,
  type Workflow,
  type WorkflowEntry,
} from "@/lib/workflow"
import { isNative } from "@/lib/native"
import type { Fingerprint, Totals } from "@/lib/dictation-log"
import { promptEntry } from "@/lib/run-prompt"
import type { CronSchedule } from "@/lib/schedule"
import { readStt, type SttValue } from "@/lib/stt-settings"
import {
  parseMcpAccess,
  readMcpAccessOffer,
  type McpAccess,
  type McpAccessOffer,
} from "@/lib/mcp-access"

export type { McpAccess, McpAccessOffer }

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

/** A message part in the OpenAI vision shape, which both `/v1/runs` and chat completions take. */
export type ContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  /** Parts only on the newest message: Hermes flattens history entries to text. */
  content: string | ContentPart[]
}

export interface ToolProgressEvent {
  tool: string
  emoji?: string
  label?: string
  /** Runs don't name tool calls; their completions match the oldest running call of the tool. */
  toolCallId?: string
  status: "running" | "completed" | "failed"
  /** A finished call's output, as Hermes previews it. */
  result?: string
}

export interface ApprovalRequestEvent {
  run_id: string
  command?: string
  description?: string
  choices?: ApprovalChoice[]
  /** When Hermes asked (Unix seconds); the stream's event and the run's status share it. */
  timestamp?: number
}

/** The plugin's `clarify.request` run event: the agent's questions, one card's worth. */
export interface ClarifyRequestEvent {
  run_id: string
  clarify_id: string
  questions?: { id?: string; question?: string; choices?: string[]; multi_select?: boolean }[]
}

/** The plugin's `clarify.responded` run event: how the question ended (answered here or elsewhere). */
export interface ClarifyRespondedEvent {
  run_id: string
  clarify_id: string
  outcome?: string
  answers?: ClarifyAnswers
}

/**
 * A run's `approval.responded` event: Hermes's when a client answered, the plugin's when the
 * approval stopped waiting without one (`timeout`, `cancelled`, `notify_failed`).
 */
export interface ApprovalRespondedEvent {
  run_id: string
  choice?: string
}

/** The questions of a `clarify.request` event in the app's shape; none when the event has none. */
export function clarifyQuestions(event: ClarifyRequestEvent): ClarifyQuestion[] {
  return (event.questions ?? []).flatMap((q, i) => {
    if (!q || typeof q !== "object" || !q.question) return []
    const choices = Array.isArray(q.choices) ? q.choices.map(String).filter(Boolean) : []
    return [
      {
        id: String(q.id ?? `q${i}`),
        question: String(q.question),
        ...(choices.length ? { choices, multiSelect: Boolean(q.multi_select) } : {}),
      },
    ]
  })
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
  onClarify?: (event: ClarifyRequestEvent) => void
  onClarifyResolved?: (event: ClarifyRespondedEvent) => void
  onApprovalResolved?: (event: ApprovalRespondedEvent) => void
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
  /** The error envelope's `code`, such as `approval_not_pending`, when Hermes sent one. */
  readonly code?: string

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = "HermesError"
    this.status = status
    this.code = code
  }
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`
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
    if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
      throw error
    throw new HermesError(networkHint(url))
  }
  if (!response.ok) {
    const { message, code } = await errorBody(response)
    throw new HermesError(message, response.status, code)
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

async function errorBody(response: Response): Promise<{ message: string; code?: string }> {
  let code: string | undefined
  try {
    const body = await response.json()
    if (typeof body?.error?.code === "string") code = body.error.code
    const message = body?.error?.message ?? body?.message
    if (message) return { message: String(message), code }
  } catch {
    // Not JSON; fall through.
  }
  if (response.status === 401) return { message: "Hermes rejected the API key.", code }
  return { message: `Hermes returned ${response.status} ${response.statusText}`.trim(), code }
}

/** A read that doesn't settle within `ms` rejects with a `TimeoutError`. */
function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) {
  let timer = 0
  const quiet = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new DOMException("Hermes stopped sending.", "TimeoutError")),
      ms,
    )
  })
  return Promise.race([reader.read(), quiet]).finally(() => window.clearTimeout(timer))
}

/**
 * Yields `{event, data}` for each SSE frame in the body. With `idleMs`, a body that sends nothing
 * for that long (comments included) is cancelled and the read rejects with a `TimeoutError`.
 */
async function* readSse(body: ReadableStream<Uint8Array>, idleMs?: number) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await (idleMs ? readWithin(reader, idleMs) : reader.read())
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
  } catch (error) {
    // Lets go of the connection, which may be dead without anything having noticed.
    if (error instanceof DOMException && error.name === "TimeoutError")
      void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function streamChat(
  config: HermesConfig,
  options: {
    model: string
    /** With a model chosen for the chat; Hermes honours an explicit provider on every endpoint. */
    provider?: string
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
    body: JSON.stringify({
      model: options.model,
      ...(options.provider ? { provider: options.provider } : {}),
      messages: options.messages,
      stream: true,
    }),
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

export async function listModels(config: HermesConfig, signal?: AbortSignal): Promise<string[]> {
  const response = await request(endpoint(config.baseUrl, "/models"), {
    headers: headers(config),
    signal,
  })
  const body = await response.json()
  return Array.isArray(body?.data) ? body.data.map((m: { id: string }) => m.id) : []
}

export type SkillOrigin = "builtin" | "hub" | "yours" | "plugin"

export interface Skill {
  name: string
  description?: string | null
  category?: string | null
  origin?: SkillOrigin | null
  /** Whether the bot's profile has it switched on; absent where the host couldn't say, which is on. */
  enabled?: boolean | null
  /** Why the host can't load it, in the host's own words; null when it loads. */
  loadError?: string | null
  /** Whether the host honours a switch for it; absent where the host couldn't say, which is yes. */
  switchable?: boolean | null
}

function skillsIn(body: unknown): Skill[] {
  const data = (body as { data?: unknown })?.data
  return Array.isArray(data)
    ? data.filter((s): s is Skill => typeof s?.name === "string" && s.name.length > 0)
    : []
}

/**
 * Every skill the bot's profile holds — the ones it can run and the ones switched off or that no
 * longer load, each carrying `enabled`/`loadError` so a caller filters to what it needs — for the
 * composer's `/` menu and the Skills tab. Hermes's own `/v1/skills` is unscoped and fails on current
 * Hermes, so the plugin lists them under the profile instead.
 */
export async function listSkills(config: HermesConfig, signal?: AbortSignal): Promise<Skill[]> {
  const response = await request(`${pluginRoot(config.baseUrl)}/skills`, {
    headers: headers(config),
    signal,
  })
  return skillsIn(await response.json())
}

/**
 * Switches one of the bot's skills on or off on its Host (the Gots plugin's
 * `POST /skills/<name>/enabled`), answering the row as the change lands. The Host writes the
 * profile's **global** disabled list — one switch means the whole bot, never one platform — clears
 * Hermes's own caches so the change is live for the next turn, and leaves a chat already built with
 * the abilities it had. A skill the profile doesn't have, or one Hermes will not switch, is refused
 * there in the Host's own words.
 */
export async function setSkillEnabled(
  config: HermesConfig,
  name: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<Skill> {
  const response = await request(skillPath(config, name, "enabled"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ enabled }),
    signal: signal ?? AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  const data = (await response.json())?.data as Skill | undefined
  if (!data || typeof data.name !== "string" || !data.name) {
    throw new HermesError("The host answered without the skill.")
  }
  return data
}

export async function removeSkill(
  config: HermesConfig,
  name: string,
  signal?: AbortSignal,
): Promise<Skill[]> {
  const response = await request(skillPath(config, name), {
    method: "DELETE",
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return skillsIn(await response.json())
}

export interface SkillView extends Skill {
  /** The skill's SKILL.md exactly as it is on disk — nothing preprocessed, nothing rendered. */
  content: string
  /** Its files by group (`references`, `templates`, `assets`, `scripts`), or null where the Host can't list them. */
  linkedFiles: Record<string, string[]> | null
  /** `available`, `setup_needed` or `unsupported`, where the Host says. */
  readiness_status?: string | null
  setup_help?: string
  gateway_setup_hint?: string
  setup_note?: string
}

export interface SkillFile {
  name: string
  path: string
  content: string
}

function readLinkedFiles(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== "object") return null
  const groups: Record<string, string[]> = {}
  for (const [group, paths] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(paths)) {
      groups[group] = paths.filter((path): path is string => typeof path === "string")
    }
  }
  return groups
}

/** One path on the bot's plugin under `root`, every segment escaped. */
function pluginPath(config: HermesConfig, root: string, ...segments: string[]): string {
  const rest = segments.map((segment) => `/${encodeURIComponent(segment)}`).join("")
  return `${pluginRoot(config.baseUrl)}/${root}${rest}`
}

function skillPath(config: HermesConfig, ...segments: string[]): string {
  return pluginPath(config, "skills", ...segments)
}

export async function getSkillView(
  config: HermesConfig,
  name: string,
  signal?: AbortSignal,
): Promise<SkillView> {
  const response = await request(skillPath(config, name), {
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  const data = (await response.json())?.data as SkillView | undefined
  if (!data || typeof data.name !== "string" || typeof data.content !== "string") {
    throw new HermesError("The host answered without the skill.")
  }
  return { ...data, linkedFiles: readLinkedFiles(data.linkedFiles) }
}

export async function getSkillFile(
  config: HermesConfig,
  name: string,
  path: string,
  signal?: AbortSignal,
): Promise<SkillFile> {
  const response = await request(
    `${skillPath(config, name, "file")}?path=${encodeURIComponent(path)}`,
    {
      headers: headers(config),
      signal: signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
    },
  )
  const data = (await response.json())?.data as Partial<SkillFile> | undefined
  if (!data || typeof data.content !== "string") {
    throw new HermesError("The host answered without the file.")
  }
  return { name: name, path: path, content: data.content }
}

/** A bot's MCP server, as the Gots plugin's read reports it: its state in Gots' own words. */
export type McpState = "on" | "off" | "connecting" | "failed" | "needs_access" | "plugin"

export interface McpServer {
  name: string
  state: McpState
  /** Whether the bot's configuration leaves it on; a Host that doesn't say is read as on. */
  enabled: boolean
  /** Where it comes from: the bot's own configuration, or a Hermes plugin that provides it. */
  source: "config" | "plugin"
  /** The Host's own failure text, on a failed one. */
  reason?: string
  /** Whether the Host can start Server access for this row, and so offers Grant access. */
  access: McpAccessOffer
  /**
   * How many tools it offers, where the Host knows: Hermes answers a count for a server it has
   * connected or registered, and none for one it has no runtime state for (see `mcp-server.ts`).
   */
  tools?: number
}

/** The rows a plugin answer wraps (`{"object": {"servers": [...]}}`), or nothing it doesn't carry. */
function wrapped(value: unknown, key: string): unknown {
  return (value as Record<string, Record<string, unknown>> | null)?.object?.[key]
}

/** The rows of one answer or list, each read once, dropping any Gots has no name for. */
function namedRows<T extends { name: string }>(
  rows: unknown,
  read: (raw: unknown) => T | undefined,
): T[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const found = read(row)
    return found === undefined ? [] : [found]
  })
}

/** One path on the bot's plugin under `/mcp`, every segment escaped (`/mcp/<name>/tools`). */
function mcpPath(config: HermesConfig, ...segments: string[]): string {
  return pluginPath(config, "mcp", ...segments)
}

const MCP_STATES = new Set<string>(["on", "off", "connecting", "failed", "needs_access", "plugin"])

/** One row as the plugin reports it, or nothing for one Gots has no name or word for. */
function parseMcpServerRow(raw: unknown): McpServer | undefined {
  const row = raw as Record<string, unknown> | null
  if (typeof row?.name !== "string" || !row.name || !MCP_STATES.has(String(row.state)))
    return undefined
  const state = row.state as McpState
  return {
    name: row.name,
    state,
    // A host that doesn't report the flag is one whose state word is the only answer there is.
    enabled: typeof row.enabled === "boolean" ? row.enabled : state !== "off",
    source: row.source === "plugin" ? "plugin" : "config",
    ...(typeof row.reason === "string" && row.reason ? { reason: row.reason } : {}),
    access: readMcpAccessOffer(row),
    ...(typeof row.tools === "number" && Number.isFinite(row.tools) ? { tools: row.tools } : {}),
  }
}

/**
 * Reads the plugin's `mcp` answer (`{"object": {"servers": [...]}}`) into the servers the screen
 * lists: a row with no name, or a state Gots has no word for, is dropped, and so is an empty reason.
 */
export function parseMcpServers(value: unknown): McpServer[] {
  return namedRows(wrapped(value, "servers"), parseMcpServerRow)
}

/** Reads the plugin's `mcp` write answer (`{"object": {"server": {...}}}`) into the one server. */
export function parseMcpServer(value: unknown): McpServer | undefined {
  return parseMcpServerRow(wrapped(value, "server"))
}

/** The MCP servers the bot's Hermes profile has, read from the Gots plugin. */
export async function listMcpServers(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<McpServer[]> {
  const response = await request(mcpPath(config), {
    headers: headers(config),
    signal,
  })
  return parseMcpServers(await response.json())
}

/**
 * Switches one of the bot's MCP servers on or off on its Host (the Gots plugin's
 * `POST /mcp/<name>/enabled`), answering the row as the change lands. The Host writes the flag on
 * the bot's profile and makes it live for the bot's next turn; a server a Hermes plugin provides is
 * refused there.
 */
export async function setMcpServerEnabled(
  config: HermesConfig,
  name: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<McpServer> {
  const response = await request(mcpPath(config, name, "enabled"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ enabled }),
    signal,
  })
  const server = parseMcpServer(await response.json())
  if (!server) throw new HermesError("The host answered without the server.")
  return server
}

/**
 * Takes one of the bot's MCP servers away on its Host (the Gots plugin's `DELETE /mcp/<name>`),
 * answering the servers the bot has left. The Host removes the server the way `hermes mcp remove`
 * does — its configuration, the directory it cloned and its stored Server access — keeps the values
 * in the bot's profile environment, and makes the removal live for the bot's next turn; a server a
 * Hermes plugin provides, or one the bot doesn't have, is refused there.
 */
export async function removeMcpServer(
  config: HermesConfig,
  name: string,
  signal?: AbortSignal,
): Promise<McpServer[]> {
  const response = await request(mcpPath(config, name), {
    method: "DELETE",
    headers: headers(config),
    signal,
  })
  return parseMcpServers(await response.json())
}

/**
 * Starts (or resumes) Server access for one of the bot's MCP servers on its Host (the Gots plugin's
 * `POST /mcp/<name>/access`). The Host binds a loopback receiver and answers the provider's URL; a
 * second start while that flow runs answers the same URL. A start that fails before a URL comes back
 * as the Host's own sentence, thrown for the screen to show.
 */
export async function startMcpAccess(
  config: HermesConfig,
  name: string,
  signal?: AbortSignal,
): Promise<McpAccess> {
  const response = await request(mcpPath(config, name, "access"), {
    method: "POST",
    headers: headers(config),
    signal,
  })
  return parseMcpAccess(await response.json())
}

/**
 * Hands the address a browser ended on back to the running flow (the Gots plugin's
 * `POST /mcp/<name>/access/callback`): the host checks it is that flow's own redirect and gives it
 * to the flow, which exchanges the code and lands the access. Used when the browser was on this
 * phone rather than the host, where the loopback redirect could not connect.
 */
export async function deliverMcpAccess(
  config: HermesConfig,
  name: string,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  await request(mcpPath(config, name, "access", "callback"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ url }),
    signal,
  })
}

/** One entry of Hermes's Catalogue, as the Gots plugin's read reports it. */
export interface McpCatalogueEntry {
  name: string
  /** What the entry is, in Hermes's own words; an entry with nothing to say carries an empty one. */
  description: string
  /** Whether this bot already has it — the Host's own read of the bot's configuration. */
  installed: boolean
  /**
   * Whether adding it leaves anything to fill in — a value its manifest declares. An entry that
   * needs none is added by the tap that picks it (ADR 0014).
   */
  needsConfig: boolean
}

/** One catalogue entry as the plugin reports it, or nothing for one Gots has no name for. */
function parseMcpCatalogueEntry(raw: unknown): McpCatalogueEntry | undefined {
  const entry = raw as Record<string, unknown> | null
  if (typeof entry?.name !== "string" || !entry.name) return undefined
  return {
    name: entry.name,
    description: typeof entry.description === "string" ? entry.description : "",
    installed: entry.installed === true,
    needsConfig: entry.needs_config === true,
  }
}

/**
 * Reads the plugin's catalogue answer (`{"object": {"entries": [...]}}`) into the entries the
 * Catalogue lists: an entry with no name is dropped, and so is anything that isn't an entry at all.
 */
export function parseMcpCatalogue(value: unknown): McpCatalogueEntry[] {
  return namedRows(wrapped(value, "entries"), parseMcpCatalogueEntry)
}

/**
 * Hermes's Catalogue as this bot's Host offers it (the Gots plugin's `GET /mcp/catalogue`): every
 * entry, each marked with whether the bot already has it. A read only — nothing is added, and an
 * entry's declared values are never part of it.
 */
export async function listMcpCatalogue(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<McpCatalogueEntry[]> {
  const response = await request(mcpPath(config, "catalogue"), {
    headers: headers(config),
    signal,
  })
  return parseMcpCatalogue(await response.json())
}

/** One value a Catalogue entry declares, as its manifest has it and the form is built from it. */
export interface McpCatalogueValue {
  /** The value's own name (the environment variable the entry's manifest declares). */
  name: string
  /** What the manifest asks for, in its own words. */
  prompt: string
  /** Whether the entry can be added with nothing in it. */
  required: boolean
  /** Whether it holds a credential, so its field is masked. */
  secret: boolean
  /** The default the manifest pins, which the form fills in; a secret never carries one. */
  default: string
  /** Whether this Bot already holds a value for it. Its content is never asked for. */
  set: boolean
}

/** One Catalogue entry with the values it declares, as the plugin's entry read reports it. */
export interface McpCatalogueEntryDetail extends McpCatalogueEntry {
  values: McpCatalogueValue[]
}

/** One declared value as the plugin reports it, or nothing for one Gots has no name for. */
function parseMcpCatalogueValue(raw: unknown): McpCatalogueValue | undefined {
  const value = raw as Record<string, unknown> | null
  if (typeof value?.name !== "string" || !value.name) return undefined
  // A Host that says nothing about a value is read the way Hermes's own manifest defaults are:
  // required and secret, the stricter of the two answers.
  const secret = value.secret !== false
  return {
    name: value.name,
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    required: value.required !== false,
    secret,
    // A secret's default is not a thing Gots will fill in, whatever the Host says: the field is
    // masked, so a credential prefilled into it would be one on screen. The plugin never sends one,
    // and this is the client half of the same rule.
    default: !secret && typeof value.default === "string" ? value.default : "",
    set: value.set === true,
  }
}

/**
 * Reads the plugin's entry answer (`{"object": {"entry": {...}}}`) into the one entry with its
 * declared values: an entry with no name is nothing at all, and so is a value with no name, while
 * one the Host says nothing about is read as required and secret rather than as an optional, plain
 * field the user might skip.
 */
export function parseMcpCatalogueEntryDetail(value: unknown): McpCatalogueEntryDetail | undefined {
  const raw = wrapped(value, "entry") as Record<string, unknown> | undefined
  const entry = parseMcpCatalogueEntry(raw)
  if (!entry) return undefined
  return { ...entry, values: namedRows(raw?.values, parseMcpCatalogueValue) }
}

/**
 * One entry of Hermes's Catalogue with the values it declares (the Gots plugin's
 * `GET /mcp/catalogue/<name>`): what the form that adds it is built from. The Host reports only
 * whether it already holds a value for each one — never the value — so nothing the user gave it
 * ever comes back to the screen.
 */
export async function getMcpCatalogueEntry(
  config: HermesConfig,
  name: string,
  signal?: AbortSignal,
): Promise<McpCatalogueEntryDetail | undefined> {
  const response = await request(mcpPath(config, "catalogue", name), {
    headers: headers(config),
    signal,
  })
  return parseMcpCatalogueEntryDetail(await response.json())
}

/**
 * Adds one of the Catalogue's entries to the bot on its Host (the Gots plugin's `POST /mcp/install`),
 * answering every server the bot has afterwards. `values` is what the form collected, by the name
 * each value declares; the Host writes the server's configuration, puts the values it declares
 * secret in the bot's profile environment and makes the add live for the bot's next turn. An entry it
 * doesn't have, a value it doesn't declare, one of its required values left empty and a
 * configuration its own validator refuses are each refused there, with the Host's reason.
 */
export async function installMcpServer(
  config: HermesConfig,
  name: string,
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<McpServer[]> {
  const response = await request(mcpPath(config, "install"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ name, values }),
    signal,
  })
  return parseMcpServers(await response.json())
}

/** One value a server's own configuration holds, as its Config tab is built from it. */
export interface McpServerValue {
  /** The environment name the block holds, which is the whole of the row's title. */
  name: string
  /** Whether the bot already holds it. Its content never reaches the screen. */
  set: boolean
}

/** One of a bot's servers with the block it runs (the Gots plugin's `GET /mcp/<name>`). */
export interface McpServerDetail {
  name: string
  source: "config" | "plugin"
  transport: "http" | "stdio"
  url: string
  command: string
  args: string[]
  auth: "none" | "header" | "oauth"
  /** False for a server a Hermes plugin provides, which Hermes refuses to modify. */
  editable: boolean
  values: McpServerValue[]
}

/** What the Config tab saves: only the fields it manages, and the values typed over. */
export interface McpServerEdit {
  transport: "http" | "stdio"
  url?: string
  command?: string
  args?: string[]
  auth?: "none" | "header" | "oauth"
  token?: string
  values?: Record<string, string>
}

/** A server the Catalogue doesn't offer, as the custom form collects it. */
export interface McpCustomServer extends McpServerEdit {
  name: string
}

/** One tool a server offers, as the Host lists it: the name it is called by and what it does. */
export interface McpTool {
  name: string
  description: string
}

/**
 * What the Host answered about one server's tools, and where they came from: Hermes's schema cache
 * (`cached`) or the one probe a tap asked for. A cache miss is an empty list, not an error.
 */
export interface McpTools {
  cached: boolean
  tools: McpTool[]
}

/** One value row as the plugin reports it, read the stricter way where it says less. */
function parseMcpServerValue(raw: unknown): McpServerValue | undefined {
  const value = raw as Record<string, unknown> | null
  if (typeof value?.name !== "string" || !value.name) return undefined
  return { name: value.name, set: value.set === true }
}

/** One server's block as the plugin reports it, or nothing for a row Gots can't draw. */
export function parseMcpServerDetail(value: unknown): McpServerDetail | undefined {
  const raw = wrapped(value, "server") as Record<string, unknown> | undefined
  if (typeof raw?.name !== "string" || !raw.name) return undefined
  const transport = raw.transport === "stdio" ? "stdio" : "http"
  const auth = raw.auth === "header" || raw.auth === "oauth" ? raw.auth : "none"
  return {
    name: raw.name,
    source: raw.source === "plugin" ? "plugin" : "config",
    transport,
    url: typeof raw.url === "string" ? raw.url : "",
    command: typeof raw.command === "string" ? raw.command : "",
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [],
    auth,
    editable: raw.editable === true,
    values: namedRows(raw.values, parseMcpServerValue),
  }
}

/** One server's tools as the plugin reports them, dropping a tool Gots has no name for. */
export function parseMcpTools(value: unknown): McpTools {
  const raw = wrapped(value, "tools") as Record<string, unknown> | undefined
  return {
    cached: raw?.cached === true,
    tools: namedRows(raw?.items, (tool) => {
      const row = tool as Record<string, unknown> | null
      if (typeof row?.name !== "string" || !row.name) return undefined
      return {
        name: row.name,
        description: typeof row.description === "string" ? row.description : "",
      }
    }),
  }
}

/**
 * One of the bot's servers with the block it runs (the Gots plugin's `GET /mcp/<name>`): the
 * transport and its fields, and one row per environment name the block holds. A read only, and the
 * only thing it says about a value the bot holds is whether it has one.
 */
export async function getMcpServer(
  config: HermesConfig,
  name: string,
  signal?: AbortSignal,
): Promise<McpServerDetail | undefined> {
  const response = await request(mcpPath(config, name), { headers: headers(config), signal })
  return parseMcpServerDetail(await response.json())
}

/**
 * Saves the Config tab's edit of one server on its Host (the Gots plugin's `POST /mcp/<name>/config`),
 * answering every server the bot has afterwards. A typed value lands in the bot's profile
 * environment and the block keeps Hermes's `${NAME}` reference; a block Hermes's own validator
 * refuses is refused there, with its sentence.
 */
export async function saveMcpServer(
  config: HermesConfig,
  name: string,
  edit: McpServerEdit,
  signal?: AbortSignal,
): Promise<{ servers: McpServer[]; detail?: McpServerDetail }> {
  const response = await request(mcpPath(config, name, "config"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(edit),
    signal,
  })
  const body: unknown = await response.json()
  // One round trip answers both: the servers left, and this one's block as the write landed it.
  return { servers: parseMcpServers(body), detail: parseMcpServerDetail(body) }
}

/**
 * Adds a server the Catalogue doesn't offer (the Gots plugin's `POST /mcp/custom`), answering every
 * server the bot has afterwards: a URL, or a command with its arguments and the environment values
 * it needs. The Host refuses a name the bot already has, one a Hermes plugin provides, and a
 * configuration its validator won't take.
 */
export async function addCustomMcpServer(
  config: HermesConfig,
  server: McpCustomServer,
  signal?: AbortSignal,
): Promise<McpServer[]> {
  const response = await request(mcpPath(config, "custom"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(server),
    signal,
  })
  return parseMcpServers(await response.json())
}

/**
 * One server's tools from Hermes's own schema cache (the Gots plugin's `GET /mcp/<name>/tools`):
 * what a registration wrote, so nothing is connected by asking. An empty answer with `cached` false
 * is a server that has never connected, or one whose configuration has changed since.
 */
export async function listMcpServerTools(
  config: HermesConfig,
  name: string,
  signal?: AbortSignal,
): Promise<McpTools> {
  return readMcpTools(config, name, "GET", signal)
}

/**
 * One server's tools by having the Host probe it once (the Gots plugin's `POST /mcp/<name>/tools`):
 * it connects, lists what the server offers, and disconnects. The only read here that reaches the
 * server, so it is asked for by a tap and given `MCP_TOOLS_MS` rather than a read's timeout.
 */
export async function probeMcpServerTools(
  config: HermesConfig,
  name: string,
  signal?: AbortSignal,
): Promise<McpTools> {
  return readMcpTools(config, name, "POST", signal)
}

/** One server's tools, read from Hermes's schema cache (GET) or by the probe (POST). */
async function readMcpTools(
  config: HermesConfig,
  name: string,
  method: "GET" | "POST",
  signal?: AbortSignal,
): Promise<McpTools> {
  const response = await request(mcpPath(config, name, "tools"), {
    method,
    headers: headers(config),
    signal,
  })
  return parseMcpTools(await response.json())
}

/** A provider the host has credentials for, and the models Hermes offers on it. */
export interface ModelProvider {
  /** What Hermes takes as a run's `provider`. */
  slug: string
  name: string
  models: string[]
}

export interface ModelInfo {
  model?: string
  provider?: string
  /** The configured providers, the current one first; empty when the host lists none. */
  providers: ModelProvider[]
  /** A custom endpoint came back without models: Hermes lists them only once it has probed it. */
  unprobed: boolean
}

/** Hermes's own model picker inventory, keeping only providers that have models to pick. */
function modelProviders(raw: unknown, current?: string): ModelProvider[] {
  if (!Array.isArray(raw)) return []
  const providers = raw.flatMap((row): ModelProvider[] => {
    if (!row || typeof row !== "object" || row.authenticated === false) return []
    const slug = typeof row.slug === "string" ? row.slug : ""
    const listed: unknown[] = Array.isArray(row.models) ? row.models : []
    const models = [...new Set(listed.filter((m): m is string => typeof m === "string" && !!m))]
    if (!slug || !models.length) return []
    return [{ slug, name: typeof row.name === "string" && row.name ? row.name : slug, models }]
  })
  const first = providers.findIndex((p) => p.slug === current)
  return first > 0 ? [providers[first], ...providers.filter((_, i) => i !== first)] : providers
}

/**
 * The LLM and provider behind the profile, and the models its host is configured for. Newer
 * Hermes only, so callers treat null as unknown. `refresh` has Hermes probe every custom endpoint
 * (the dashboard's Refresh Models), which a plain read only does for the current one.
 *
 * Bounded like every other host read, and with no way to lift that bound: a host that took the
 * connection and went quiet must not hold what asked. The abort lands in the catch below, so a read
 * that never answers is the same to the app as a host that names no model.
 */
export async function getModelInfo(
  config: HermesConfig,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<ModelInfo | null> {
  try {
    const query = refresh ? "?refresh=true" : ""
    const response = await request(`${serverRoot(config.baseUrl)}/api/model/options${query}`, {
      headers: headers(config),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    const body = await response.json()
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
    const provider = text(body?.provider)
    return {
      model: text(body?.model),
      provider,
      providers: modelProviders(body?.providers, provider),
      unprobed:
        Array.isArray(body?.providers) &&
        body.providers.some(
          (row: { authenticated?: unknown; api_url?: unknown; models?: unknown }) =>
            row?.authenticated !== false &&
            typeof row?.api_url === "string" &&
            !!row.api_url &&
            !(Array.isArray(row.models) && row.models.length),
        ),
    }
  } catch {
    return null
  }
}

/** Makes a model the profile's main model in the host's config (the Gots plugin's `model`). */
export async function setHostModel(
  config: HermesConfig,
  choice: { provider: string; model: string },
) {
  await request(`${pluginRoot(config.baseUrl)}/model`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(choice),
  })
}

/** A model a bot falls back to, as its host records it: the same pick the rest of the app passes
 * around (`ModelChoice`). */
export type Fallback = ModelChoice

/**
 * The bot's fallback models on its host, in the order it would try them after the main model (the
 * Gots plugin's `fallbacks`, which is Hermes's own failover chain). Newer plugin only; a host
 * without the route answers 404.
 */
export async function getFallbackModels(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<Fallback[]> {
  const response = await request(`${pluginRoot(config.baseUrl)}/fallbacks`, {
    headers: headers(config),
    signal,
  })
  return picks((await response.json())?.fallbacks)
}

/** Makes `fallbacks` the bot's chain on its host, in order; an empty list clears it. Answers with
 * the list the host holds, and throws with its reason when it refuses a pick. */
export async function setFallbackModels(
  config: HermesConfig,
  fallbacks: Fallback[],
  signal?: AbortSignal,
) {
  const response = await request(`${pluginRoot(config.baseUrl)}/fallbacks`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ fallbacks }),
    signal,
  })
  return picks((await response.json())?.fallbacks)
}

function picks(value: unknown): ModelChoice[] {
  if (!Array.isArray(value)) return []
  const named: ModelChoice[] = []
  for (const entry of value) {
    const { provider, model } = (entry ?? {}) as { provider?: unknown; model?: unknown }
    if (typeof provider === "string" && typeof model === "string" && provider && model)
      named.push({ provider: provider.trim(), model: model.trim() })
  }
  return named
}

const pickOf = (value: unknown) => picks([value])[0] ?? null

/**
 * The model a bot's delegated tasks run on, from its host's `delegation` section (Hermes's own
 * `delegation.model`); `null` when a child inherits the bot's own model. Newer plugin only; a host
 * without the route answers 404.
 */
export async function getDelegationModel(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<ModelChoice | null> {
  const response = await request(`${pluginRoot(config.baseUrl)}/delegation`, {
    headers: headers(config),
    signal,
  })
  return pickOf((await response.json())?.delegation)
}

/** Makes `pick` the model the bot's delegated tasks run on; `null` clears it, so a child inherits
 * the bot's own. Answers with what the host holds, and throws with its reason when it refuses. */
export async function setDelegationModel(
  config: HermesConfig,
  pick: ModelChoice | null,
  signal?: AbortSignal,
): Promise<ModelChoice | null> {
  const response = await request(`${pluginRoot(config.baseUrl)}/delegation`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ delegation: pick }),
    signal,
  })
  return pickOf((await response.json())?.delegation)
}

/**
 * The model a bot's host makes its triage decisions with; `null` when the bot's own model decides.
 * Newer plugin only; a host without the route answers 404.
 */
export async function getTriageModel(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<ModelChoice | null> {
  const response = await request(`${pluginRoot(config.baseUrl)}/triage-model`, {
    headers: headers(config),
    signal,
  })
  return pickOf((await response.json())?.triage_model)
}

/** Makes `pick` the model triage decides with; `null` clears it. Answers with what the host holds,
 * and throws with its reason when it refuses (Hermes's, or that the host withholds the override). */
export async function setTriageModel(
  config: HermesConfig,
  pick: ModelChoice | null,
  signal?: AbortSignal,
): Promise<ModelChoice | null> {
  const response = await request(`${pluginRoot(config.baseUrl)}/triage-model`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ triage_model: pick }),
    signal,
  })
  return pickOf((await response.json())?.triage_model)
}

/** The levels a bot's reminders may be set to, `off` asking never. The counts behind each are the
 * host's, so a level it learns before this list does reads as Normal here. */
export const REMINDER_LEVELS = ["off", "quiet", "normal", "chatty"] as const
export type ReminderLevel = (typeof REMINDER_LEVELS)[number]

/** The name a store written before the four names holds: the same ten calls as Chatty. */
const LEGACY_LEVELS = new Map<string, ReminderLevel>([["frequent", "chatty"]])

const isLevel = (value: unknown): value is ReminderLevel =>
  typeof value === "string" && (REMINDER_LEVELS as readonly string[]).includes(value)

/** The level a host's answer names: what it says, else an older host's name, else Normal. */
const asLevel = (value: unknown): ReminderLevel =>
  isLevel(value) ? value : (LEGACY_LEVELS.get(String(value)) ?? "normal")

/** How often Gots asks this bot to say what it is doing (`progress.py`, ADR 0068), held per bot on
 * its host, which owns the counts behind the names. */
export async function getReminderLevel(config: HermesConfig, signal?: AbortSignal) {
  const response = await request(`${pluginRoot(config.baseUrl)}/reminders`, {
    headers: headers(config),
    signal,
  })
  return asLevel((await response.json())?.level)
}

/** Writes the bot's level, and answers the host's record as it now stands. */
export async function setReminderLevel(
  config: HermesConfig,
  level: ReminderLevel,
  signal?: AbortSignal,
) {
  const response = await request(`${pluginRoot(config.baseUrl)}/reminders`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ level }),
    signal,
  })
  return asLevel((await response.json())?.level ?? level)
}

/**
 * The host's speech settings (`speech.py`): its speech model, the models a pick can be made from
 * with their size and speed, the last pick that didn't load, and the model a phrase's cleanup runs
 * on. The app reads the fields it draws; `speech.ts` is the shape.
 */
export async function getSpeechSettings(config: HermesConfig, signal?: AbortSignal) {
  const response = await request(`${pluginRoot(config.baseUrl)}/speech`, {
    headers: headers(config),
    signal,
  })
  return ((await response.json())?.speech ?? null) as Record<string, unknown> | null
}

/** Writes the speech fields that moved, and answers the host's whole record as it now stands. */
export async function setSpeechSettings(
  config: HermesConfig,
  patch: SpeechPatch,
  signal?: AbortSignal,
) {
  const response = await request(`${pluginRoot(config.baseUrl)}/speech`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(patch),
    signal,
  })
  return ((await response.json())?.speech ?? null) as Record<string, unknown> | null
}

/**
 * Writes one speech setting in the bot's own `config.yaml` — a dotted path and a scalar, or `null`
 * to clear it back to the host's default — and answers the host's fresh `stt` block. The host
 * refuses a key the page may not write, and its own sentence is what the page shows.
 */
export async function setSttSetting(
  config: HermesConfig,
  key: string,
  value: SttValue,
  signal?: AbortSignal,
) {
  const response = await request(`${pluginRoot(config.baseUrl)}/stt`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ key, value }),
    signal,
  })
  return readStt(((await response.json())?.stt ?? null) as unknown)
}

/**
 * Whether this bot's host tells the model the component library, which is also whether the app
 * draws a reply's blocks: profile-wide, written from Appearance (the Gots plugin's `openui`). A
 * host that answers without the flag hasn't said off, and nothing but an off stops the drawing.
 * Newer plugin only; a host without the route answers 404.
 */
export async function getOpenUI(config: HermesConfig, signal?: AbortSignal): Promise<boolean> {
  const response = await request(`${pluginRoot(config.baseUrl)}/openui`, {
    headers: headers(config),
    signal,
  })
  return openuiEnabled(await response.json())
}

/** Turns interfaces on or off for the whole profile, and answers with what the host now holds. */
export async function setOpenUI(
  config: HermesConfig,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await request(`${pluginRoot(config.baseUrl)}/openui`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ enabled }),
    signal,
  })
  return openuiEnabled(await response.json())
}

/** The host's answer as the switch: off only when it says so, so silence leaves the app drawing. */
function openuiEnabled(body: unknown) {
  return (body as { enabled?: unknown } | null)?.enabled !== false
}

export async function checkHealth(config: HermesConfig, signal?: AbortSignal) {
  const response = await request(`${serverRoot(config.baseUrl)}/health`, {
    headers: headers(config),
    signal,
  })
  return response.json().catch(() => ({}))
}

/** The title Hermes gave a session (it auto-titles chats in the background). Best effort. */
export async function getSessionTitle(
  config: HermesConfig,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await request(
      `${serverRoot(config.baseUrl)}/api/sessions/${encodeURIComponent(sessionId)}`,
      { headers: headers(config), signal },
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
  /**
   * Display-only metadata a row carries: on a subagent's result, the delegation it reports from (an
   * answer from a host that sends it; the API leaves it off, so the notification's own header is
   * what names the delegation there).
   */
  display_metadata?: {
    delegation_id?: string
    task_count?: number
    completed_count?: number
    failed_count?: number
    duration_seconds?: number
    /** `task_failure:<index>` on an early warning from a fan-out still running. */
    delivery_notice?: string
    notification_category?: string
    /** The host keeps the row out of the thread: it is written as `hidden` instead. */
    presentation_suppressed?: boolean
  } | null
  finish_reason?: string | null
}

/**
 * One page of a session's transcript, counted back from the newest row (`offset` rows skipped)
 * but returned oldest first. A 404 means Hermes has no such session.
 *
 * `includeCompacted` asks for the display read, which also carries the rows a compaction archived:
 * one row per logical message, deduped by the host, so a turn a compaction carried forward under a
 * fresh row id comes back once — as the live copy. It counts its offset in those logical messages
 * and refuses keyset paging, so it's the window's own numbering, never the live transcript's.
 */
export async function listSessionMessages(
  config: HermesConfig,
  sessionId: string,
  {
    limit,
    offset,
    includeCompacted,
    signal,
  }: { limit: number; offset: number; includeCompacted?: boolean; signal?: AbortSignal },
): Promise<SessionMessage[]> {
  const query = new URLSearchParams({ order: "latest", limit: `${limit}`, offset: `${offset}` })
  if (includeCompacted) query.set("include_compacted", "1")
  try {
    const response = await request(
      `${serverRoot(config.baseUrl)}/api/sessions/${encodeURIComponent(sessionId)}/messages?${query}`,
      { headers: headers(config), signal },
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
  schedule: CronSchedule
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
  const spec = raw.schedule && typeof raw.schedule === "object" ? raw.schedule : {}
  const display = raw.schedule_display ?? spec.display ?? spec.expr ?? raw.schedule
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
    schedule: {
      kind: typeof spec.kind === "string" ? spec.kind : undefined,
      minutes: typeof spec.minutes === "number" ? spec.minutes : undefined,
      expr: typeof spec.expr === "string" ? spec.expr : undefined,
      runAt: typeof spec.run_at === "string" ? spec.run_at : undefined,
      display: typeof display === "string" ? display : "",
    },
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

/** One run from Hermes's cron execution ledger, as the Gots plugin serves it. */
export interface CronExecutionRun extends CronExecution {
  id: string
  job_id: string
  /** `delivered`, `failed`, `queued`, `suppressed`, `not_configured`, ... */
  delivery_outcome?: string | null
}

export { pluginRoot }

export const INSTALL_PLUGIN = `hermes plugins install thehaseebahmed/memento/plugin --enable
hermes gateway restart`

/** What one read of the plugin's `info` answered: its version and features, or nulls. */
export interface PluginInfo {
  version: string | null
  features: string[] | null
}

async function pluginInfoBody(config: HermesConfig, signal?: AbortSignal): Promise<PluginInfo> {
  const response = await request(`${pluginRoot(config.baseUrl)}/info`, {
    headers: headers(config),
    signal,
  })
  const body = await response.json()
  const features: unknown = body?.features
  return {
    version: typeof body?.version === "string" && body.version ? body.version : null,
    features: Array.isArray(features)
      ? features.filter((feature): feature is string => typeof feature === "string")
      : null,
  }
}

/**
 * The plugin's `info` in one bounded read, asked anew by every caller: its version and features
 * from the same answer, so two questions about one host can't disagree, and a caller that wants
 * the host's state now gets it. `getPluginFeatureList` is the remembered view over this.
 */
export const getPluginInfo = (config: HermesConfig): Promise<PluginInfo> =>
  pluginInfoBody(config, AbortSignal.timeout(READ_TIMEOUT_MS))

/** What the Gots plugin on the bot's server offers (`info`'s `features`). */
export const getPluginFeatures = (config: HermesConfig, signal?: AbortSignal): Promise<string[]> =>
  pluginInfoBody(config, signal).then((info) => info.features ?? [])

/** The Gots plugin's version on the bot's server, or null when it doesn't answer. */
export function getPluginVersion(config: HermesConfig): Promise<string | null> {
  return getPluginInfo(config)
    .then((info) => info.version)
    .catch(() => null)
}

const pluginFeatures = new Map<string, Promise<string[] | null>>()

/**
 * The features the Gots plugin on the bot's server advertises (`info`'s `features`), asked once per
 * server and key. **null** is the Host not answering — a different answer from a plugin that
 * answered without the feature — and a failed ask is dropped, so the next caller asks again.
 */
export function getPluginFeatureList(config: HermesConfig): Promise<string[] | null> {
  const key = connectionKey(config)
  let pending = pluginFeatures.get(key)
  if (!pending) {
    pending = getPluginInfo(config)
      .then((info) => info.features)
      .catch(() => null)
    pluginFeatures.set(key, pending)
    void pending.then((found) => found || pluginFeatures.delete(key))
  }
  return pending
}

/** `getPluginFeatureList`, for one feature. */
export async function hasPluginFeature(config: HermesConfig, feature: string) {
  return Boolean((await getPluginFeatureList(config))?.includes(feature))
}

/** A message waiting on the Hermes host for the session's run to finish. */
export interface QueueItem {
  id: string
  text: string
  attachments: { name: string; type?: string; size?: number; path?: string }[]
  createdAt: number
  /** The run the plugin started with it, once sent. */
  runId?: string
  runStatus?: string
  /** Why the plugin couldn't start it; the queue waits until it's sent again. */
  error?: string
}

function queueItem(raw: Record<string, unknown>): QueueItem {
  return {
    id: String(raw.id),
    text: typeof raw.text === "string" ? raw.text : "",
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    createdAt: Number(raw.created_at) || Date.now(),
    runId: typeof raw.run_id === "string" ? raw.run_id : undefined,
    runStatus: typeof raw.run_status === "string" ? raw.run_status : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
  }
}

function queueRoot(config: HermesConfig, sessionId: string) {
  return `${pluginRoot(config.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/queue`
}

/** The session's queue on the plugin: what waits, and what it sent in the last hour. */
export async function getQueue(config: HermesConfig, sessionId: string) {
  const response = await request(queueRoot(config, sessionId), { headers: headers(config) })
  const body = await response.json()
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item) => item && typeof item === "object").map(queueItem)
      : []
  return { items: list(body?.items), sent: list(body?.sent), paused: Boolean(body?.paused) }
}

/** Queues a turn on the plugin, which starts it with `run` once the session's run is over. */
export async function addToQueue(
  config: HermesConfig,
  sessionId: string,
  item: { text: string; attachments: QueueItem["attachments"]; run: Record<string, unknown> },
) {
  const response = await request(queueRoot(config, sessionId), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ text: item.text, attachments: item.attachments, body: item.run }),
  })
  return queueItem((await response.json())?.item ?? {})
}

/**
 * The host's triage of a message sent from Main: it stays, or the plugin queued it on an older
 * thread (`thread`) or on one it just made (`new`).
 */
export type Triage = { decision: "main" } | { decision: "thread" | "new"; threadId: string }

/** Asks the host where a message from Main belongs; a thread's answer means it is already queued there. */
export async function triageMessage(
  config: HermesConfig,
  sessionId: string,
  item: {
    id: string
    text: string
    run: Record<string, unknown>
    attachments: { name: string; type: string; size: number; path?: string }[]
    /** Whether a message for a thread that is mid-reply steers it, else it waits in that thread's queue. */
    steer?: boolean
  },
  signal?: AbortSignal,
): Promise<Triage> {
  const response = await request(
    `${pluginRoot(config.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/triage`,
    {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        id: item.id,
        text: item.text,
        body: item.run,
        attachments: item.attachments,
        steer: item.steer === true,
      }),
      signal,
    },
  )
  const body = await response.json()
  // A thread's answer counts only with the queued item that proves the host has the message.
  return (body?.decision === "thread" || body?.decision === "new") &&
    typeof body.thread === "string" &&
    body.item?.id
    ? { decision: body.decision, threadId: body.thread }
    : { decision: "main" }
}

/** A message triage sent out of Main, as the host recorded it; `at` is on the host's clock. */
export interface Move {
  id: string
  text: string
  /** The chat it went to. */
  threadId: string
  at: number
  undone: boolean
  /** Whether Undo is still offered: the thread's reply to this message hasn't finished. */
  undoable: boolean
  /** Whether the host opened this thread for the message, so its card stands where the marker would. */
  new: boolean
}

const movesRoot = (config: HermesConfig, sessionId: string) =>
  `${pluginRoot(config.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/moves`

/** The messages triage moved out of a Main thread, oldest first. */
export async function getMoves(config: HermesConfig, sessionId: string): Promise<Move[]> {
  const response = await request(movesRoot(config, sessionId), {
    headers: headers(config),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  return readMoves((await response.json())?.moves)
}

/** Takes a moved message back: the host stops the thread's reply, and sends it to Main untriaged. */
export async function postMoveUndo(config: HermesConfig, sessionId: string, moveId: string) {
  await request(`${movesRoot(config, sessionId)}/${encodeURIComponent(moveId)}/undo`, {
    method: "POST",
    headers: headers(config),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
}

function readMoves(value: unknown): Move[] {
  if (!Array.isArray(value)) return []
  const found: Move[] = []
  for (const raw of value) {
    const row = (raw ?? {}) as Record<string, unknown>
    if (typeof row.id !== "string" || typeof row.thread !== "string" || typeof row.at !== "number")
      continue
    found.push({
      id: row.id,
      text: typeof row.text === "string" ? row.text : "",
      threadId: row.thread,
      at: row.at,
      undone: Boolean(row.undone),
      undoable: Boolean(row.undoable),
      // An older host doesn't say, and every move it recorded joined an existing thread.
      new: Boolean(row.new),
    })
  }
  return found
}

/** `remove` drops a queued message, `send` puts it first and lets a paused queue go, `steer` hands it to the running reply. */
export async function queueAction(
  config: HermesConfig,
  sessionId: string,
  itemId: string,
  action: "remove" | "send" | "steer",
) {
  const response = await request(
    `${queueRoot(config, sessionId)}/${encodeURIComponent(itemId)}/${action}`,
    { method: "POST", headers: headers(config) },
  )
  return (await response.json()) as Record<string, unknown>
}

function researchRoot(config: HermesConfig, id?: string) {
  const root = `${pluginRoot(config.baseUrl)}/research`
  return id ? `${root}/${encodeURIComponent(id)}` : root
}

/** The bot's research missions on the plugin (`research.py`), as it sends them. */
export async function listResearch(config: HermesConfig, signal?: AbortSignal) {
  const response = await request(researchRoot(config), { headers: headers(config), signal })
  const body = await response.json()
  return {
    missions: Array.isArray(body?.missions) ? (body.missions as Record<string, unknown>[]) : [],
    unavailable: typeof body?.unavailable === "string" ? body.unavailable : null,
  }
}

/** Starts a mission at its brief, which the plugin reads back from the question. */
export async function createResearch(config: HermesConfig, input: string, type: string) {
  const response = await request(researchRoot(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ input, type }),
  })
  return (await response.json())?.mission as Record<string, unknown>
}

/** A mission with its ledger and what was written from it. */
export async function getResearch(config: HermesConfig, id: string, signal?: AbortSignal) {
  const response = await request(researchRoot(config, id), { headers: headers(config), signal })
  return (await response.json())?.mission as Record<string, unknown>
}

/**
 * `brief` confirms the brief, `edit` goes back to it, `start` passes the Scope Gate, `formats`
 * makes another format, `followup` reads again for questions it missed, `rewrite` writes it again
 * with another model, `retry` runs a failed step again and `remove` deletes the mission.
 */
export async function researchAction(
  config: HermesConfig,
  id: string,
  action: "brief" | "edit" | "start" | "formats" | "followup" | "rewrite" | "retry" | "remove",
  body: Record<string, unknown> = {},
) {
  const response = await request(`${researchRoot(config, id)}/${action}`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(body),
  })
  return (await response.json())?.mission as Record<string, unknown> | undefined
}

function meetingRoot(config: HermesConfig, id?: string) {
  const root = `${pluginRoot(config.baseUrl)}/meetings`
  return id ? `${root}/${encodeURIComponent(id)}` : root
}

/** The bot's meetings on the plugin (`meetings.py`), without their transcripts and notes. */
export async function listMeetings(config: HermesConfig, signal?: AbortSignal) {
  const response = await request(meetingRoot(config), { headers: headers(config), signal })
  const body = await response.json()
  return {
    meetings: Array.isArray(body?.meetings) ? (body.meetings as Record<string, unknown>[]) : [],
    unavailable: typeof body?.unavailable === "string" ? body.unavailable : null,
  }
}

/** A meeting with its transcript and notes. */
export async function getMeeting(config: HermesConfig, id: string, signal?: AbortSignal) {
  const response = await request(meetingRoot(config, id), { headers: headers(config), signal })
  return (await response.json())?.meeting as Record<string, unknown>
}

/** Starts a meeting: `parts` chunks of audio to send, or a transcript the app already parsed. */
export async function createMeetingOnHost(
  config: HermesConfig,
  body: {
    title: string
    project_id?: string
    parts?: number
    transcript?: { at: number; text: string }[]
  },
) {
  const response = await request(meetingRoot(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return (await response.json())?.meeting as Record<string, unknown>
}

/** One byte chunk of the recording, in order; the host joins them and cuts the audio itself. */
export async function uploadMeetingChunk(
  config: HermesConfig,
  id: string,
  n: number,
  chunk: Blob,
  signal?: AbortSignal,
) {
  const response = await request(`${meetingRoot(config, id)}/parts?n=${n}`, {
    method: "POST",
    headers: headers(config, { "Content-Type": chunk.type || "application/octet-stream" }),
    body: chunk,
    signal,
  })
  return (await response.json())?.meeting as Record<string, unknown>
}

/** `finish` says every chunk is in, `retry` runs a failed step again and `remove` deletes it. */
export async function meetingAsk(config: HermesConfig, id: string, question: string) {
  const response = await request(`${meetingRoot(config, id)}/ask`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return (await response.json())?.meeting as Record<string, unknown> | undefined
}

export async function meetingAction(
  config: HermesConfig,
  id: string,
  action: "finish" | "retry" | "remove",
) {
  const response = await request(`${meetingRoot(config, id)}/${action}`, {
    method: "POST",
    headers: headers(config),
    body: "{}",
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return (await response.json())?.meeting as Record<string, unknown> | undefined
}

/** Whether the host lets Gots pick the model of a call (`info`'s `research.writers`): a Research
 * rewrite, a judge, a bot's triage model. */
export async function getResearchWriters(config: HermesConfig) {
  const response = await request(`${pluginRoot(config.baseUrl)}/info`, { headers: headers(config) })
  const writers = (await response.json())?.research?.writers
  return { model: Boolean(writers?.model), provider: Boolean(writers?.provider) }
}

/** What the plugin's media route answers a mint: where the file can be read, and what it is. */
export interface MediaUrlAnswer {
  url: string
  type: string
  size: number
}

/**
 * A URL the plugin signs for one file (`POST /media/url`): an `<img>` or a `<video>` can't carry the
 * bot's key, so the host signs the path, the profile and a few minutes of expiry instead. The app
 * asks once per file and keeps the answer for the page's life — nothing is fetched into it.
 */
export async function getPluginMediaUrl(
  config: HermesConfig,
  path: string,
  signal?: AbortSignal,
): Promise<MediaUrlAnswer> {
  const response = await request(`${pluginRoot(config.baseUrl)}/media/url`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ path }),
    signal,
  })
  const body = await response.json()
  // A URL is what every cell draws from: a mint that answers without one is a failure here, where
  // it can be said, rather than an `undefined` that reaches an `<img src>` a layer away.
  if (typeof body?.url !== "string" || !body.url)
    throw new HermesError("The bot's plugin answered without a URL for the file.", 502)
  return { url: body.url, type: String(body.type ?? ""), size: Number(body.size ?? 0) }
}

/** The plugin pings its change stream every 20s, so one quiet for longer has died unnoticed. */
const EVENTS_IDLE_MS = 50_000

/**
 * Follows the Gots plugin's change stream until it ends. `hello` and `reset` carry the cursor to
 * resume from; `session`, `title`, `chats`, `cron`, `runs` and `projects` say what changed, never
 * the content. A stream that goes quiet rejects with a `TimeoutError`.
 */
export async function followEvents(
  config: HermesConfig,
  options: { since?: number; device?: string; signal?: AbortSignal },
  onEvent: (event: string, data: Record<string, unknown>) => void,
) {
  const params = new URLSearchParams()
  if (options.since !== undefined) params.set("since", String(options.since))
  // Tells the plugin this device has the app on screen, so it sends it no push.
  if (options.device) params.set("device", options.device)
  const query = params.size ? `?${params}` : ""
  const response = await request(`${pluginRoot(config.baseUrl)}/events${query}`, {
    headers: headers(config),
    signal: options.signal,
  })
  if (!response.body) throw new HermesError("Hermes returned an empty response.")
  for await (const { event, data } of readSse(response.body, EVENTS_IDLE_MS)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    onEvent(
      event,
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {},
    )
  }
}

/** What a device gives the plugin to push to it: its browser subscription and the VAPID key made for it. */
export interface PushRegistration {
  device: string
  subscription: PushSubscriptionJSON
  vapid_key: string
  subject: string
  /** The categories of push this device wants (see `push-kinds.ts`). */
  categories: string[]
}

export async function registerPush(config: HermesConfig, registration: PushRegistration) {
  await request(`${pluginRoot(config.baseUrl)}/push`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(registration),
  })
}

/** Mutes or unmutes every push this bot's plugin would send, to every device. */
/** Mutes the bot's pushes, and says which character it is so they show its picture. */
export async function setPushMuted(config: HermesConfig, muted: boolean, bot?: string) {
  await request(`${pluginRoot(config.baseUrl)}/push/mute`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ muted, bot }),
  })
}

export async function unregisterPush(config: HermesConfig, endpoint: string) {
  await request(`${pluginRoot(config.baseUrl)}/push/remove`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ endpoint }),
  })
}

/** A fresh `API_SERVER_KEY`: 32 random bytes as 64 hex characters, like `openssl rand -hex 32`. */
export function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Each job's newest runs, newest first. A 404 means the Gots plugin isn't installed. */
export async function listCronRuns(
  config: HermesConfig,
  perJob: number,
): Promise<Record<string, CronExecutionRun[]>> {
  const response = await request(`${pluginRoot(config.baseUrl)}/cron/runs?per_job=${perJob}`, {
    headers: headers(config),
  })
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
  /** `user/repo` from the clone's GitHub origin; what the UI calls the folder. */
  repo: string | null
  /** The branch a session's worktree starts from (plugin 0.17). */
  branch: string | null
  /**
   * While the project is being created, this repo's clone; on a ready project, a repo being added
   * (`cloning`, or `failed` with `error`) or removed (`removing`). Unset once it's settled.
   */
  status?: "queued" | "cloning" | "done" | "failed" | "removing"
  error?: string
}

export type ProjectStatus = "ready" | "cloning" | "failed"

/** A Hermes Project (`hermes project create`), through the Gots plugin. */
export interface HermesProject {
  id: string
  name: string
  description: string | null
  createdAt: number
  /** The newest session in one of its folders; unset when none has run there. */
  lastActiveAt?: number
  /** `cloning` and `failed` are a project the plugin is still creating, which has no sessions yet. */
  status: ProjectStatus
  /** Why a `failed` project failed. */
  error?: string
  archived: boolean
  /** When it was pinned, which sorts it to the top of the Code screen; unset when it isn't. */
  pinnedAt?: number
  /** Primary folder first. */
  folders: HermesProjectFolder[]
}

const FOLDER_STATUSES = ["queued", "cloning", "done", "failed", "removing"] as const

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
    status: p.status === "cloning" || p.status === "failed" ? p.status : "ready",
    error: typeof p.error === "string" && p.error ? p.error : undefined,
    archived: p.archived === true,
    pinnedAt: seconds(p.pinned_at),
    folders: folders
      .filter((f): f is Record<string, unknown> => typeof f?.path === "string")
      .map((f) => ({
        path: f.path as string,
        label: typeof f.label === "string" && f.label ? f.label : null,
        git: f.git === true,
        repo: typeof f.repo === "string" && f.repo ? f.repo : null,
        branch: typeof f.branch === "string" && f.branch ? f.branch : null,
        status: FOLDER_STATUSES.find((status) => status === f.status),
        error: typeof f.error === "string" && f.error ? f.error : undefined,
      })),
  }
}

/** The profile's Hermes Projects. A 404 (or a CORS-blocked one) means no plugin, or an older one. */
export async function listProjects(config: HermesConfig): Promise<HermesProject[]> {
  const response = await request(`${pluginRoot(config.baseUrl)}/projects`, {
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
  const response = await request(`${pluginRoot(config.baseUrl)}/github`, {
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
  const response = await request(`${pluginRoot(config.baseUrl)}/github/repos`, {
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
 * Starts a project in the profile's `projects/` folder on the server. The plugin clones each repo in
 * the background, so this answers at once with a project that is `cloning` until they are all in.
 */
export async function createProject(
  config: HermesConfig,
  project: { name: string; description?: string; repos: string[] },
): Promise<void> {
  await request(`${pluginRoot(config.baseUrl)}/projects`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(project),
  })
}

/** Starts a `failed` project's clones over. */
export async function retryProject(config: HermesConfig, id: string): Promise<void> {
  await request(`${pluginRoot(config.baseUrl)}/projects/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    headers: headers(config),
    body: "{}",
  })
}

/** Renames a project, changes its description, archives or restores it, or pins it. */
export async function updateProject(
  config: HermesConfig,
  id: string,
  fields: { name?: string; description?: string; archived?: boolean; pinned?: boolean },
): Promise<void> {
  await request(`${pluginRoot(config.baseUrl)}/projects/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(fields),
  })
}

/**
 * Clones another GitHub repo into a project. The plugin clones in the background and adds the repo
 * to the project once it's in; until then the project lists it as `cloning`.
 */
export async function addProjectRepo(config: HermesConfig, id: string, repo: string) {
  await request(`${pluginRoot(config.baseUrl)}/projects/${encodeURIComponent(id)}/repos`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ repo }),
  })
}

/** Takes a repo out of a project (or stops adding it); the plugin deletes its clone in the background. */
export async function removeProjectRepo(config: HermesConfig, id: string, repo: string) {
  await request(`${pluginRoot(config.baseUrl)}/projects/${encodeURIComponent(id)}/repos/remove`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ repo }),
  })
}

export interface ProjectSessionUsage {
  id: string
  title?: string
  /** Epoch ms. */
  lastActive?: number
  /** The session's use per model (a session can change models when it's compressed). */
  models: ModelUsage[]
}

export interface ProjectUsage {
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Unset when Hermes priced none of the sessions. */
  costUsd?: number
  /** Each session's own use; empty from a plugin older than 0.21. */
  threads: ProjectSessionUsage[]
}

const positive = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0)

function modelUsage(body: Record<string, unknown>): ModelUsage {
  return {
    model: typeof body.model === "string" && body.model ? body.model : undefined,
    inputTokens: positive(body.input_tokens),
    outputTokens: positive(body.output_tokens),
    cacheReadTokens: positive(body.cache_read_tokens),
    cacheWriteTokens: positive(body.cache_write_tokens),
    costUsd: typeof body.cost_usd === "number" ? body.cost_usd : undefined,
  }
}

/** What the sessions that ran in a project's folders used, from Hermes's session store. */
export async function getProjectUsage(config: HermesConfig, id: string): Promise<ProjectUsage> {
  const response = await request(
    `${pluginRoot(config.baseUrl)}/projects/${encodeURIComponent(id)}/usage`,
    { headers: headers(config) },
  )
  const body = await response.json()
  const threads: ProjectSessionUsage[] = Array.isArray(body?.threads)
    ? body.threads
        .filter((thread: unknown) => thread && typeof (thread as { id?: unknown }).id === "string")
        .map((thread: Record<string, unknown>) => {
          const active = thread.last_active ?? thread.started_at
          return {
            id: thread.id as string,
            title: typeof thread.title === "string" && thread.title ? thread.title : undefined,
            lastActive: typeof active === "number" ? active * 1000 : undefined,
            models: Array.isArray(thread.models)
              ? thread.models.filter((m) => m && typeof m === "object").map(modelUsage)
              : [],
          }
        })
    : []
  const totals = modelUsage(body ?? {})
  return {
    sessions: positive(body?.sessions),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costUsd: totals.costUsd,
    threads,
  }
}

/**
 * Deletes a project's record on the server. Its folders and clones stay on the host, except for a
 * project still being created, which is stopped and wiped.
 */
export async function deleteProject(config: HermesConfig, id: string): Promise<void> {
  await request(`${pluginRoot(config.baseUrl)}/projects/${encodeURIComponent(id)}/remove`, {
    method: "POST",
    headers: headers(config),
    body: "{}",
  })
}

/**
 * Merges this device's chat list into the one the Gots plugin keeps, newer record winning, and
 * returns the merged list. A 404 (or a CORS-blocked one, with no status) means no plugin, or an older one.
 */
export async function mergeChatList<T>(
  config: HermesConfig,
  chats: Doc<T>,
  signal?: AbortSignal,
): Promise<Doc<T>> {
  const response = await request(`${pluginRoot(config.baseUrl)}/chats`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ chats }),
    signal,
  })
  const body = await response.json()
  if (!body?.chats || typeof body.chats !== "object") throw new Error("Unexpected chat list")
  return body.chats
}

/** A model one of a chat's calls ran on, as its host recorded it. */
export interface ModelChange {
  /** When that call ran, on the host's own clock. */
  at: number
  model: string
  provider?: string
}

/** A point where the host compacted a chat's context, on its own clock. */
export interface Compaction {
  at: number
  /** The summary's row, for one made in place, where the plugin names it. */
  row?: number
  /** The context just before it: the last prompt size the host recorded, and the window it was measured against. */
  tokens?: number
  window?: number
}

export interface SessionContext {
  /** Prompt tokens of the session's latest model call. */
  tokens?: number
  /** The context window Hermes runs that model with. */
  window?: number
  /** The model that ran the call, as Hermes names it, so the app can tell a switch from it. */
  model?: string
  /** Every model the session's calls ran on, oldest first, so its thread can show where it changed. */
  modelChanges?: ModelChange[]
  /** Every time the host compacted the chat, oldest first, so its thread can mark where. */
  compactions?: Compaction[]
}

/**
 * A session's context use as the Gots plugin recorded it, following compression to the live
 * session. Null when it has nothing for the session yet.
 */
export async function getSessionContext(
  config: HermesConfig,
  sessionId: string,
): Promise<SessionContext | null> {
  const response = await request(
    `${pluginRoot(config.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/context`,
    // Bounded like every other read: this one is fired as a turn is sent too, where a hung host would
    // leave a reply's divider unknown and the request pending for the life of the page.
    { headers: headers(config), signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
  )
  const body = await response.json()
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  const tokens = count(body?.prompt_tokens)
  const model = typeof body?.model === "string" && body.model ? body.model : undefined
  const modelChanges = readChanges(body?.model_changes)
  const compactions = readCompactions(body?.compactions)
  // A host that recorded a change but no figure for it still has the list worth showing.
  if (!tokens && !modelChanges && !compactions) return null
  return {
    ...(tokens ? { tokens } : {}),
    window: count(body?.context_length),
    model,
    ...(modelChanges ? { modelChanges } : {}),
    ...(compactions ? { compactions } : {}),
  }
}

/** The plugin's `compactions`: a list, even an empty one, is the host's answer; anything else is unknown. */
function readCompactions(value: unknown): Compaction[] | undefined {
  if (!Array.isArray(value)) return undefined
  const found: Compaction[] = []
  for (const raw of value) {
    const row = (raw ?? {}) as Record<string, unknown>
    if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue
    const count = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
    const tokens = count(row.tokens)
    const window = count(row.window)
    const summary = typeof row.row === "number" && Number.isInteger(row.row) ? row.row : undefined
    found.push({
      at: row.at,
      ...(summary !== undefined ? { row: summary } : {}),
      ...(tokens ? { tokens } : {}),
      ...(window ? { window } : {}),
    })
  }
  return found
}

/** The plugin's `model_changes`, dropping anything that isn't a row. */
function readChanges(value: unknown): ModelChange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const changes: ModelChange[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue
    const row = raw as Record<string, unknown>
    if (typeof row.model !== "string" || !row.model) continue
    if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue
    changes.push({
      at: row.at,
      model: row.model,
      ...(typeof row.provider === "string" && row.provider ? { provider: row.provider } : {}),
    })
  }
  return changes.length ? changes : undefined
}

export interface UsageWindow {
  label: string
  usedPercent: number
  resetsAt?: number
  detail?: string
  /**
   * What the account marked this window with: `account` for the login's own, `model` for one model
   * family, and nothing where a plugin older than the fact answers. Carried so the app can tell a
   * model-scoped window from an account's own without reading its label (ADR 0026).
   */
  scope?: string
}

export interface ProviderUsage {
  provider: string
  plan?: string
  windows: UsageWindow[]
  /**
   * The window the plugin's pickup rule judged deciding, or absent where none does — a balance with
   * room left is capacity, and then nothing is judged. Answered by the host so a screen shows the
   * figure the sweep judged instead of deriving a second copy of the rule, and a caller holding a
   * threshold of its own compares this window's percent against it (ADR 0026).
   */
  deciding?: UsageWindow
  at: number
}

/** The provider's account-usage windows (plan quota), from the Gots plugin's
 * route that calls Hermes core's fetch_account_usage. Null when the provider has
 * no live windows; a failed read throws, so the caller can tell a missing plugin
 * (an older one, no route) from a busy server.
 */
export async function getProviderUsage(
  config: HermesConfig,
  provider: string,
  signal?: AbortSignal,
): Promise<ProviderUsage | null> {
  const response = await request(
    `${pluginRoot(config.baseUrl)}/usage?provider=${encodeURIComponent(provider)}`,
    { headers: headers(config), ...(signal ? { signal } : {}) },
  )
  const body = await response.json()
  const rawWindows: unknown[] = Array.isArray(body?.windows) ? body.windows : []
  const now = Date.now()
  const windows: UsageWindow[] = []
  for (const raw of rawWindows) {
    const window = parseUsageWindow(raw, now)
    if (window) windows.push(window)
  }
  if (!windows.length) return null
  const deciding = parseUsageWindow(body?.deciding, now)
  return {
    provider,
    ...(typeof body?.plan === "string" && body.plan ? { plan: body.plan } : {}),
    windows,
    ...(deciding ? { deciding } : {}),
    at: now,
  }
}

/**
 * One window as the usage route writes it, or undefined where it isn't one — a window with no used
 * percent, or one whose reset time has already passed, since the plugin drops those before it
 * answers and a deciding window that isn't among the windows would read as a figure from nowhere.
 */
function parseUsageWindow(raw: unknown, now: number): UsageWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const pct =
    typeof r.used_percent === "number" && Number.isFinite(r.used_percent)
      ? r.used_percent
      : undefined
  if (pct === undefined) return undefined
  const resetIso = typeof r.resets_at === "string" && r.resets_at ? r.resets_at : undefined
  const resetMs = resetIso ? Date.parse(resetIso) : NaN
  if (resetIso && (!Number.isFinite(resetMs) || resetMs <= now)) return undefined
  return {
    label: typeof r.label === "string" ? r.label : "",
    usedPercent: Math.max(0, Math.min(100, pct)),
    ...(Number.isFinite(resetMs) ? { resetsAt: resetMs } : {}),
    ...(typeof r.detail === "string" && r.detail ? { detail: r.detail } : {}),
    ...(typeof r.scope === "string" && r.scope ? { scope: r.scope } : {}),
  }
}

export interface SessionTodos {
  revision: number
  items: Todo[]
  /** The list's progress, as the plugin worked it out; unset from a plugin older than 0.48. */
  progress?: TodoProgress
}

const TODO_STATUSES = new Set<string>(["pending", "in_progress", "completed", "cancelled"])

/** Reads a `todo_list` result (`{ todos, revision, progress }`), or null when it isn't one. */
export function parseTodos(value: unknown): SessionTodos | null {
  const body = value as { todos?: unknown; revision?: unknown; progress?: unknown } | null
  if (!body || !Array.isArray(body.todos)) return null
  const items: Todo[] = []
  for (const raw of body.todos) {
    const id = raw?.id
    if ((typeof id !== "string" && typeof id !== "number") || typeof raw?.content !== "string")
      continue
    if (!TODO_STATUSES.has(raw.status)) continue
    const parent = raw.parent
    const depth =
      typeof raw.depth === "number" && raw.depth > 0 ? Math.min(raw.depth, MAX_TODO_DEPTH) : 0
    items.push({
      id: String(id),
      content: raw.content,
      status: raw.status,
      ...(typeof parent === "string" || typeof parent === "number"
        ? { parent: String(parent) }
        : {}),
      depth,
    })
  }
  const revision = typeof body.revision === "number" && body.revision >= 0 ? body.revision : 0
  return { revision, items, ...(readProgress(body.progress) ?? {}) }
}

/** The progress the plugin sent, or undefined when it didn't: never worked out here. */
function readProgress(value: unknown): { progress: TodoProgress } | undefined {
  const body = value as { done?: unknown; total?: unknown } | null
  if (!body || typeof body?.done !== "number" || typeof body?.total !== "number") return undefined
  if (body.done < 0 || body.total < 0 || body.done > body.total) return undefined
  return { progress: { done: body.done, total: body.total } }
}

/**
 * The agent's todo list in a session (and the ones it was compressed from), read from the
 * transcript by the Gots plugin. Null when the agent hasn't written one.
 */
export async function getSessionTodos(
  config: HermesConfig,
  sessionId: string,
): Promise<SessionTodos | null> {
  const response = await request(
    `${pluginRoot(config.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/todos`,
    { headers: headers(config) },
  )
  return parseTodos(await response.json())
}

/** A project session's worktrees and permission mode, as the Gots plugin keeps them. */
export interface SessionWorkspace {
  projectId: string
  branch: string
  /** One worktree per repo of the project, primary first; `name` is `user/repo`. */
  repos: { name: string; branch: string }[]
  mode: SessionMode
  planPending: boolean
  /** The newest plan the plugin saved, as `plans/<file>.md` under the project's folder. */
  planFile: string | null
  /** Where the agent's worktrees are and, in plan mode, the plan's shape; every run's `instructions`. */
  instructions: string
  /** Why the session can't take another turn: a repo it works in left the project, or it's archived. */
  blocked: string | null
  /** The stages a staged AFK task ran in, on the session's own record; null when it isn't staged. */
  pipeline: SessionPipeline | null
}

const MODES = new Set<string>(["accept_edits", "auto", "plan"])

function parseWorkspace(raw: unknown, sessionId: string): SessionWorkspace | null {
  const body = raw as {
    workspace?: Record<string, unknown>
    instructions?: unknown
    blocked?: unknown
  } | null
  const record = body?.workspace
  if (!record || typeof record.branch !== "string") return null
  // A record that names another session is that session's workspace: a plugin answering through a
  // parent walk, or a stale copy. This session would show its pending plan and approve its file.
  if (typeof record.session_id === "string" && record.session_id && record.session_id !== sessionId)
    return null
  const mode =
    typeof record.mode === "string" && MODES.has(record.mode) ? record.mode : "accept_edits"
  const repos = Array.isArray(record.repos) ? record.repos : []
  return {
    projectId: String(record.project_id ?? ""),
    branch: record.branch,
    repos: repos
      .filter((r): r is Record<string, unknown> => typeof r?.name === "string")
      .map((r) => ({
        name: r.name as string,
        branch: typeof r.branch === "string" ? r.branch : (record.branch as string),
      })),
    mode: mode as SessionMode,
    planPending: Boolean(record.plan_pending),
    planFile: typeof record.plan_file === "string" && record.plan_file ? record.plan_file : null,
    instructions: typeof body?.instructions === "string" ? body.instructions : "",
    blocked: typeof body?.blocked === "string" && body.blocked ? body.blocked : null,
    // A plugin from before the stages answers none: that session is one run, which is what it is.
    pipeline: parsePipeline(record.pipeline),
  }
}

function pluginSession(config: HermesConfig, sessionId: string, path: string) {
  return `${pluginRoot(config.baseUrl)}/sessions/${encodeURIComponent(sessionId)}${path}`
}

/**
 * Gives a project session its worktrees (made on the first call, one per repo of the project) and
 * points its tools into the primary one. The pointer only lives in the gateway's memory, so this
 * runs before every turn.
 */
export async function ensureWorkspace(
  config: HermesConfig,
  sessionId: string,
  options: { projectId: string; task?: string; mode?: SessionMode },
): Promise<SessionWorkspace> {
  const response = await request(pluginSession(config, sessionId, "/workspace"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      project_id: options.projectId,
      task: options.task,
      mode: options.mode,
    }),
  })
  const workspace = parseWorkspace(await response.json(), sessionId)
  if (!workspace) throw new HermesError("The plugin didn't return a workspace.")
  return workspace
}

/**
 * Saves a file the user attached on the Hermes host, under the session, and returns its path there
 * for the message to name.
 */
export async function uploadAttachment(
  config: HermesConfig,
  sessionId: string,
  file: { name: string; blob: Blob },
) {
  let response: Response
  try {
    response = await request(
      `${pluginSession(config, sessionId, "/attachments")}?name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: headers(config, { "Content-Type": "application/octet-stream" }),
        body: file.blob,
      },
    )
  } catch (error) {
    // An older plugin's 404 skips CORS, so it fails like an unreachable server.
    if (error instanceof HermesError && (error.status === 404 || error.status === undefined))
      throw new HermesError(
        `Couldn't attach ${file.name}. Check that Hermes is reachable and its Gots plugin is up to date.`,
        error.status,
      )
    throw error
  }
  const body = await response.json()
  if (typeof body?.path !== "string") throw new HermesError("The plugin didn't save the file.")
  return body.path as string
}

/** Whether the bot's host can turn speech into text, and by whom (`info`'s `dictation`, ADR 0069). */
export interface DictationInfo {
  ready: boolean
  /** Why it can't: nobody to hear a take, speech-to-text turned off, or a plugin from before dictation. */
  reason: string | null
  model?: string
  /** Who hears this bot's takes, where the host answers it — the same shape `GET speech` carries. */
  provider?: HeardBy
}

export async function getDictationInfo(config: HermesConfig): Promise<DictationInfo> {
  const response = await request(`${pluginRoot(config.baseUrl)}/info`, { headers: headers(config) })
  const raw = (await response.json())?.dictation
  if (!raw || typeof raw !== "object")
    return {
      ready: false,
      reason: "The Gots plugin on this bot's host is too old for speech-to-text.",
    }
  return {
    ready: Boolean(raw.ready),
    reason: typeof raw.reason === "string" ? raw.reason : null,
    model: typeof raw.model === "string" ? raw.model : undefined,
    provider: readHeardBy(raw.provider),
  }
}

/** Loads the host's speech model while the user talks, so the clip doesn't wait for it. */
export async function warmDictation(config: HermesConfig) {
  await request(`${pluginRoot(config.baseUrl)}/dictation/warm`, {
    method: "POST",
    headers: headers(config),
  })
}

/**
 * A recorded clip, and the take it belongs to: `vocabulary` is the bot's own words (its Dictation
 * tab), sent as one repeated query param each; `context` is the text heard before this clip.
 *
 * `first` and `last` delimit a take: a host hearing it on a cloud provider holds the pieces from
 * the first and uploads the whole take on the last, answering `""` to every piece in between and
 * dropping anything still held when a new take begins (ADR 0069). A local host ignores both.
 */
export interface ClipOptions {
  hint?: string
  context?: string
  vocabulary?: string[]
  signal?: AbortSignal
  first?: boolean
  last?: boolean
}

/** A recorded clip's text, `""` when nobody spoke. */
export async function transcribeClip(
  config: HermesConfig,
  clip: Blob,
  {
    hint = "",
    context = "",
    vocabulary = [],
    signal,
    first = false,
    last = false,
  }: ClipOptions = {},
) {
  const query = new URLSearchParams()
  if (hint) query.set("hint", hint)
  // A plugin before 0.35 ignores the text heard before this clip.
  if (context) query.set("context", context.slice(-400))
  if (first) query.set("first", "1")
  if (last) query.set("last", "1")
  for (const word of vocabulary) if (word) query.append("vocabulary", word)
  const search = query.toString() ? `?${query}` : ""
  const response = await request(`${pluginRoot(config.baseUrl)}/dictation${search}`, {
    method: "POST",
    headers: headers(config, { "Content-Type": clip.type || "audio/webm" }),
    body: clip,
    signal,
  })
  const text = (await response.json())?.text
  return typeof text === "string" ? text : ""
}

/**
 * A finished dictation tidied whole (`POST dictation/cleanup`, ADR 0038): the words the host heard,
 * the bot's vocabulary and the names the take may mention in, the tidied text out (ADR 0066).
 *
 * The answer is null when the host didn't answer with text at all — a shape the route never sends,
 * and the take lands the words as it heard them. A refusal, a timeout or a host without the route
 * throws, as every call here does; a take treats those the same way and never fails over one.
 */
export async function tidyDictation(
  config: HermesConfig,
  text: string,
  vocabulary: string[] = [],
  hint = "",
  signal?: AbortSignal,
): Promise<string | null> {
  const response = await request(`${pluginRoot(config.baseUrl)}/dictation/cleanup`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ text, vocabulary, ...(hint ? { hint } : {}) }),
    signal,
  })
  const tidied = (await response.json())?.text
  return typeof tidied === "string" && tidied.trim() ? tidied : null
}

/** The session's workspace, or null when it has none (or the plugin predates them). */
export async function getWorkspace(
  config: HermesConfig,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionWorkspace | null> {
  const response = await request(pluginSession(config, sessionId, "/workspace"), {
    headers: headers(config),
    signal,
  })
  return parseWorkspace(await response.json(), sessionId)
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
  return parseWorkspace(await response.json(), sessionId)
}

/** A session the agent delegated to with `delegate_task`, from Hermes's store via the plugin. */
export interface DelegatedAgent {
  id: string
  goal: string
  model: string | null
  /** Unix seconds. */
  startedAt: number | null
  endedAt: number | null
  toolCalls: number
  status: "running" | "done" | "stopped"
  /**
   * Why a stop this device asked for didn't happen, in the host's words. Kept on the device, from
   * the answer to that press: the host's own row says nothing about a stop it refused.
   */
  stopReason?: string
}

function parseAgents(raw: unknown): DelegatedAgent[] {
  const num = (value: unknown) => (typeof value === "number" ? value : null)
  return (Array.isArray(raw) ? raw : [])
    .filter((a) => typeof a?.id === "string" && a.id)
    .map((a) => ({
      id: a.id,
      goal: typeof a.goal === "string" ? a.goal : "",
      model: typeof a.model === "string" ? a.model : null,
      startedAt: num(a.started_at),
      endedAt: num(a.ended_at),
      toolCalls: num(a.tool_calls) ?? 0,
      status: a.status === "running" || a.status === "stopped" ? a.status : "done",
    }))
}

const str = (value: unknown) => (typeof value === "string" ? value : "")

/** The sessions a session delegated to, oldest first. A 404 means the plugin is missing. */
export async function getSessionAgents(
  config: HermesConfig,
  sessionId: string,
): Promise<DelegatedAgent[]> {
  const response = await request(
    `${pluginRoot(config.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/agents`,
    { headers: headers(config) },
  )
  return parseAgents((await response.json())?.agents)
}

/** What a subagent's stop answered: it stopped, or the host's reason it didn't (nothing left to). */
export interface AgentStop {
  stopped: boolean
  reason?: string
}

/**
 * Stops one subagent of a chat — the child's own session id, which is the card's agent id — while
 * its agent works; a session's own Stop takes the rest, through `stopAllAgents` (ADR 0051). Needs
 * plugin 0.79 (`subagent_stop`), and never answers a 404 for an unknown session: a host without the
 * route refuses the request itself, which the card never makes.
 */
export async function stopAgent(
  config: HermesConfig,
  sessionId: string,
  agentId: string,
): Promise<AgentStop> {
  const response = await request(
    pluginSession(config, sessionId, `/agents/${encodeURIComponent(agentId)}/stop`),
    { method: "POST", headers: headers(config) },
  )
  const body = await response.json()
  return {
    stopped: Boolean(body?.stopped),
    reason: typeof body?.reason === "string" && body.reason ? body.reason : undefined,
  }
}

/** What a session-wide stop answered: one row per child the host was asked about. */
export interface AgentsStop {
  stopped: number
  agents: AgentStopRow[]
}

export interface AgentStopRow {
  /** The child's session id, which is the id the app's card holds. */
  id: string
  stopped: boolean
  /** Why it didn't, in the host's words. */
  reason?: string
}

/**
 * Stops every subagent a session still has at work, whichever turn started it, in one call to the
 * host (ADR 0051). Needs plugin 0.81 (`subagents_stop_all`); the caller asks once per running agent
 * on a host without it.
 */
export async function stopAllAgents(config: HermesConfig, sessionId: string): Promise<AgentsStop> {
  const response = await request(pluginSession(config, sessionId, "/agents/stop"), {
    method: "POST",
    headers: headers(config),
  })
  const body = await response.json()
  const rows = Array.isArray(body?.agents) ? body.agents : []
  return {
    stopped: typeof body?.stopped === "number" ? body.stopped : 0,
    agents: rows
      .filter((row: unknown): row is Record<string, unknown> =>
        Boolean(row && typeof row === "object"),
      )
      .filter((row: Record<string, unknown>) => typeof row.id === "string" && Boolean(row.id))
      .map((row: Record<string, unknown>) => ({
        id: row.id as string,
        stopped: Boolean(row.stopped),
        reason: typeof row.reason === "string" && row.reason ? row.reason : undefined,
      })),
  }
}

export interface KeptWorktree {
  /** `user/repo`. */
  name: string
  reason: "dirty" | "unpushed"
}

/** Asks the plugin to remove the session's worktrees; it keeps those with uncommitted or unpushed work. */
export interface ClosedRepo {
  name: string
  /** The pull request it closed. */
  closed: number | null
  branchDeleted: boolean
  error: string | null
}

/**
 * Ends a deleted or discarded session on the server: removes its worktrees (keeping those with
 * uncommitted or unpushed work), closes its open pull requests and deletes its branches on GitHub.
 * Needs plugin 0.20, and holds the request until all of it is done — `startSessionClose` is the path
 * a host that advertises `closes` takes instead (ADR 0075).
 */
export async function closeSession(
  config: HermesConfig,
  sessionId: string,
): Promise<{ removed: boolean; kept: KeptWorktree[]; results: ClosedRepo[] }> {
  const response = await request(pluginSession(config, sessionId, "/close"), {
    method: "POST",
    headers: headers(config),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  const body = await response.json()
  return {
    removed: Boolean(body?.removed),
    kept: parseKept(body?.kept),
    results: parseClosedRepos(body?.results),
  }
}

/** A session's close as the host keeps it: what it was asked to do, and what it ended with. */
export interface SessionClose {
  sessionId: string
  /** `none` is a host that was never asked to close this session. */
  state: "none" | "closing" | "done"
  startedAt: number
  endedAt: number | null
  /** The session's repositories, by name, as they stood when the close was asked for. */
  repos: string[]
  removed: boolean
  kept: KeptWorktree[]
  results: ClosedRepo[]
  error: string | null
}

function sessionClose(config: HermesConfig, sessionId: string) {
  return pluginSession(config, sessionId, "/closes")
}

/** The per-repository results both the synchronous close and a recorded one answer with. */
function parseClosedRepos(results: unknown): ClosedRepo[] {
  return Array.isArray(results)
    ? results
        .filter((r) => typeof r?.name === "string")
        .map((r) => ({
          name: r.name,
          closed: typeof r.closed === "number" ? r.closed : null,
          branchDeleted: Boolean(r.branch_deleted),
          error: typeof r.error === "string" && r.error ? r.error : null,
        }))
    : []
}

function closeOf(body: Record<string, unknown>): SessionClose {
  return {
    sessionId: typeof body?.session_id === "string" ? body.session_id : "",
    state:
      body?.state === "closing" || body?.state === "done" || body?.state === "none"
        ? body.state
        : "none",
    startedAt: Number(body?.started_at) || 0,
    endedAt: typeof body?.ended_at === "number" ? body.ended_at : null,
    repos: Array.isArray(body?.repos)
      ? (body.repos as unknown[]).filter((name): name is string => typeof name === "string")
      : [],
    removed: Boolean(body?.removed),
    kept: parseKept(body?.kept),
    results: parseClosedRepos(body?.results),
    error: typeof body?.error === "string" && body.error ? body.error : null,
  }
}

/**
 * Asks the host to close a session and answers at once, with the close as it stands: `closing`, or
 * `done` for a session the host holds nothing of. The work — worktrees, pull requests, branches —
 * runs on the host afterwards, and `getSessionClose` reads what it ended with (ADR 0075).
 */
export async function startSessionClose(
  config: HermesConfig,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionClose> {
  const response = await request(sessionClose(config, sessionId), {
    method: "POST",
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return closeOf(await response.json())
}

/** What the host's close of this session has ended with. */
export async function getSessionClose(
  config: HermesConfig,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionClose> {
  const response = await request(sessionClose(config, sessionId), {
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  return closeOf(await response.json())
}

/** Every close this host still keeps, newest first: the reports a device can be told after the fact. */
export async function getSessionCloses(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<SessionClose[]> {
  const response = await request(`${pluginRoot(config.baseUrl)}/closes`, {
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  const body = await response.json()
  const rows: unknown = body?.closes
  return Array.isArray(rows)
    ? rows.filter((row) => row && typeof row === "object").map((row) => closeOf(row))
    : []
}

function parseKept(kept: unknown): KeptWorktree[] {
  return Array.isArray(kept)
    ? kept.filter(
        (k): k is KeptWorktree =>
          typeof k?.name === "string" && (k.reason === "dirty" || k.reason === "unpushed"),
      )
    : []
}

export async function removeWorkspace(
  config: HermesConfig,
  sessionId: string,
): Promise<{ removed: boolean; kept: KeptWorktree[] }> {
  const response = await request(pluginSession(config, sessionId, "/workspace/remove"), {
    method: "POST",
    headers: headers(config),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  const body = await response.json()
  return { removed: Boolean(body?.removed), kept: parseKept(body?.kept) }
}

export interface PullRequest {
  repo: string
  number: number
  title: string
  state: PrState
  checks: PrChecks | null
  url: string | null
}

const PR_STATES = new Set<string>(["open", "draft", "merged", "closed"])
const PR_CHECKS = new Set<string>(["success", "failure", "pending"])

/** The pull request from the session's branch in each of its repos. Needs the Gots plugin. */
export async function getSessionPrs(
  config: HermesConfig,
  sessionId: string,
  signal?: AbortSignal,
): Promise<PullRequest[]> {
  const response = await request(pluginSession(config, sessionId, "/prs"), {
    headers: headers(config),
    signal,
  })
  const prs: unknown = (await response.json())?.prs
  if (!Array.isArray(prs)) return []
  return prs
    .filter((pr) => typeof pr?.number === "number" && PR_STATES.has(pr.state))
    .map((pr) => ({
      repo: typeof pr.repo === "string" ? pr.repo : "",
      number: pr.number,
      title: typeof pr.title === "string" ? pr.title : "",
      state: pr.state,
      checks: PR_CHECKS.has(pr.checks) ? pr.checks : null,
      url: typeof pr.url === "string" ? pr.url : null,
    }))
}

export interface LibraryFile {
  /** The file's name, with its extension. */
  name: string
  /** Its absolute path on the host, for the library file route. */
  path: string
  /** The folder it was filed in, one level; null when filed before folders existed. */
  folder: string | null
  /** The session that filed it, by its worktree's name. */
  worktree: string
  /** Bytes. */
  size: number
  /** Epoch ms, when the file was last written. */
  at: number
}

/** One folder of a library: the files filed in it, newest first. */
export interface LibraryFolder {
  name: string
  files: LibraryFile[]
}

function parseLibraryFile(file: unknown): LibraryFile | null {
  if (!file || typeof file !== "object") return null
  const found = file as Record<string, unknown>
  return typeof found.name === "string" &&
    typeof found.path === "string" &&
    typeof found.at === "number"
    ? {
        name: found.name,
        path: found.path,
        folder: typeof found.folder === "string" ? found.folder : null,
        worktree: typeof found.worktree === "string" ? found.worktree : "",
        size: typeof found.size === "number" ? found.size : 0,
        at: found.at,
      }
    : null
}

function parseLibrary(body: unknown): LibraryFolder[] {
  const folders: unknown = (body as { folders?: unknown } | null)?.folders
  if (!Array.isArray(folders)) return []
  return folders
    .map((folder) => {
      const found = (folder ?? {}) as Record<string, unknown>
      const files: unknown = found.files
      return {
        name: typeof found.name === "string" ? found.name : "",
        files: Array.isArray(files)
          ? files.map(parseLibraryFile).filter((file): file is LibraryFile => file !== null)
          : [],
      }
    })
    .filter((folder) => folder.name)
}

/** A project's library: every session's filed files, grouped by folder. Needs plugin 0.38. */
export async function getProjectLibrary(
  config: HermesConfig,
  projectId: string,
  signal?: AbortSignal,
): Promise<LibraryFolder[]> {
  const response = await request(
    `${pluginRoot(config.baseUrl)}/projects/${encodeURIComponent(projectId)}/library`,
    { headers: headers(config), signal },
  )
  return parseLibrary(await response.json())
}

/**
 * A session's own filed files, grouped by folder, and its worktree's name. Needs plugin 0.38.
 * An unknown session answers an empty tree, never a 404.
 */
export async function getSessionLibrary(
  config: HermesConfig,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ worktree: string | null; folders: LibraryFolder[] }> {
  const response = await request(pluginSession(config, sessionId, "/library"), {
    headers: headers(config),
    signal,
  })
  const body = (await response.json()) as { worktree?: unknown; folders?: unknown }
  return {
    worktree: typeof body?.worktree === "string" ? body.worktree : null,
    folders: parseLibrary(body),
  }
}

/** A library file's bytes, for opening it: an image in the system viewer, anything else in a tab. */
export async function getLibraryFile(
  config: HermesConfig,
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await request(
    `${pluginRoot(config.baseUrl)}/library/file?path=${encodeURIComponent(path)}`,
    { headers: headers(config), signal },
  )
  return response.blob()
}

/** One of a project's tasks: an issue the user has marked ready for an agent to work. */
export interface ProjectTask extends ProjectIssue {
  /** Who has it, when a person took it. */
  assignees: string[]
  /** What's still open ahead of it, when it can't be started yet. */
  blockers: ProjectIssue[]
}

/** An issue a task points at: a blocker it waits on, or the task AFK holds. */
export interface ProjectIssue {
  repo: string
  number: number
  title: string
  url: string | null
}

/**
 * A project's tasks as AFK reads them: the frontier — what's ready, oldest first — and what is out
 * of it, claimed or blocked by an open task. Needs plugin 0.49.
 */
export interface ProjectTasks {
  repos: string[]
  ready: ProjectTask[]
  claimed: ProjectTask[]
  blocked: ProjectTask[]
}

function parseIssue(value: unknown): ProjectIssue | null {
  const found = (value ?? {}) as Record<string, unknown>
  if (typeof found.number !== "number") return null
  return {
    repo: str(found.repo),
    number: found.number,
    title: str(found.title),
    url: str(found.url) || null,
  }
}

function parseTask(value: unknown): ProjectTask | null {
  // The task's own fields are the issue's: a field added to one is read for both.
  const issue = parseIssue(value)
  if (!issue) return null
  const found = (value ?? {}) as Record<string, unknown>
  const assignees = found.assignees
  const blockers = found.blockers
  return {
    ...issue,
    assignees: Array.isArray(assignees)
      ? assignees.filter((login): login is string => typeof login === "string")
      : [],
    blockers: Array.isArray(blockers)
      ? blockers.map(parseIssue).filter((blocker): blocker is ProjectIssue => blocker !== null)
      : [],
  }
}

function parseTasks(value: unknown): ProjectTask[] {
  return Array.isArray(value)
    ? value.map(parseTask).filter((task): task is ProjectTask => task !== null)
    : []
}

/** A project's tasks, read from its repositories' GitHub issues through the Gots plugin. */
export async function getProjectTasks(
  config: HermesConfig,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectTasks> {
  const response = await request(projectPath(config, projectId, "tasks"), {
    headers: headers(config),
    signal,
  })
  const body = (await response.json()) as Record<string, unknown> | null
  // A 200 that carries no list isn't an empty frontier: saying nothing is ready would be a lie
  // about a read that never happened.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HermesError("Hermes answered without a task list.")
  }
  const repos = body.repos
  return {
    repos: Array.isArray(repos)
      ? repos.filter((repo): repo is string => typeof repo === "string")
      : [],
    ready: parseTasks(body.ready),
    claimed: parseTasks(body.claimed),
    blocked: parseTasks(body.blocked),
  }
}

/**
 * A task AFK holds: the issue, the stage the session working it is in, and why nothing is working
 * it. One session a hold, so a project up to its pick count holds several (ADR 0025). Needs plugin
 * 0.80, which made the project's read answer a list.
 */
export interface AfkHold extends ProjectIssue {
  /** The stage that hold's session is in; null for a task running one run, or past its last stage. */
  stage: AfkStage | null
  /** That stage's own name in the workflow's words; null once past the last one. */
  stageName: string | null
  /** Why nothing is working it, when something stopped; null while its session runs. */
  stalled: string | null
}

/**
 * A bot's own AFK numbers — the ones that span its projects rather than sitting on one of them
 * (ADR 0042). Both are read tolerantly: a host from before the route answers none, which is nothing
 * known rather than a failure to read. The bot-level route answers these two alone, and a project's
 * own read answers them too, so one read draws the whole AFK sheet — `ProjectAfk` is these two plus
 * everything that belongs to a project.
 */
export interface BotAfk {
  /** How many tasks it may hold across its projects, 1–10; null where the host answers none. */
  pickBudget: number | null
  /**
   * The share of its account already used at which the bot stops picking tasks up, 50–100; null is
   * Off, which is what a bot that never set one answers (ADR 0026).
   */
  usageThreshold: number | null
  /**
   * How many tasks it holds right now, every project's holds including the stalled ones; null where
   * the host answers no count. The AFK sheet draws it against `pickBudget` — the usage those numbers
   * are about. The bot editor's Coding tab sets the budget and draws the budget alone: what a bot
   * holds is about the runs in flight, not the number being chosen there.
   */
  holdsHeld: number | null
}

/**
 * A project's AFK switch: whether it is left to work its own tasks, and why it can't be. The
 * setting is the host's, so it is the same on every device the project is opened from. Needs
 * plugin 0.50, 0.51 for the task it holds and the last refusal, 0.56 for the skills its work
 * follows, 0.58 for the stage a staged task is in and 0.60 for the Prompt its runs are told.
 */
export interface ProjectAfk extends BotAfk {
  on: boolean
  /** What stops the project being left to work, when something does; null when it can be. */
  reason: string | null
  /** The task AFK has claimed and is working, while it holds one. */
  task: ProjectIssue | null
  /**
   * Every task the project's switch holds, oldest first — one session each, up to its pick count,
   * with the stage that session is in. Null for a host from before picks, which holds at most the
   * one `task` above; the sheet draws a single Working row from it then.
   */
  holds: AfkHold[] | null
  /** How many tasks it may hold at once, 1–5; null where the host answers no pick count. */
  pickCount: number | null
  /** Why GitHub last refused the sweep. The switch stays on, so this is not `reason`. */
  refusal: string | null
  /** The bot's skill the project picked to build by, when it picked one. */
  buildSkill: string | null
  /** The bot's skills the project picked for its critique, in the order it picked them. */
  critiqueSkills: string[]
  /** The stage the task it holds is in, while it is a staged one; null for one run, or none held. */
  stage: AfkStage | null
  /** That stage's own name in the workflow's words ("Migrate", "Verify"); null once past the last. */
  stageName: string | null
  workflow: WorkflowEntry | null
  /**
   * How the project's work is carried out, told to every run it starts: the project's own words,
   * or the bot's default method where it has written none. Empty is that default again, which is
   * why the host answers the default rather than nothing.
   */
  prompt: string
  /**
   * The account library's entry this Prompt was copied from, where it was one — the row tells a
   * copy whose entry has moved on from an original by comparing the two. Null where the host
   * answers none (a plugin from before picks) and where the words are the user's own: a hand edit
   * clears it on the host, so the row never calls them a stale copy (ADR 0043).
   */
  promptId: string | null
}

function parseHold(value: unknown): AfkHold | null {
  const issue = parseIssue(value)
  if (!issue) return null
  const found = (value ?? {}) as Record<string, unknown>
  return {
    ...issue,
    // A host answers each hold's stage the way it answers the one task's: null is one run.
    stage: parseStage(found.stage),
    stageName: str(found.stage_name) || null,
    stalled: str(found.stalled) || null,
  }
}

function parseHolds(value: unknown): AfkHold[] | null {
  // A plugin from before the pick count answers none, and one that holds nothing answers an empty
  // list: the first reads as the sheet it always drew, the second as nothing to draw.
  if (!Array.isArray(value)) return null
  return value.map(parseHold).filter((hold): hold is AfkHold => hold !== null)
}

function parseWhole(value: unknown): number | null {
  // Absent where the plugin predates the field; a whole number is the host's own rule, so a shape
  // this app can't read is nothing answered rather than a reason to fail the whole read.
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

function parseAfk(body: Record<string, unknown> | null): ProjectAfk {
  // A read that answers without the setting isn't off: showing a switch that says so would be a
  // guess about a project nothing answered for.
  if (!body || typeof body.on !== "boolean") {
    throw new HermesError("Hermes answered without AFK's setting.")
  }
  // A plugin from before the sweep answers neither the task nor the refusal, and one from before the
  // pickers answers no skills: that's nothing chosen, not a failure to read the switch.
  return {
    on: body.on,
    reason: str(body.reason) || null,
    task: parseIssue(body.task),
    holds: parseHolds(body.holds),
    pickCount: parseWhole(body.pick_count),
    // And the bot's own numbers, which a project's read answers so one read draws the sheet: the same
    // two fields the bot-level route carries, parsed once (`parseBotAfk`).
    ...parseBotAfk(body),
    refusal: str(body.refusal) || null,
    buildSkill: str(body.build_skill) || null,
    critiqueSkills: skillNames(body.critique_skills),
    // A plugin from before the stages answers none: that task is one run, which is what it does.
    stage: parseStage(body.stage),
    stageName: str(body.stage_name) || null,
    // And one from before the workflows answers none: the project runs what it always ran.
    workflow: parseWorkflowEntry(body.workflow),
    // A plugin from before the Prompt answers none, which is only read where the host advertises it.
    prompt: str(body.prompt),
    // And one from before the library answers no source: the words stand as the user's own.
    promptId: str(body.prompt_id) || null,
  }
}

function projectPath(config: HermesConfig, projectId: string, route: "tasks" | "afk") {
  return `${pluginRoot(config.baseUrl)}/projects/${encodeURIComponent(projectId)}/${route}`
}

/** A project's AFK switch, read from its host. */
export async function getProjectAfk(
  config: HermesConfig,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectAfk> {
  const response = await request(projectPath(config, projectId, "afk"), {
    headers: headers(config),
    signal,
  })
  return parseAfk((await response.json()) as Record<string, unknown> | null)
}

async function writeAfk(
  config: HermesConfig,
  projectId: string,
  body: Record<string, unknown>,
): Promise<ProjectAfk> {
  const response = await request(projectPath(config, projectId, "afk"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return parseAfk((await response.json()) as Record<string, unknown> | null)
}

/** Turns a project's AFK on or off on its host, answering the setting it now holds. */
export function setProjectAfk(
  config: HermesConfig,
  projectId: string,
  on: boolean,
): Promise<ProjectAfk> {
  return writeAfk(config, projectId, { on })
}

/**
 * Keeps the skills a project's AFK work follows — one to build by and the ones to critique — on its
 * host, answering the setting it now holds. The two are written together: a write naming one would
 * leave the other's meaning to a guess.
 */
export function setProjectAfkSkills(
  config: HermesConfig,
  projectId: string,
  buildSkill: string | null,
  critiqueSkills: string[],
): Promise<ProjectAfk> {
  return writeAfk(config, projectId, {
    build_skill: buildSkill,
    critique_skills: critiqueSkills,
  })
}

/**
 * Puts a project's AFK work under a workflow from the library, answering the setting it now holds.
 * A workflow id the host has no row for is refused there, and the answer is the setting it kept.
 */
export function setProjectAfkWorkflow(
  config: HermesConfig,
  projectId: string,
  workflowId: string | null,
): Promise<ProjectAfk> {
  return writeAfk(config, projectId, { workflow_id: workflowId })
}

/**
 * A Prompt as it is written: its words, and where they were copied from where they were a library
 * entry's. One shape through the editor, the sheet and the route, so a pick and a hand edit differ
 * in a field rather than in an argument's place — and there is one spelling of "no source", which is
 * the field absent.
 */
export interface PromptWrite {
  text: string
  /**
   * The account library's entry the words were copied from, where they were one: a pick writes the
   * text and its source together, so the row can tell a copy whose entry has moved on. Absent on a
   * hand edit, which the host reads as a plain write and answers by clearing the source the project
   * held — how a hand edit detaches the copy (ADR 0043).
   */
  source?: string
}

/**
 * Writes how a project's AFK work is carried out — its Prompt — on its host, answering the setting
 * it now holds. An empty one is the bot's default again, and the answer carries those words, since
 * that is what the project's next run is told.
 */
export function setProjectAfkPrompt(
  config: HermesConfig,
  projectId: string,
  draft: PromptWrite,
): Promise<ProjectAfk> {
  return writeAfk(config, projectId, {
    prompt: draft.text,
    ...(draft.source && { prompt_id: draft.source }),
  })
}

/**
 * How many tasks a project's switch may hold at once, 1–5, on its host: one write of its own, since
 * a count is a shape the host refuses beside another (afk.py's `write_from`). A count out of range is
 * refused there and nothing is written, so the answer is the count the project still holds.
 */
export function setProjectAfkPickCount(
  config: HermesConfig,
  projectId: string,
  pickCount: number,
): Promise<ProjectAfk> {
  return writeAfk(config, projectId, { pick_count: pickCount })
}

function botAfkPath(config: HermesConfig) {
  return `${pluginRoot(config.baseUrl)}/afk`
}

/**
 * `BotAfk`'s two numbers, off whichever read carried them: the bot-level route answers these alone,
 * and a project's read answers them beside its own fields, so both reads parse them here.
 */
function parseBotAfk(body: Record<string, unknown> | null): BotAfk {
  return {
    pickBudget: parseWhole(body?.pick_budget),
    usageThreshold: parseWhole(body?.usage_threshold),
    holdsHeld: parseWhole(body?.holds_held),
  }
}

/** A bot's own AFK numbers, read from its host: its pick budget, its usage threshold, its holds. */
export async function getBotAfk(config: HermesConfig, signal?: AbortSignal): Promise<BotAfk> {
  const response = await request(botAfkPath(config), { headers: headers(config), signal })
  return parseBotAfk((await response.json()) as Record<string, unknown> | null)
}

/**
 * How many tasks a bot may hold across its projects at once, 1–10, on its host: one write of its own
 * through the bot-level route, since a bot has no project to name. A count out of range is refused
 * there and nothing is written, so the answer is the budget the bot still holds.
 */
export async function setBotAfkPickBudget(
  config: HermesConfig,
  pickBudget: number,
): Promise<BotAfk> {
  return writeBotAfk(config, { pick_budget: pickBudget })
}

/**
 * The share of its account the bot stops picking up at, 50–100, or null for Off: the same
 * bot-level route, naming the threshold alone. Off is a write like any other — the row's own first
 * segment — and a value the host refuses leaves what it already held (ADR 0026).
 */
export async function setBotAfkUsageThreshold(
  config: HermesConfig,
  threshold: number | null,
): Promise<BotAfk> {
  return writeBotAfk(config, { usage_threshold: threshold })
}

async function writeBotAfk(config: HermesConfig, body: Record<string, unknown>): Promise<BotAfk> {
  const response = await request(botAfkPath(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return parseBotAfk((await response.json()) as Record<string, unknown> | null)
}

function workflowPath(config: HermesConfig, rest = ""): string {
  return `${pluginRoot(config.baseUrl)}/workflows${rest}`
}

export async function listWorkflows(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<WorkflowEntry[]> {
  const response = await request(workflowPath(config), { headers: headers(config), signal })
  const body = (await response.json()) as Record<string, unknown> | null
  return parseWorkflowLibrary(body?.workflows)
}

/**
 * Writes a workflow to the library, answering the library as it now stands: a create adds a row, an
 * update forks a preset into a copy and rewrites one of the account's own, and a delete takes one
 * away. Writes answer the whole list, so the screen that asked draws what the host holds.
 */
async function writeWorkflow(
  config: HermesConfig,
  method: "POST" | "DELETE",
  rest: string,
  body?: Record<string, unknown>,
): Promise<WorkflowEntry[]> {
  const response = await request(workflowPath(config, rest), {
    method,
    headers: headers(config),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  const answer = (await response.json()) as Record<string, unknown> | null
  return parseWorkflowLibrary(answer?.workflows)
}

export function createWorkflow(config: HermesConfig, workflow: Workflow): Promise<WorkflowEntry[]> {
  return writeWorkflow(config, "POST", "", { ...workflow })
}

export function updateWorkflow(
  config: HermesConfig,
  id: string,
  workflow: Workflow,
): Promise<WorkflowEntry[]> {
  return writeWorkflow(config, "POST", `/${encodeURIComponent(id)}`, { ...workflow })
}

export function deleteWorkflow(config: HermesConfig, id: string): Promise<WorkflowEntry[]> {
  return writeWorkflow(config, "DELETE", `/${encodeURIComponent(id)}`)
}

export type LiveRunStatus = "running" | "waiting_for_approval"

/** Why a session waits on the user. */
export type WaitingReason =
  | { kind: "question"; count: number }
  | { kind: "approval"; command?: string }
  | { kind: "plan" }
  /** An AFK session nothing is working: its run failed, or a restart adopted it. Its reason is the
   * host's own words. */
  | { kind: "stalled"; reason: string }

/** What a server's plugin reports of its runs, by Hermes session id. */
export interface LiveRuns {
  /** Sessions with a run in flight. */
  sessions: Record<string, LiveRunStatus>
  /** Each one's run (plugin 0.12). */
  runIds: Record<string, string>
  /** Why a session waits on the user, with its project's name for a project session (0.16). */
  waiting: Record<string, WaitingReason & { project?: string }>
  /** How many subagents each session still runs (0.79). */
  subagents: Record<string, number>
  /** How many finished subagents each session's wake turn is still owed (0.83). */
  waking: Record<string, number>
}

/** The server's runs in flight and what waits on the user. Needs the Gots plugin. */
export async function getLiveRuns(config: HermesConfig, signal?: AbortSignal): Promise<LiveRuns> {
  const response = await request(`${pluginRoot(config.baseUrl)}/runs/live`, {
    headers: headers(config),
    signal,
  })
  const body = await response.json()
  const object = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const sessions = Object.fromEntries(
    Object.entries(object(body?.sessions)).filter(
      (entry): entry is [string, LiveRunStatus] =>
        entry[1] === "running" || entry[1] === "waiting_for_approval",
    ),
  )
  const runIds = Object.fromEntries(
    Object.entries(object(body?.run_ids)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
  const waiting: LiveRuns["waiting"] = {}
  for (const [id, value] of Object.entries(object(body?.waiting))) {
    const raw = object(value)
    const project = typeof raw.project === "string" ? raw.project : undefined
    if (raw.kind === "question")
      waiting[id] = {
        kind: "question",
        count: typeof raw.count === "number" ? raw.count : 1,
        project,
      }
    else if (raw.kind === "approval")
      waiting[id] = {
        kind: "approval",
        command: typeof raw.command === "string" ? raw.command : undefined,
        project,
      }
    else if (raw.kind === "plan") waiting[id] = { kind: "plan", project }
    else if (raw.kind === "stalled")
      waiting[id] = {
        kind: "stalled",
        reason: typeof raw.reason === "string" ? raw.reason : "AFK stopped.",
        project,
      }
  }
  const subagents: Record<string, number> = {}
  for (const [id, count] of Object.entries(object(body?.subagents)))
    if (typeof count === "number" && count > 0) subagents[id] = count
  const waking: Record<string, number> = {}
  for (const [id, count] of Object.entries(object(body?.waking)))
    if (typeof count === "number" && count > 0) waking[id] = count
  return { sessions, runIds, waiting, subagents, waking }
}

/** Answers the agent's questions. Needs the Gots plugin, which serves the clarify tool on runs. */
export async function respondToClarify(
  config: HermesConfig,
  runId: string,
  reply: { clarifyId: string; answers: ClarifyAnswers; outcome: "submitted" | "cancelled" },
) {
  await request(`${pluginRoot(config.baseUrl)}/runs/${encodeURIComponent(runId)}/clarify`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      clarify_id: reply.clarifyId,
      answers: reply.answers,
      outcome: reply.outcome,
    }),
  })
}

const runFeatures = new Map<string, Promise<Record<string, unknown> | null>>()

function features(config: HermesConfig) {
  const key = connectionKey(config)
  let pending = runFeatures.get(key)
  if (!pending) {
    pending = request(endpoint(config.baseUrl, "/capabilities"), { headers: headers(config) })
      .then((response) => response.json())
      .then((body) => (body?.features && typeof body.features === "object" ? body.features : {}))
      .catch(() => null)
    runFeatures.set(key, pending)
    // A failed probe (server down, older version) gets another chance on a later turn.
    void pending.then((found) => found || runFeatures.delete(key))
  }
  return pending
}

/** Whether the server takes `/v1/runs`, which keep going when the client drops off. */
export async function supportsRuns(config: HermesConfig) {
  const found = await features(config)
  return Boolean(found?.run_submission && found?.run_events_sse)
}

/** Whether a running turn takes more from the user (`POST /v1/runs/{id}/steer`). */
export async function supportsSteer(config: HermesConfig) {
  return Boolean((await features(config))?.run_steer)
}

export type RunStatus = "completed" | "failed" | "cancelled" | "interrupted"

export interface RunOutcome {
  status: RunStatus
  output?: string
  error?: string
  usage?: TurnUsage
  /** Events were lost on the way, so `output` should replace what streamed. */
  replaceContent?: boolean
  /** What the user steered with that the agent never read: it finished first. */
  pendingSteer?: string
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
    pendingSteer:
      typeof payload?.pending_steer === "string" && payload.pending_steer.trim()
        ? payload.pending_steer
        : undefined,
  }
}

/**
 * Sent as a run's `instructions`, which Hermes adds to the system prompt. `todo_list` is a deferred
 * tool by default, so without it the agent rarely keeps the list the chat shows. Fixed, so the
 * prompt cache holds across turns. (Plan mode's own line comes from the plugin's workspace.)
 */
const PLAN_HINT =
  "When a task takes three or more steps, plan it first with the todo_list tool (load it through " +
  "tool search if it isn't loaded yet), keep exactly one item in progress, and update the list as " +
  "each step is done."

/**
 * Starts a turn on `/v1/runs`. Unlike a chat completion, Hermes doesn't interrupt a run when its
 * event stream drops, so a phone that sleeps mid-reply can pick it up again.
 */
interface RunOptions {
  /** With a model picked for the chat; without it no model is sent and the host's model runs. */
  model?: string
  /** The pick's other half. The two go together or not at all, as `pickFields` holds. */
  provider?: string
  messages: ChatMessage[]
  sessionId?: string
  /** The plugin's line for a project session: its worktrees and, in plan mode, the plan's shape. */
  workspaceInstructions?: string
}

/** The `POST /v1/runs` body for a turn. */
export function runRequest(config: HermesConfig, options: RunOptions) {
  // Like X-Hermes-Session-Id, a keyed session holds the history, so only the new message goes.
  const keyed = Boolean(options.sessionId && config.apiKey)
  return {
    // A model that wasn't picked is the name Hermes advertises for the profile, which a profile
    // served at /p/<profile> doesn't recognise as its own ("ops is not a valid model ID"), so the
    // host's model runs when the pick names none.
    ...pickFields(options),
    input: keyed ? options.messages.slice(-1) : options.messages,
    instructions: [PLAN_HINT, options.workspaceInstructions].filter(Boolean).join("\n"),
    ...(keyed ? { session_id: options.sessionId } : {}),
  }
}

export async function startRun(
  config: HermesConfig,
  /** `idempotencyKey` makes a retried POST return the run it already started. */
  options: RunOptions & { idempotencyKey: string },
) {
  const response = await request(endpoint(config.baseUrl, "/runs"), {
    method: "POST",
    headers: headers(config, { "Idempotency-Key": options.idempotencyKey }),
    body: JSON.stringify(runRequest(config, options)),
  })
  const body = await response.json()
  if (typeof body?.run_id !== "string") throw new HermesError("Hermes didn't start the run.")
  return body.run_id as string
}

/**
 * Follows a run's events from after `lastSeq` (Hermes replays what it buffered). Resolves with the
 * outcome, or null when Hermes closes the stream before the run ends (a subscriber that fell behind).
 */
/**
 * Hermes writes a keepalive comment every 10s while a run is quiet, so a stream silent for longer
 * than this is dead: a phone that slept, or a proxy or tunnel that dropped the connection without
 * closing it. Nothing else ends such a read.
 */
const RUN_STREAM_IDLE_MS = 30_000

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

  // Hermes v2026.9.24 sends no seq: number the calls here, so each gets its own card.
  let calls = 0
  for await (const { data } of readSse(response.body, RUN_STREAM_IDLE_MS)) {
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
          toolCallId: `${runId}:${typeof payload.seq === "number" ? payload.seq : `t${calls++}`}`,
          status: "running",
        })
        break
      case "tool.completed":
        handlers.onTool?.({
          tool: String(payload.tool ?? "tool"),
          status: payload.error ? "failed" : "completed",
          result: payload.preview ? String(payload.preview) : undefined,
        })
        break
      case "approval.request":
        handlers.onApproval?.(payload as ApprovalRequestEvent)
        break
      case "clarify.request":
        handlers.onClarify?.(payload as ClarifyRequestEvent)
        break
      case "clarify.responded":
        handlers.onClarifyResolved?.(payload as ClarifyRespondedEvent)
        break
      case "approval.responded":
        handlers.onApprovalResolved?.(payload as ApprovalRespondedEvent)
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

/**
 * The run's status; `outcome` is set once it has finished, and `clarify` while the agent waits for
 * an answer (the plugin keeps the question on the status, for a client that can't read the events).
 */
export async function getRun(config: HermesConfig, runId: string, signal?: AbortSignal) {
  const response = await request(endpoint(config.baseUrl, `/runs/${encodeURIComponent(runId)}`), {
    headers: headers(config),
    signal,
  })
  const body = await response.json()
  const pending =
    body?.status === "waiting_for_approval" ? promptEntry(body, "approval") : undefined
  const clarify = body?.clarify
  return {
    status: String(body?.status ?? ""),
    /** When the run started, in the host's Unix seconds. */
    createdAt: typeof body?.created_at === "number" ? body.created_at : undefined,
    /** The approval the run is waiting on; Hermes keeps it on the status for clients that can't read the events. */
    approval: pending
      ? ({ ...pending, run_id: String(pending.run_id ?? runId) } as ApprovalRequestEvent)
      : undefined,
    outcome: TERMINAL_RUN_STATUSES.has(body?.status) ? runOutcome(body) : undefined,
    clarify:
      clarify && typeof clarify === "object" && typeof clarify.clarify_id === "string"
        ? (clarify as ClarifyRequestEvent)
        : undefined,
  }
}

/**
 * Hands the running agent more from the user without stopping it. Hermes adds it as a user message
 * after the current tool calls; one sent while the agent writes its last reply comes back on the
 * finished run as `pending_steer`. A run waiting on an approval or question turns it down (409).
 */
export async function steerRun(config: HermesConfig, runId: string, text: string) {
  await request(endpoint(config.baseUrl, `/runs/${encodeURIComponent(runId)}/steer`), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ input: text }),
  })
}

export async function stopRun(config: HermesConfig, runId: string) {
  await request(endpoint(config.baseUrl, `/runs/${encodeURIComponent(runId)}/stop`), {
    method: "POST",
    headers: headers(config),
  })
}

/** Where a bot's dictation log lives on its Gots plugin (`dictations.py`). */
function dictationRoot(config: HermesConfig, entryId?: string) {
  return pluginPath(config, "dictations", ...(entryId ? [entryId] : []))
}

/**
 * One dictation as a host holds it. `at` is when the words were said, on the device's clock; `seenAt`
 * is when that host heard them, on its own — the log's order and its pages read `seenAt`, so a device
 * whose clock is wrong cannot misplace a take or hide one behind a page (ADR 0060).
 */
export interface HostDictation {
  id: string
  text: string
  /** The words as the host heard them, before Cleanup: absent where this host kept none (ADR 0062). */
  heard?: string
  words: number
  ms: number
  at: number
  seenAt: number
}

/** A host's totals, and the fingerprint a device's mirror is reconciled against. */
export interface HostDictationStats extends Totals, Fingerprint {}

/** A number a host sent, or nothing where it sent something else. */
function finite(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null
}

function dictationRow(value: unknown): HostDictation | null {
  const row = value as Partial<HostDictation> | null
  if (!row || typeof row.id !== "string" || !row.id || typeof row.text !== "string") return null
  const at = finite(row.at) ?? 0
  const heard = heardOf(row.heard)
  return {
    id: row.id,
    text: row.text,
    ...(heard ? { heard } : {}),
    words: finite(row.words) ?? 0,
    ms: finite(row.ms) ?? 0,
    at,
    // A host too old to stamp its own clock ordered its log by `at`, so that is the clock its pages
    // and totals answer on: reading it as `seenAt` keeps one fingerprint working across both.
    seenAt: finite(row.seenAt) ?? at,
  }
}

function dictationTotals(value: unknown): HostDictationStats {
  const row = value as Partial<HostDictationStats> | null
  return {
    words: finite(row?.words) ?? 0,
    ms: finite(row?.ms) ?? 0,
    count: finite(row?.count) ?? 0,
    newest: finite(row?.newest),
    oldest: finite(row?.oldest),
    clearedAt: finite(row?.clearedAt) ?? 0,
  }
}

/**
 * One page of a bot's dictations, newest first. `before` and `beforeId` are the cursor — the last row
 * the caller already has — and both are given because two takes can share a millisecond, which a
 * bound on the time alone would skip.
 */
export async function getDictations(
  config: HermesConfig,
  before: number | null,
  beforeId: string | null,
  limit: number,
  signal?: AbortSignal,
): Promise<HostDictation[]> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (before != null && beforeId) {
    query.set("before", String(before))
    query.set("before_id", beforeId)
  }
  const response = await request(`${dictationRoot(config)}?${query}`, {
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  const body = await response.json()
  const rows: unknown[] = Array.isArray(body?.dictations) ? body.dictations : []
  return rows.map(dictationRow).filter((row): row is HostDictation => row !== null)
}

/** A bot's totals and its fingerprint — one read that serves both the stats card and a reconcile. */
export async function getDictationStats(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<HostDictationStats> {
  const response = await request(`${dictationRoot(config)}/stats`, {
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  return dictationTotals((await response.json())?.stats)
}

/** What a device writes: the row as it knows it, before a host has stamped when it heard it. */
export type DictationWrite = Omit<HostDictation, "seenAt">

/** Writes one dictation; the same id written twice leaves the first where it is. */
export async function postDictation(
  config: HermesConfig,
  entry: DictationWrite,
  signal?: AbortSignal,
): Promise<HostDictation | null> {
  const response = await request(dictationRoot(config), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(entry),
    signal: signal ?? AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return dictationRow((await response.json())?.dictation)
}

export async function deleteDictation(
  config: HermesConfig,
  entryId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await request(dictationRoot(config, entryId), {
    method: "DELETE",
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return (await response.json())?.removed === true
}

/** Takes a bot's whole log away and answers with what its totals are now. */
export async function clearDictations(
  config: HermesConfig,
  signal?: AbortSignal,
): Promise<HostDictationStats> {
  const response = await request(dictationRoot(config), {
    method: "DELETE",
    headers: headers(config),
    signal: signal ?? AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  return dictationTotals((await response.json())?.stats)
}
