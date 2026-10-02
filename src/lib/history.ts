import { db, getMessages, type Conversation, type Message, type ToolEvent } from "@/lib/db"
import { listSessionMessages, type HermesConfig, type SessionMessage } from "@/lib/hermes"

/**
 * Message bodies don't sync; every device's turns live in the chat's Hermes session. Opening a chat
 * catches it up from there, and "Load earlier" pages back.
 */

const PAGE = 50
/** Pages to skip past rows sent since the last load, before giving up on finding older ones. */
const MAX_SKIPS = 10

function toolNames(row: SessionMessage) {
  let calls = row.tool_calls
  if (typeof calls === "string") {
    try {
      calls = JSON.parse(calls)
    } catch {
      calls = null
    }
  }
  return Array.isArray(calls)
    ? calls.map((call, i) => ({
        id: call?.id ?? `${row.id}-${i}`,
        name: call?.function?.name ?? "tool",
      }))
    : []
}

/** Folds each turn's assistant, tool-call and tool rows into one reply, as streaming shows it. */
export function toMessages(conversationId: string, sessionId: string, rows: SessionMessage[]) {
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
      if (tool) tool.endedAt = createdAt
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
    for (const call of toolNames(row)) {
      const event: ToolEvent = {
        toolCallId: call.id,
        tool: call.name,
        label: call.name,
        status: "completed",
        startedAt: createdAt,
        endedAt: createdAt,
        contentOffset: reply.content.length,
      }
      reply.tools = [...(reply.tools ?? []), event]
    }
  }
  return messages.filter(
    (m) => m.role === "user" || m.content || m.tools?.length || m.status === "error",
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
 * Catches a chat up with its transcript on Hermes, which holds every device's turns. An empty chat
 * gets the newest page; otherwise only turns newer than the last one seen arrive. Turns streamed on
 * this device are kept as they are (they carry stats and approvals Hermes doesn't store) and only
 * matched to their rows. Resolves to how many messages arrived.
 */
export function reconcileHistory(conversationId: string) {
  let pending = reconciling.get(conversationId)
  if (!pending) {
    pending = reconcile(conversationId).finally(() => reconciling.delete(conversationId))
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
