import { connectionKey, serverConfig } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { getMoves, hasPluginFeature, postMoveUndo, type Move } from "@/lib/hermes"
import { tracked } from "@/lib/tracked"

/** Bots whose plugin has no moves route (an older plugin). */
const unsupported = cooldown()

/**
 * Reads the messages triage moved out of a Main thread from the host, which recorded them, so every
 * device shows the same markers. Only Main has any, and only a plugin that offers them is asked.
 */
export async function refreshMoves(conversationId: string) {
  const found = await tracked(conversationId)
  if (!found?.conversation.main) return
  const { conversation, profile } = found
  const key = connectionKey(profile)
  if (unsupported.cooling(key)) return
  const config = serverConfig(profile)
  let moves: Move[]
  try {
    if (!(await hasPluginFeature(config, "moves"))) return
    moves = await getMoves(config, conversation.hermesSessionId)
  } catch (error) {
    if (await lacksRoute(profile, error, "moves")) unsupported.start(key)
    return
  }
  unsupported.clear(key)
  if (JSON.stringify(conversation.moves ?? []) === JSON.stringify(moves)) return
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  await db.conversations.update(conversationId, { moves })
}

/**
 * Takes a moved message back. The host does it all (stops the thread's reply, removes the message,
 * sends it to Main without asking again), so this only asks and then reads the markers again; a
 * refusal (the thread already replied) is the caller's to show, and the read still drops the button.
 */
export async function undoMove(conversationId: string, moveId: string) {
  const found = await tracked(conversationId)
  if (!found?.conversation.main) return
  try {
    await postMoveUndo(serverConfig(found.profile), found.conversation.hermesSessionId, moveId)
  } finally {
    await refreshMoves(conversationId)
  }
}
