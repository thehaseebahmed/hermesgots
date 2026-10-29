import { db, type Conversation } from "@/lib/db"

/**
 * Whether nothing was ever sent in a chat: its record never moved past its creation, the host's
 * transcript hasn't been read into it and no turn of this device is in flight. Read when asked
 * rather than watched, since the answer only matters at the moment a session is left.
 */
export async function isUnsent(chat: Conversation) {
  if (chat.updatedAt > chat.createdAt) return false
  const session = chat.hermesSessionId
  if ((await db.sessionStates.get(session))?.live) return false
  const rows = await db.sessionRows
    .where("[session+set+id]")
    .between([session], [session, []])
    .count()
  return rows === 0
}
