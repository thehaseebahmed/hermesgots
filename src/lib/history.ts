import { db, getMessages, type Conversation, type Message, type ToolEvent } from "@/lib/db"
import { listSessionMessages, type SessionMessage } from "@/lib/hermes"

/**
 * Chats synced from another device arrive without messages; their transcript lives on Hermes.
 * Opening one loads the latest page from there, and "Load earlier" pages back.
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

const recent = new Map<string, Promise<number>>()

/** Loads the newest page of an empty chat's transcript. Resolves to how many messages arrived. */
export function loadRecentHistory(conversationId: string) {
  let pending = recent.get(conversationId)
  if (!pending) {
    pending = fetchRecent(conversationId).finally(() => recent.delete(conversationId))
    recent.set(conversationId, pending)
  }
  return pending
}

async function fetchRecent(conversationId: string) {
  loading.add(conversationId)
  try {
    const conversation = await db.conversations.get(conversationId)
    if (!conversation || (await getMessages(conversationId)).length) return 0
    const config = await connection(conversation)
    if (!config) return 0
    const rows = await listSessionMessages(config, conversation.hermesSessionId, {
      limit: PAGE,
      offset: 0,
    })
    const messages = toMessages(conversationId, conversation.hermesSessionId, rows)
    await db.transaction("rw", db.messages, db.conversations, async () => {
      if (await db.messages.where("conversationId").equals(conversationId).count()) return
      await db.messages.bulkPut(messages)
      await db.conversations.update(conversationId, {
        olderThan: rows.length === PAGE ? { id: rows[0].id, offset: rows.length } : undefined,
      })
    })
    return messages.length
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
