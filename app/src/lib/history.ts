import { serverConfig } from "@/lib/connection"
import {
  db,
  getMessages,
  updateConversation,
  type Conversation,
  type Message,
  type ToolEvent,
} from "@/lib/db"
import { refreshQueue } from "@/lib/chat"
import { FOLLOW_UP_MS, JUST_FOLLOWED_UP_MS } from "@/lib/freshness"
import { quietly } from "@/lib/report"
import { refreshContext } from "@/lib/context"
import { refreshChatProviderUsage } from "@/lib/provider-usage"
import { refreshTodos } from "@/lib/todos"
import { refreshLibrary, refreshPrs, refreshWorkspace } from "@/lib/workspace"
import {
  getSessionTitle,
  listSessionMessages,
  type HermesConfig,
  type SessionMessage,
} from "@/lib/hermes"
import { splitAttachments } from "@/lib/attachments"
import { readLiveRuns } from "@/lib/waiting"
import { failureReason, TODO_TOOLS } from "@/lib/tools"

/**
 * Message bodies don't sync; every device's turns live in the chat's Hermes session. Opening a chat
 * catches it up from there, and "Load earlier" pages back.
 */

const PAGE = 50
/** Pages to skip past rows sent since the last load, before giving up on finding older ones. */
const MAX_SKIPS = 10

/** Hermes's main argument per tool (`_PRIMARY_ARGS` in agent/display.py), shown beside its name. */
const PRIMARY_ARGS: Record<string, string> = {
  terminal: "command",
  execute_code: "code",
  browser_exec: "code",
  web_search: "query",
  web_extract: "urls",
  read_file: "path",
  write_file: "path",
  patch: "path",
  search_files: "pattern",
  browser_navigate: "url",
  browser_click: "ref",
  browser_type: "text",
  image_generate: "prompt",
  text_to_speech: "text",
  vision_analyze: "question",
  clarify: "question",
  skill_view: "name",
  skill_manage: "name",
  skills_list: "category",
  cronjob_manage: "action",
  delegate_task: "goal",
}
const FALLBACK_ARGS = ["query", "text", "command", "path", "name", "prompt", "code", "goal"]
const MAX_DETAIL = 4000

const clip = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text)

function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function argsLabel(name: string, args: unknown) {
  if (typeof args === "string") return args.trim()
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const record = args as Record<string, unknown>
  if (!Object.keys(record).length) return ""
  // Like Hermes's preview, so a streamed call and its transcript row read the same.
  if (TODO_TOOLS.has(name))
    return Array.isArray(record.todos)
      ? `${record.todos.length} ${record.todos.length === 1 ? "task" : "tasks"}`
      : ""
  if (name === "clarify" && Array.isArray(record.questions)) {
    const asked = record.questions
      .map((q) =>
        q && typeof q === "object" ? String((q as { question?: unknown }).question ?? "") : "",
      )
      .filter(Boolean)
    if (asked.length) return asked[0]
  }
  const key = PRIMARY_ARGS[name] ?? FALLBACK_ARGS.find((k) => k in record)
  let value = key ? record[key] : undefined
  if (Array.isArray(value)) value = value[0]
  if (value !== undefined && value !== null && value !== "") return String(value).trim()
  return JSON.stringify(record)
}

/** A call's name and label; `tool_call` is Hermes's bridge to deferred tools, named in its args. */
function describeCall(name: string, args: unknown) {
  if (name === "tool_call" && args && typeof args === "object") {
    const record = args as Record<string, unknown>
    const entries = (Array.isArray(record.calls) ? record.calls : [record]).filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    const inner = entries.map((entry) => {
      const innerName = typeof entry.name === "string" && entry.name ? entry.name : "tool"
      const innerArgs = parseArgs(entry.arguments)
      return { name: innerName, label: argsLabel(innerName, innerArgs), args: innerArgs }
    })
    if (inner.length === 1) return inner[0]
    if (inner.length > 1)
      return {
        name,
        label: inner.map((c) => (c.label ? `${c.name}: ${c.label}` : c.name)).join("\n"),
        args: undefined,
      }
  }
  return { name, label: argsLabel(name, args), args }
}

