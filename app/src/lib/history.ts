import {
  db,
  getMessages,
  updateConversation,
  type Conversation,
  type Message,
  type ToolEvent,
} from "@/lib/db"
import { refreshQueue } from "@/lib/chat"
import { refreshContext } from "@/lib/context"
import { refreshTodos } from "@/lib/todos"
import { refreshPrs, refreshWorkspace } from "@/lib/workspace"
import {
  getSessionTitle,
  listSessionMessages,
  type HermesConfig,
  type SessionMessage,
} from "@/lib/hermes"
import { splitAttachments } from "@/lib/attachments"
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
    const start = sorted.findLastIndex((row) => isTurnStart(row) && row.content === userContent)
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
  return profile?.apiKey ? { baseUrl: profile.baseUrl, apiKey: profile.apiKey } : undefined
}

const loading = new Set<string>()

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

/**
 * Catches a chat up with its transcript on Hermes, which holds every device's turns. An empty chat
 * gets the newest page; otherwise only turns newer than the last one seen arrive. Turns streamed on
 * this device are kept as they are (they carry stats and approvals Hermes doesn't store) and only
 * matched to their rows. Resolves to how many messages arrived.
 */
export function reconcileHistory(conversationId: string) {
  let pending = reconciling.get(conversationId)
  if (!pending) {
    // The queue first: a turn the plugin started from it is followed live, not loaded half done.
    pending = refreshQueue(conversationId)
      .then(() => reconcile(conversationId))
      .then(async (added) => {
        await Promise.all([
          refreshTitle(conversationId),
          refreshContext(conversationId),
          refreshTodos(conversationId),
          refreshWorkspace(conversationId),
          refreshPrs(conversationId),
        ])
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

/** The rows from the start of the turn holding `tip` to the newest, or the newest page. */
async function fetchTail(config: HermesConfig, sessionId: string, tip?: number) {
  const rows = new Map<number, SessionMessage>()
  for (let page = 0; page <= MAX_SKIPS; page++) {
    const batch = await listSessionMessages(config, sessionId, { limit: PAGE, offset: page * PAGE })
    for (const row of batch) rows.set(row.id, row)
    const sorted = [...rows.values()].sort((a, b) => a.id - b.id)
    if (tip === undefined) return { rows: sorted, full: batch.length === PAGE }
    const start = sorted.findLastIndex((row) => row.id <= tip && isTurnStart(row))
    if (start >= 0) return { rows: sorted.slice(start), full: false }
    if (batch.length < PAGE) return { rows: sorted, full: false }
  }
  return { rows: [...rows.values()].sort((a, b) => a.id - b.id), full: false }
}

function turnsOf(conversationId: string, sessionId: string, rows: SessionMessage[]) {
  const groups: SessionMessage[][] = []
  for (const row of rows) {
    if (isTurnStart(row) || !groups.length) groups.push([row])
    else groups[groups.length - 1].push(row)
  }
  return groups.map((group) => {
    const messages = toMessages(conversationId, sessionId, group)
    return {
      user: messages.find((m) => m.role === "user"),
      reply: messages.find((m) => m.role === "assistant"),
    }
  })
}

async function reconcile(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return 0
  const config = await connection(conversation)
  if (!config) return 0
  const local = await getMessages(conversationId)
  if (isStreaming(local)) return 0
  const sessionId = conversation.hermesSessionId
  const tip = local.length ? conversation.hermesTip : undefined
  if (tip !== undefined) {
    const [newest] = await listSessionMessages(config, sessionId, { limit: 1, offset: 0 })
    if (!newest || newest.id === tip) return 0
  }
  loading.add(conversationId)
  try {
    const { rows, full } = await fetchTail(config, sessionId, tip)
    if (!rows.length) return 0
    const turns = turnsOf(conversationId, sessionId, rows)
    return await db.transaction("rw", db.messages, db.conversations, async () => {
      const current = await getMessages(conversationId)
      if (isStreaming(current)) return 0
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
      for (const { user, reply } of turns) {
        if (!user) {
          // The tail of a turn whose start is on an older page; only an empty chat shows it.
          if (!current.length && reply) writes.push(reply)
          continue
        }
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
      await db.messages.bulkPut(writes)
      await db.conversations.update(conversationId, {
        hermesTip: rows[rows.length - 1].id,
        ...(current.length
          ? {}
          : { olderThan: full ? { id: rows[0].id, offset: rows.length } : undefined }),
      })
      return writes.filter((m) => !byId.has(m.id)).length
    })
  } finally {
    loading.delete(conversationId)
  }
}

/** Loads the page before the oldest row loaded so far. */
export async function loadEarlierHistory(conversationId: string) {
  if (loading.has(conversationId)) return
  loading.add(conversationId)
  try {
    const conversation = await db.conversations.get(conversationId)
    const olderThan = conversation?.olderThan
    if (!conversation || !olderThan) return
    const config = await connection(conversation)
    if (!config) return
    // Turns sent since the last load push older rows further from the newest end; skip past them.
    let offset = olderThan.offset
    let rows: SessionMessage[] = []
    let older: SessionMessage[] = []
    for (let skip = 0; skip <= MAX_SKIPS; skip++) {
      rows = await listSessionMessages(config, conversation.hermesSessionId, {
        limit: PAGE,
        offset,
      })
      older = rows.filter((row) => row.id < olderThan.id)
      if (older.length || rows.length < PAGE) break
      offset += rows.length
    }
    const messages = toMessages(conversationId, conversation.hermesSessionId, older)
    await db.transaction("rw", db.messages, db.conversations, async () => {
      await db.messages.bulkPut(messages)
      await db.conversations.update(conversationId, {
        olderThan:
          older.length && rows.length === PAGE
            ? { id: older[0].id, offset: offset + rows.length }
            : undefined,
      })
    })
  } finally {
    loading.delete(conversationId)
  }
}
