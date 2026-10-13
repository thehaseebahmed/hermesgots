import { db } from "@/lib/db"
import { cooldown } from "@/lib/cooldown"
import { getSessionContext } from "@/lib/hermes"

/** Bots whose plugin has no context route (an older plugin), and when they were last asked. */
const unsupported = cooldown(5 * 60 * 1000)

/**
 * Reads a chat's context use from its server's Memento plugin, which sees every model call, so each
 * device shows the same exact figure. Hermes's API has nothing to work it out from, so chats without
 * the plugin aren't tracked.
 */
export async function refreshContext(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  // Keyless chats have no session id Hermes knows.
  if (!conversation || !profile?.apiKey || profile.disabled) return
  const key = `${profile.baseUrl}\n${profile.apiKey}`
  if (unsupported.cooling(key)) return
  let live
  try {
    live = await getSessionContext(profile, conversation.hermesSessionId)
  } catch {
    unsupported.cool(key)
    // Older than the turns since, so showing it would mislead.
    if (conversation.liveContext)
      await db.conversations.update(conversationId, { liveContext: undefined })
    return
  }
  unsupported.clear(key)
  const current = conversation.liveContext
  if (!live || (current?.tokens === live.tokens && current.window === live.window)) return
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  await db.conversations.update(conversationId, { liveContext: live })
}
