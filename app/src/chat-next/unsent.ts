import { db, deleteConversation, updateConversation, type Conversation } from "@/lib/db"
import { draftKey, loadDraft } from "@/lib/drafts"

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

/**
 * A session left with nothing sent in it isn't kept; typed text is the user's to keep or drop, so
 * it is kept as a draft. Used where there is no chance to ask, beside Code's list.
 */
export async function settleLeft(id: string) {
  const row = await db.conversations.get(id)
  if (!row?.projectId || row.draftAt || !(await isUnsent(row))) return
  if ((await loadDraft(draftKey(id))).trim()) await updateConversation(id, { draftAt: Date.now() })
  else await deleteConversation(id)
}