const countLines = (text: string) =>
  text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0

/** A new file's size, from the call's own content: the result only says how many bytes. */
function writeStats(name: string, args: unknown) {
  if (name !== "write_file" || !args || typeof args !== "object") return undefined
  const content = (args as { content?: unknown }).content
  return typeof content === "string" ? { added: countLines(content), removed: 0 } : undefined
}

/** A patch's size and whether it made a file, from the result's unified diff (before it is clipped). */
export function patchStats(result: string) {
  let parsed: { diff?: unknown; files_created?: unknown } | undefined
  try {
    parsed = JSON.parse(result)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed.diff !== "string") return undefined
  let added = 0
  let removed = 0
  for (const line of parsed.diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  const created = Array.isArray(parsed.files_created) && parsed.files_created.length > 0
  return { added, removed, ...(created ? { created } : {}) }
}

function toolCalls(row: SessionMessage) {
  let calls = row.tool_calls
  if (typeof calls === "string") {
    try {
      calls = JSON.parse(calls)
    } catch {
      calls = null
    }
  }
  return Array.isArray(calls)
    ? calls.map((call, i) => {
        const { name, label, args } = describeCall(
          call?.function?.name ?? "tool",
          parseArgs(call?.function?.arguments),
        )
        return {
          id: call?.id ?? `${row.id}-${i}`,
          name,
          label: clip(label) || name,
          stats: writeStats(name, args),
        }
      })
    : []
}

/** A user message Hermes handed the agent mid-turn (a steer); it belongs to the reply. */
const isSteer = (row: SessionMessage) => row.role === "user" && row.display_kind === "steer"

/** A steer's own text, without the marker Hermes wraps it in for the model. */
function steerText(content: string) {
  return content
    .trim()
    .replace(/^\[OUT-OF-BAND USER MESSAGE[^\n]*\]\n?/, "")
    .replace(/\n?\[\/OUT-OF-BAND USER MESSAGE\]$/, "")
    .trim()
}

/**
 * A note Hermes writes as a user row to keep a turn going: after a reply was cut off by the network
 * or the output limit, or ended on a fragment. It's for the model, never the user's.
 */
const isNotice = (row: SessionMessage) =>
  row.role === "user" &&
  typeof row.content === "string" &&
  row.content.trimStart().startsWith("[System:")

/** Hermes's `_MIN_CONTINUATION_OVERLAP`: a shorter repeat at a seam is left alone. */
const MIN_OVERLAP = 32

/** How much of `next` repeats the end of `previous` (`_continuation_overlap_length`). */
function overlapLength(previous: string, next: string) {
  if (previous.length < MIN_OVERLAP || next.length < MIN_OVERLAP) return 0
  for (let length = Math.min(previous.length, next.length); length >= MIN_OVERLAP; length--)
    if (previous.endsWith(next.slice(0, length))) return length
  return 0
}

/**
 * The text a notice's answer leaves: the cut-off text and its continuation joined as Hermes joins
 * them for the run's output (`_join_truncated_parts`), or only the new text when the model started
 * over or was asked to send its answer again.
 */
function afterNotice(fragment: string, next: string, notice: string) {
  const head = fragment.trim().slice(0, 64)
  if (!/where you left off|^\[System: Your previous tool call/.test(notice.trimStart())) return next
  if (head && next.trimStart().startsWith(head)) return next
  // Only a stream that was cut mid-way repeats itself at the seam.
  const part = notice.includes("output length limit")
    ? next
    : next.slice(overlapLength(fragment.slice(-next.length), next))
  const gap = fragment && part && !/\s$/.test(fragment) && !/^\s/.test(part) ? "\n" : ""
  return fragment + gap + part
}

/**
 * Folds each turn's assistant, tool-call and tool rows into one reply, as streaming shows it. With
 * `live` (a turn still running), a call without its result row stays `running`.
 */
export function toMessages(
  conversationId: string,
  sessionId: string,
  rows: SessionMessage[],
  options: { live?: boolean } = {},
) {
  const messages: Message[] = []
  let reply: Message | undefined
  // Where the reply's text since its last tool call starts, and the notice that text was cut by.
  let segment = 0
  let notice: string | undefined
  const newReply = (id: string, createdAt: number) => {
    segment = 0
    notice = undefined
    const message: Message = {
      id,
      conversationId,
      role: "assistant",
      content: "",
      tools: [],
      status: "done",
      createdAt,
    }
    messages.push(message)
    return message
  }
  for (const row of rows) {
    if (row.display_kind === "hidden" || row.role === "system") continue
    if (isNotice(row)) {
      if (reply) notice = row.content ?? ""
      continue
    }
    const createdAt = Math.round((row.timestamp ?? 0) * 1000) || Date.now()
    const id = `h-${sessionId}-${row.id}`
    if (isSteer(row)) {
      reply ??= newReply(id, createdAt)
      reply.steers = [
        ...(reply.steers ?? []),
        {
          id,
          text: steerText(row.content ?? ""),
          contentOffset: reply.content.length,
          at: createdAt,
        },
      ]
      continue
    }
    if (row.role === "user") {
      reply = undefined
      const { text, attachments } = splitAttachments(row.content ?? "")
      messages.push({
        id,
        conversationId,
        role: "user",
        content: text,
        ...(attachments.length ? { attachments } : {}),
        status: "done",
        createdAt,
        hermesRowId: row.id,
      })
      continue
    }
    reply ??= newReply(id, createdAt)
    if (row.role === "tool") {
      // Match the result to the first unresolved call with this ID. A duplicate
      // call ID (server-side assembly issue) creates two tool events; finding the
      // first running one ensures each attempt gets its own result and the later
      // empty-argument failure doesn't overwrite the earlier successful output.
      const tool = reply.tools?.find(
        (t) => t.toolCallId === row.tool_call_id && t.status === "running",
      )
      if (tool) {
        tool.status = "completed"
        tool.endedAt = createdAt
        if (row.content) {
          tool.result = clip(row.content)
          if (tool.tool === "patch") Object.assign(tool, patchStats(row.content))
          // Hermes doesn't store whether a call failed; its result says, as Hermes itself reads it.
          const error = failureReason(tool.tool, row.content)
          if (error) Object.assign(tool, { status: "failed", error })
        }
      }
      continue
    }
    const reasoning = row.reasoning ?? row.reasoning_content
    if (reasoning)
      reply.reasoning = reply.reasoning ? `${reply.reasoning}\n\n${reasoning}` : reasoning
    if (row.display_kind === "failed_turn") {
      reply.status = "error"
      reply.statusText = row.content || "Hermes couldn't finish this reply."
    } else if (row.content) {
      const before = reply.content.slice(0, segment)
      const fragment = reply.content.slice(segment).replace(/^\n\n/, "")
      const text = notice && fragment ? afterNotice(fragment, row.content, notice) : undefined
      if (text !== undefined) reply.content = before ? `${before}\n\n${text}` : text
      else reply.content = reply.content ? `${reply.content}\n\n${row.content}` : row.content
    }
    const calls = toolCalls(row)
    if (row.content || calls.length) notice = undefined
    for (const call of calls) {
      const event: ToolEvent = {
        toolCallId: call.id,
        tool: call.name,
        label: call.label,
        status: "running",
        startedAt: createdAt,
        contentOffset: reply.content.length,
        ...call.stats,
        ...(call.stats ? { created: true } : {}),
      }
      reply.tools = [...(reply.tools ?? []), event]
      segment = reply.content.length
    }
  }
  if (!options.live) {
    // A finished turn: a call whose result row is missing still ended.
    for (const m of messages)
      for (const t of m.tools ?? [])
        if (t.status === "running") Object.assign(t, { status: "completed", endedAt: t.startedAt })
  }
  return messages.filter(
    (m) => m.role === "user" || m.content || m.tools?.length || m.status === "error",
  )
}

/** A streamed call's preview, which Hermes cuts at 500 characters ("..." marks the cut). */
const isPreview = (tool: ToolEvent) =>
  tool.result !== undefined && tool.result.length >= 500 && tool.result.endsWith("...")

function withTranscriptToolOffsets(local: Message, transcript: Message) {
  const tools = transcript.tools ?? []
  if (!tools.length || local.content === transcript.content) return tools
  const segments: string[] = []
  let from = 0
  for (const tool of tools) {
    const offset = Math.max(from, Math.min(transcript.content.length, tool.contentOffset ?? from))
    segments.push(transcript.content.slice(from, offset))
    from = offset
  }
  segments.push(transcript.content.slice(from))

  const locations: Array<{ start: number; end: number } | undefined> = []
  let searchFrom = 0
  for (const segment of segments) {
    const text = segment.trim()
    if (!text) {
      locations.push(undefined)
      continue
    }
    const start = local.content.indexOf(text, searchFrom)
    if (start < 0) locations.push(undefined)
    else {
      const end = start + text.length
      locations.push({ start, end })
      searchFrom = end
    }
  }

  return tools.map((tool, index) => {
    if (tool.contentOffset === undefined) return tool
    // Match the text immediately around the call in order; if only one side survives the rewrite,
    // anchor there. If neither does, use the reply start rather than inventing a scaled position.
    const before = locations[index]
    let after = locations[index + 1]
    for (let next = index + 2; !after && next < locations.length; next++) after = locations[next]
    const contentOffset = before?.end ?? after?.start ?? 0
    return { ...tool, contentOffset }
  })
}

/**
 * What streamed calls only learn from the transcript: their edits' size, and the whole result
 * where the stream sent a cut preview. Matched by tool and label, in order.
 */
function withTranscriptDetails(local: ToolEvent[], fromHermes: ToolEvent[]) {
  const spare = [...fromHermes]
  let changed = false
  const tools = local.map((tool) => {
    // A todo call's streamed label is Hermes's preview, worded unlike the transcript's.
    const i = spare.findIndex(
      (t) => t.tool === tool.tool && (t.label === tool.label || TODO_TOOLS.has(t.tool)),
    )
    if (i < 0) return tool
    const [found] = spare.splice(i, 1)
    const needsStats = tool.added === undefined
    // A question's result is written here when it's answered, whole.
    const needsResult = isPreview(tool) && tool.tool !== "clarify"
    if (!needsStats && !needsResult) return tool
    const next = { ...tool }
    if (needsStats && found.added !== undefined)
      Object.assign(next, { added: found.added, removed: found.removed, created: found.created })
    if (needsResult && found.result) {
      next.result = found.result
      if (found.error) next.error = found.error
    }
    if (next.added === tool.added && next.result === tool.result) return tool
    changed = true
    return next
  })
  return changed ? tools : undefined
}

/**
 * The reply so far of the running turn that `userContent` started, from the transcript Hermes
 * writes after every tool round. For a client that can't read the run's events.
 */
export async function liveTurn(
  config: HermesConfig,
  sessionId: string,
  userContent: string,
  signal?: AbortSignal,
) {
  const rows = new Map<number, SessionMessage>()
  for (let page = 0; page <= MAX_SKIPS; page++) {
    const batch = await listSessionMessages(config, sessionId, {
      limit: PAGE,
      offset: page * PAGE,
      signal,
    })
    for (const row of batch) rows.set(row.id, row)
    const sorted = [...rows.values()].sort((a, b) => a.id - b.id)
    // The row carries the attachments' lines after the text the user typed.
    const start = sorted.findLastIndex(
      (row) => isTurnStart(row) && splitAttachments(row.content ?? "").text === userContent,
    )
    if (start >= 0)
      return toMessages("", sessionId, sorted.slice(start), { live: true }).find(
        (m) => m.role === "assistant",
      )
    if (batch.length < PAGE) return undefined
  }
  return undefined
}

async function connection(conversation: Conversation) {
  const profile = await db.profiles.get(conversation.profileId)
  // Hermes only keys a session by our id when a key is sent, so keyless chats have nothing to load.
  return profile?.apiKey ? serverConfig(profile) : undefined
}

const reconciling = new Map<string, Promise<number>>()

/**
 * Pulls Hermes's auto-generated session title into the chat, the same way `syncTitle` in
 * `chat.ts` does after a local turn. A long-running turn (a code session) may finish on
 * Hermes after the app closed; without this, the first-line slice stays forever.
 */
async function refreshTitle(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation || conversation.titleEdited) return
  const config = await connection(conversation)
  if (!config) return
  const title = await getSessionTitle(config, conversation.hermesSessionId)
  if (title && title !== conversation.title) await updateConversation(conversationId, { title })
}

const followedUp = new Map<string, number>()
const caughtUp = new Map<string, number>()

/** A turn that just ended read the chat's context and todos itself. */
export function noteFollowUps(conversationId: string) {
  followedUp.set(conversationId, Date.now())
}

/** Whether the chat caught up with its transcript within `ms`. */
export const caughtUpWithin = (conversationId: string, ms: number) =>
  Date.now() - (caughtUp.get(conversationId) ?? -Infinity) < ms

/**
 * The reads that follow a catch-up: the title, context use, the provider's limits, todos, and a
 * session's workspace and pull requests. They run when the transcript moved or the server said the
 * session changed (a mode or a plan moves without a row), the first time, and otherwise every
 * `FOLLOW_UP_MS`, not on every catch-up of an idle chat. A turn that ended just now read them.
 */
function followUps(conversationId: string, moved: boolean) {
  const since = Date.now() - (followedUp.get(conversationId) ?? -Infinity)
  if (since < JUST_FOLLOWED_UP_MS || (!moved && since < FOLLOW_UP_MS)) return
  followedUp.set(conversationId, Date.now())
  void Promise.all([
    refreshTitle(conversationId),
    refreshContext(conversationId),
    refreshChatProviderUsage(conversationId),
    refreshTodos(conversationId),
    refreshWorkspace(conversationId),
    refreshLibrary(conversationId),
    refreshPrs(conversationId),
  ]).catch(quietly("Reading a chat's details"))
}

/**
 * Catches a chat up with its transcript on Hermes, which holds every device's turns. An empty chat
 * gets the newest page; otherwise only turns newer than the last one seen arrive. Turns streamed on
 * this device are kept as they are (they carry stats and approvals Hermes doesn't store) and only
 * matched to their rows. Resolves to how many messages arrived, without waiting for the follow-up
 * reads, so a send waits on the transcript alone.
 */
export function reconcileHistory(conversationId: string, { changed = false } = {}) {
  let pending = reconciling.get(conversationId)
  if (!pending) {
    const tip = () => db.conversations.get(conversationId).then((c) => c?.hermesTip)
    // The queue first: a turn the plugin started from it is followed live, not loaded half done.
    pending = Promise.all([tip(), refreshQueue(conversationId)])
      .then(async ([before]) => {
        const added = await reconcile(conversationId)
        if (added === null) return 0
        caughtUp.set(conversationId, Date.now())
        followUps(conversationId, changed || added > 0 || (await tip()) !== before)
        return added
      })
      .finally(() => reconciling.delete(conversationId))
    reconciling.set(conversationId, pending)
  }
  return pending
}

const isTurnStart = (row: SessionMessage) =>
  row.role === "user" && row.display_kind !== "hidden" && !isSteer(row) && !isNotice(row)

const isStreaming = (messages: Message[]) => messages.some((m) => m.status === "streaming")

/** A user message's transcript row; rows loaded before matching existed carry it in their id. */
function rowIdOf(message: Message, sessionId: string) {
  if (message.hermesRowId !== undefined) return message.hermesRowId
  const prefix = `h-${sessionId}-`
  return message.id.startsWith(prefix) ? Number(message.id.slice(prefix.length)) : undefined
}

const byRowId = (rows: Map<number, SessionMessage>) =>
  [...rows.values()].sort((a, b) => a.id - b.id)

/** Whether a chat shows anything for a row: hidden and system rows aren't worth a "Load earlier". */
const isShown = (row: SessionMessage) => row.display_kind !== "hidden" && row.role !== "system"

/**
 * The rows from the start of the turn holding `tip` to the newest, or for an empty chat the newest
 * whole turns: a reply is named after its first row, so one cut by the page edge would load again,
 * whole and under another id, once its start was read, and show twice.
 */
async function fetchTail(config: HermesConfig, sessionId: string, tip?: number) {
  const rows = new Map<number, SessionMessage>()
  for (let page = 0; page <= MAX_SKIPS; page++) {
    const batch = await listSessionMessages(config, sessionId, { limit: PAGE, offset: page * PAGE })
    for (const row of batch) rows.set(row.id, row)
    const sorted = byRowId(rows)
    const start =
      tip === undefined
        ? sorted.findIndex(isTurnStart)
        : sorted.findLastIndex((row) => row.id <= tip && isTurnStart(row))
    const end = batch.length < PAGE
    if (start >= 0 || end) {
      const from = Math.max(start, 0)
      const full = tip === undefined && (!end || sorted.slice(0, from).some(isShown))
      return { rows: sorted.slice(from), full }
    }
  }
  return { rows: byRowId(rows), full: tip === undefined }
}

/** With `liveTail`, the last turn is still running: its calls without a result are still at work. */
function turnsOf(
  conversationId: string,
  sessionId: string,
  rows: SessionMessage[],
  liveTail = false,
) {
  const groups: SessionMessage[][] = []
  for (const row of rows) {
    if (isTurnStart(row) || !groups.length) groups.push([row])
    else groups[groups.length - 1].push(row)
  }
  return groups.map((group, i) => {
    const live = liveTail && i === groups.length - 1
    const messages = toMessages(conversationId, sessionId, group, { live })
    return {
      user: messages.find((m) => m.role === "user"),
      reply: messages.find((m) => m.role === "assistant"),
      rows: { first: group[0].id, last: group[group.length - 1].id },
    }
  })
}

/** The transcript row a reply loaded from Hermes is named after. */
function replyRowOf(message: Message, sessionId: string) {
  const prefix = `h-${sessionId}-`
  if (message.role !== "assistant" || !message.id.startsWith(prefix)) return undefined
  const id = Number(message.id.slice(prefix.length))
  return Number.isInteger(id) ? id : undefined
}

/**
 * Replies loaded from Hermes for rows `first` to `last`, other than `keep`: a turn's part loaded on
 * its own when a page edge cut it, which the whole turn replaces. A streaming one is left alone.
 */
function partsOf(
  current: Message[],
  sessionId: string,
  rows: { first: number; last: number },
  keep?: string,
) {
  return current
    .filter((m) => {
      const row = replyRowOf(m, sessionId)
      return (
        row !== undefined &&
        row >= rows.first &&
        row <= rows.last &&
        m.id !== keep &&
        m.status !== "streaming"
      )
    })
    .map((m) => m.id)
}

/**
 * Keeps older messages before `ceiling` (the chat's first message), in their order: their times are
 * the host's clock and the chat's may be this device's.
 */
function placeBefore(messages: Message[], ceiling?: number) {
  if (ceiling === undefined) return messages
  for (let i = messages.length - 1; i >= 0; i--) {
    messages[i].createdAt = Math.min(messages[i].createdAt, ceiling - 1)
    ceiling = messages[i].createdAt
  }
  return messages
}

/** Whether the transcript ends on calls whose results aren't in: still at work, or never ended. */
function awaitingResults(rows: SessionMessage[]) {
  const last = rows.findLast(isShown)
  return Boolean(last?.role === "assistant" && toolCalls(last).length)
}

/**
 * Whether the host still runs the session, so a question or command the last turn waits on reads
 * as waiting, not as never answered, until the run is followed. Asked fresh: a chat opened from a
 * notification has heard nothing yet. Needs the plugin.
 */
async function runningOnHost(config: HermesConfig, sessionId: string) {
  if (!config.apiKey) return false
  return Boolean((await readLiveRuns(config))?.runIds[sessionId])
}

async function reconcile(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return 0
  const config = await connection(conversation)
  if (!config) return 0
  const local = await getMessages(conversationId)
  // The streaming reply catches up when it ends.
  if (isStreaming(local)) return null
  const sessionId = conversation.hermesSessionId
  const tip = local.length ? conversation.hermesTip : undefined
  if (tip !== undefined) {
    const [newest] = await listSessionMessages(config, sessionId, { limit: 1, offset: 0 })
    if (!newest || newest.id === tip) return 0
  }
  const { rows, full } = await fetchTail(config, sessionId, tip)
  if (!rows.length) return 0
  const live = awaitingResults(rows) && (await runningOnHost(config, sessionId))
  const turns = turnsOf(conversationId, sessionId, rows, live)
  return await db.transaction("rw", db.messages, db.conversations, async () => {
    const current = await getMessages(conversationId)
    if (isStreaming(current)) return null
    const byId = new Map(current.map((m) => [m.id, m]))
    const known = new Map<number, Message>()
    for (const m of current) {
      const rowId = m.role === "user" ? rowIdOf(m, sessionId) : undefined
      if (rowId !== undefined) known.set(rowId, m)
    }
    const unmatched = current.filter(
      (m) => m.role === "user" && m.status === "done" && rowIdOf(m, sessionId) === undefined,
    )
    let next = 0
    // Inserted turns sort after what precedes them on Hermes, whatever this device's clock says.
    let floor = 0
    const turnEnd = (user: Message) => {
      let end = current.indexOf(user)
      while (current[end + 1] && current[end + 1].role !== "user") end++
      return current[end].createdAt + 1
    }
    const writes: Message[] = []
    const parts: string[] = []
    for (const { user, reply, rows: range } of turns) {
      if (!user) {
        // A turn longer than every page fetchTail reads: only an empty chat shows its tail.
        if (!current.length && reply) writes.push(reply)
        continue
      }
      parts.push(...partsOf(current, sessionId, range, reply?.id))
      const seen = known.get(user.hermesRowId!)
      if (seen) {
        floor = turnEnd(seen)
        if (seen.id === user.id && reply) {
          // A turn loaded from Hermes earlier, possibly before it finished: refresh its reply.
          const createdAt = byId.get(reply.id)?.createdAt ?? Math.max(reply.createdAt, floor)
          writes.push({ ...reply, createdAt })
          floor = createdAt + 1
        }
        continue
      }
      const match = unmatched.findIndex((m, i) => i >= next && m.content === user.content)
      if (match >= 0) {
        next = match + 1
        writes.push({ ...unmatched[match], hermesRowId: user.hermesRowId })
        floor = turnEnd(unmatched[match])
        // A turn streamed here without its events has no tool calls; the transcript's fill it in.
        const local = current[current.indexOf(unmatched[match]) + 1]
        if (local?.role === "assistant" && !local.tools?.length && reply?.tools?.length) {
          const content =
            local.content.trim() && reply.content.trimEnd().endsWith(local.content.trim())
              ? reply.content
              : local.content
          const restored = { ...local, content }
          writes.push({
            ...restored,
            tools: withTranscriptToolOffsets(restored, reply),
            reasoning: local.reasoning ?? reply.reasoning,
            steers: local.steers ?? reply.steers,
          })
        } else if (local?.role === "assistant" && local.tools?.length && reply?.tools?.length) {
          const tools = withTranscriptDetails(local.tools, reply.tools)
          if (tools) writes.push({ ...local, tools })
        }
        continue
      }
      user.createdAt = Math.max(user.createdAt, floor)
      writes.push(user)
      floor = user.createdAt + 1
      if (reply) {
        reply.createdAt = Math.max(reply.createdAt, floor)
        writes.push(reply)
        floor = reply.createdAt + 1
      }
    }
    await db.messages.bulkDelete(parts)
    await db.messages.bulkPut(writes)
    await db.conversations.update(conversationId, {
      hermesTip: rows[rows.length - 1].id,
      ...(current.length
        ? {}
        : { olderThan: full ? { id: rows[0].id, offset: rows.length } : undefined }),
    })
    return writes.filter((m) => !byId.has(m.id)).length
  })
}

const loadingEarlier = new Map<string, Promise<void>>()

/**
 * Loads the whole turns before the oldest row loaded so far, placed before the chat's first message.
 * A chat opened before turns were loaded whole may start with a reply whose start was cut off by
 * the page edge: that turn is loaded again, whole, in its place.
 */
export function loadEarlierHistory(conversationId: string) {
  let pending = loadingEarlier.get(conversationId)
  if (!pending) {
    // After a catch-up under way, which may be setting where the chat's history starts: a tap while
    // it runs isn't lost.
    pending = Promise.resolve(reconciling.get(conversationId))
      .catch(() => undefined)
      .then(() => loadEarlier(conversationId))
      .finally(() => loadingEarlier.delete(conversationId))
    loadingEarlier.set(conversationId, pending)
  }
  return pending
}

async function loadEarlier(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  const olderThan = conversation?.olderThan
  if (!conversation || !olderThan) return
  const config = await connection(conversation)
  if (!config) return
  const sessionId = conversation.hermesSessionId
  const list = (offset: number) => listSessionMessages(config, sessionId, { limit: PAGE, offset })
  // Turns sent since the last load push older rows further from the newest end; skip past them,
  // then page back to the start of the oldest turn.
  const rows = new Map<number, SessionMessage>()
  let offset = olderThan.offset
  let found: number | undefined
  let end = false
  for (let page = 0; page <= 2 * MAX_SKIPS; page++) {
    const batch = await list(offset)
    for (const row of batch) if (row.id < olderThan.id) rows.set(row.id, row)
    if (rows.size) found ??= offset
    offset += batch.length
    end = batch.length < PAGE
    if (end || byRowId(rows).some(isTurnStart)) break
  }
  const sorted = byRowId(rows)
  const from = Math.max(sorted.findIndex(isTurnStart), 0)
  const older = sorted.slice(from)
  const local = await getMessages(conversationId)
  const cut = local[0] && replyRowOf(local[0], sessionId) === olderThan.id ? local[0] : undefined
  const rest =
    cut && cut.status !== "streaming" ? await turnFrom(olderThan.id, (found ?? offset) + PAGE) : []
  const messages = toMessages(conversationId, sessionId, [...older, ...rest])
  const ceiling = (cut && rest.length ? local[1] : local[0])?.createdAt
  await db.transaction("rw", db.messages, db.conversations, async () => {
    if (cut && rest.length) await db.messages.delete(cut.id)
    await db.messages.bulkPut(placeBefore(messages, ceiling))
    await db.conversations.update(conversationId, {
      olderThan:
        older.length && (!end || sorted.slice(0, from).some(isShown))
          ? { id: older[0].id, offset: offset - from }
          : undefined,
    })
  })

  /** The rows from `first` to the next turn's start, paging towards the newest before `offset`. */
  async function turnFrom(first: number, offset: number) {
    const rows = new Map<number, SessionMessage>()
    for (let page = 0; page <= MAX_SKIPS && offset > 0; page++) {
      offset = Math.max(0, offset - PAGE)
      for (const row of await list(offset)) if (row.id >= first) rows.set(row.id, row)
      if (byRowId(rows).some((row) => row.id > first && isTurnStart(row))) break
    }
    const sorted = byRowId(rows)
    const next = sorted.findIndex((row) => row.id > first && isTurnStart(row))
    return next < 0 ? sorted : sorted.slice(0, next)
  }
}
