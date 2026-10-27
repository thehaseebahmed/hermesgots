import { db, updateConversation } from "./db"
import { READ_TIMEOUT_MS } from "./freshness"
import { getSessionTitle, type HermesConfig } from "./hermes"

/**
 * Writes the title Hermes gave a session onto a chat the user never renamed, and says whether it
 * did. The host titles a chat in the background, so this is reached from the live stream's `title`
 * event, the checks after a turn and a catch-up — one place for the guards that keep a rename, a
 * deleted chat and an unchanged title from costing a write.
 */
export async function takeHostTitle(
  conversationId: string,
  config: HermesConfig,
  sessionId: string,
): Promise<boolean> {
  const before = await db.conversations.get(conversationId)
  if (!before || before.titleEdited) return false
  const title = await getSessionTitle(config, sessionId, AbortSignal.timeout(READ_TIMEOUT_MS))
  if (!title) return false
  // Read again: the user may have renamed the chat while the title was on its way.
  const after = await db.conversations.get(conversationId)
  if (!after || after.titleEdited || after.title === title) return false
  await updateConversation(conversationId, { title })
  return true
}
