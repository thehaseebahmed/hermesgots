import { connectionKey, serverConfig } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db, type Message } from "@/lib/db"
import { getMoves, hasPluginFeature, undoMove as postUndo, type Move } from "@/lib/hermes"
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
    await postUndo(serverConfig(found.profile), found.conversation.hermesSessionId, moveId)
  } finally {
    await refreshMoves(conversationId)
  }
}

export interface MoveMarks {
  /** The messages to draw a marker above, each with the moves that happened before it. */
  before: Map<string, Move[]>
  /** Moves that came after everything the thread shows. */
  trailing: Move[]
}

/**
 * Each marker sits above the first message written after the move, by time, so Main reads in the
 * order things happened; one after every message closes the thread. A message triage left in Main
 * has no move, and an undone one no marker.
 */
export function moveMarks(messages: Message[], moves?: Move[]): MoveMarks {
  const marks: MoveMarks = { before: new Map(), trailing: [] }
  for (const move of moves ?? []) {
    if (move.undone) continue
    const next = messages.find((message) => message.createdAt > move.at)
    if (!next) marks.trailing.push(move)
    else {
      const above = marks.before.get(next.id) ?? []
      above.push(move)
      marks.before.set(next.id, above)
    }
  }
  return marks
}
