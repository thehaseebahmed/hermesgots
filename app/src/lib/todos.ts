import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { getSessionTodos, type SessionTodos } from "@/lib/hermes"
import { TODO_TOOLS } from "@/lib/tools"
import { tracked } from "@/lib/tracked"

/** Bots whose plugin has no todos route (an older plugin). */
const unsupported = cooldown()
/**
 * Reads the list again a moment after a todo tool call, since Hermes writes the transcript row the
 * plugin reads only after the tool round; one attempt often lands too early.
 */
const TODO_RETRY_MS = [1500, 5000]

async function store(conversationId: string, todos: SessionTodos | null) {
  const current = (await db.conversations.get(conversationId))?.todos
  if (
    current?.revision === todos?.revision &&
    JSON.stringify(current?.items) === JSON.stringify(todos?.items) &&
    JSON.stringify(current?.progress) === JSON.stringify(todos?.progress)
  )
    return
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  await db.conversations.update(conversationId, {
    todos: todos ? { ...todos, at: Date.now() } : undefined,
  })
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
  await store(conversationId, todos)
}

/**
 * A todo tool call just finished, so the list it wrote is worth reading again. The result the stream
 * carries is a preview and nothing is read out of it here: the plugin has the whole list, and it is
 * read a beat later, once Hermes has flushed the transcript row.
 */
export async function onTodoTool(conversationId: string, tool: string) {
  if (!TODO_TOOLS.has(tool)) return
  // Only lists the plugin can bring back on every device, so the chat shows the same everywhere.
  if (!(await tracked(conversationId))) return
  for (const ms of TODO_RETRY_MS) window.setTimeout(() => void refreshTodos(conversationId), ms)
}
