import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { getSessionTodos, parseTodos, type SessionTodos } from "@/lib/hermes"
import { TODO_TOOLS } from "@/lib/tools"

/** Bots whose plugin has no todos route (an older plugin). */
const unsupported = cooldown()
/** How long a list from the live stream beats the plugin's, whose transcript may not have it yet. */
const LIVE_MS = 10_000
/**
 * Reads the list again a moment after a todo tool call, since Hermes writes the transcript row the
 * plugin reads only after the tool round; one attempt often lands too early.
 */
const TODO_RETRY_MS = [1500, 5000]

async function store(conversationId: string, todos: SessionTodos | null, live: boolean) {
  const current = (await db.conversations.get(conversationId))?.todos
  if (
    !live &&
    current &&
    Date.now() - current.at < LIVE_MS &&
    current.revision > (todos?.revision ?? -1)
  )
    return
  if (
    current?.revision === todos?.revision &&
    JSON.stringify(current?.items) === JSON.stringify(todos?.items)
  )
    return
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  await db.conversations.update(conversationId, {
    todos: todos ? { ...todos, at: Date.now() } : undefined,
  })
}

/** The chat and its bot, when the bot's plugin can read its list. */
async function tracked(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  // Keyless chats have no session id Hermes knows.
  if (!conversation || !profile?.apiKey || profile.disabled) return null
  return { conversation, profile }
}

/**
 * Reads the agent's todo list for a chat from its server's Gots plugin. Keyless chats and bots
 * without the plugin have no list.
 */
export async function refreshTodos(conversationId: string) {
  const found = await tracked(conversationId)
  if (!found) return
  const { conversation, profile } = found
  const key = connectionKey(profile)
  if (unsupported.cooling(key)) return
  let todos
  try {
    todos = await getSessionTodos(profile, conversation.hermesSessionId)
  } catch (error) {
    if (await lacksRoute(profile, error, "todos")) unsupported.start(key)
    return
  }
  unsupported.clear(key)
  await store(conversationId, todos, false)
}

/**
 * Picks up a todo tool call from a run's live events. The preview is cut at 500 characters, so a
 * long list only arrives once the plugin reads the transcript, which Hermes writes after the round.
 */
export async function onTodoTool(conversationId: string, tool: string, preview?: string) {
  if (!TODO_TOOLS.has(tool) && !(tool === "tool_call" && preview?.includes('"todos"'))) return
  // Only lists the plugin can bring back on every device, so the chat shows the same everywhere.
  if (!(await tracked(conversationId))) return
  let todos = null
  try {
    todos = preview ? parseTodos(JSON.parse(preview)) : null
  } catch {
    // Cut short; the plugin has the whole list.
  }
  if (todos) await store(conversationId, todos, true)
  for (const ms of TODO_RETRY_MS) window.setTimeout(() => void refreshTodos(conversationId), ms)
}
