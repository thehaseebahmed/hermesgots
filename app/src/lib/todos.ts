import { db } from "@/lib/db"
import { getSessionTodos, parseTodos, type SessionTodos } from "@/lib/hermes"

/** Bots whose plugin has no todos route (an older plugin), and when they were last asked. */
const unsupported = new Map<string, number>()
const RETRY_MS = 5 * 60 * 1000
/** How long a list from the live stream beats the plugin's, whose transcript may not have it yet. */
const LIVE_MS = 10_000
const TODO_TOOLS = new Set(["todo_list", "todo"])

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
  if (!conversation || !profile?.apiKey || !profile.pluginChats) return null
  return { conversation, profile }
}

/**
 * Reads the agent's todo list for a chat from its server's Memento plugin. Keyless chats and bots
 * without the plugin have no list.
 */
export async function refreshTodos(conversationId: string) {
  const found = await tracked(conversationId)
  if (!found) return
  const { conversation, profile } = found
  const key = `${profile.baseUrl}\n${profile.apiKey}`
  if (Date.now() - (unsupported.get(key) ?? -Infinity) < RETRY_MS) return
  let todos
  try {
    todos = await getSessionTodos(profile, conversation.hermesSessionId)
  } catch {
    unsupported.set(key, Date.now())
    return
  }
  unsupported.delete(key)
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
  window.setTimeout(() => void refreshTodos(conversationId), 1500)
}
