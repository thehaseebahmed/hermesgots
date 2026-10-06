import { db, getMessages, updateConversation, type Conversation, type Message, type ToolEvent } from "@/lib/db"
import { refreshContext } from "@/lib/context"
import { refreshTodos } from "@/lib/todos"
import { refreshPrs, refreshWorkspace } from "@/lib/workspace"
import { getSessionTitle, listSessionMessages, type HermesConfig, type SessionMessage } from "@/lib/hermes"

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
      return { name: innerName, label: argsLabel(innerName, parseArgs(entry.arguments)) }
    })
    if (inner.length === 1) return inner[0]
    if (inner.length > 1)
      return {
        name,
        label: inner.map((c) => (c.label ? `${c.name}: ${c.label}` : c.name)).join("\n"),
      }
  }
  return { name, label: argsLabel(name, args) }
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
        const { name, label } = describeCall(
          call?.function?.name ?? "tool",
          parseArgs(call?.function?.arguments),
        )
        return { id: call?.id ?? `${row.id}-${i}`, name, label: clip(label) || name }
      })
    : []
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
  for (const row of rows) {
    if (row.display_kind === "hidden" || row.role === "system") continue
    const createdAt = Math.round((row.timestamp ?? 0) * 1000) || Date.now()
    const id = `h-${sessionId}-${row.id}`
    if (row.role === "user") {
      reply = undefined
      messages.push({
        id,
        conversationId,
        role: "user",
        content: row.content ?? "",
        status: "done",
        createdAt,
        hermesRowId: row.id,
      })
      continue
    }
    if (!reply) {
      reply = {
        id,
        conversationId,
        role: "assistant",
        content: "",
        tools: [],
        status: "done",
        createdAt,
      }
      messages.push(reply)
    }
    if (row.role === "tool") {
      const tool = reply.tools?.find((t) => t.toolCallId === row.tool_call_id)
      if (tool) {
        tool.status = "completed"
        tool.endedAt = createdAt
        if (row.content) tool.result = clip(row.content)
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
      reply.content = reply.content ? `${reply.content}\n\n${row.content}` : row.content
    }
    for (const call of toolCalls(row)) {
      const event: ToolEvent = {
        toolCallId: call.id,
        tool: call.name,
        label: call.label,
        status: "running",
        startedAt: createdAt,
        contentOffset: reply.content.length,
      }
      reply.tools = [...(reply.tools ?? []), event]
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
  const rows = await listSessionMessages(config, sessionId, { limit: PAGE, offset: 0, signal })
  const start = rows.findLastIndex((row) => isTurnStart(row) && row.content === userContent)
  if (start < 0) return undefined
  return toMessages("", sessionId, rows.slice(start), { live: true }).find(
    (m) => m.role === "assistant",
  )
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
  if (title && title !== conversation.title)
    await updateConversation(conversationId, { title })
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
    pending = reconcile(conversationId)
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

const isTurnStart = (row: SessionMessage) => row.role === "user" && row.display_kind !== "hidden"

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
          if (local?.role === "assistant" && !local.tools?.length && reply?.tools?.length)
            writes.push({
              ...local,
              tools: reply.tools,
              reasoning: local.reasoning ?? reply.reasoning,
            })
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
