import { db } from "@/lib/db"

/** The chat and its bot, when the bot's plugin can read what the chat's host records. */
export async function tracked(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  // Keyless chats have no session id Hermes knows.
  if (!conversation || !profile?.apiKey || profile.disabled) return null
  return { conversation, profile }
}
