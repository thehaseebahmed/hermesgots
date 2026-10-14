import { noteFailure } from "@/lib/report"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db, type Conversation, type ModelChoice, type Profile } from "@/lib/db"
import { fullModel } from "@/lib/model-info"
import { modelFacts, sameModel, type Catalog } from "@/lib/models"
import { getSessionContext } from "@/lib/hermes"

/** Bots whose plugin has no context route (an older plugin). */
const unsupported = cooldown()

/**
 * What a session's context use is measured against: the model the next turn runs, since that is
 * what it will be spent on. A window Hermes recorded for a model the session has since left behind
 * never shows, so a switch is visible before the new model's first call lands.
 */
export function contextWindow(
  live: Conversation["liveContext"],
  profile: Profile | undefined,
  current: ModelChoice | undefined,
  catalog: Catalog | undefined,
): number | undefined {
  // Hermes's own window is this model's as long as its recorded call ran it.
  if (live?.window && (!current || sameModel(live.model ?? "", current.model))) return live.window
  const found = current ? modelFacts(catalog, current).context : undefined
  if (found) return found
  // What the bot cached is this model's only when it was looked up for it (or for no pick at all).
  if (current && profile?.contextModel !== fullModel(current)) return undefined
  return profile?.contextSource === "models.dev" ? profile.contextWindow : undefined
}

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
  const key = connectionKey(profile)
  if (unsupported.cooling(key)) return
  let live
  try {
    live = await getSessionContext(profile, conversation.hermesSessionId)
  } catch (error) {
    noteFailure("Reading context use", error)
    // A blip keeps the figure until the next read; a plugin without the route has none to give,
    // and one left from before would be older than the turns since.
    if (!(await lacksRoute(profile, error, "context"))) return
    unsupported.start(key)
    if (conversation.liveContext)
      await db.conversations.update(conversationId, { liveContext: undefined })
    return
  }
  unsupported.clear(key)
  const current = conversation.liveContext
  // The model counts too: a switch that lands with the same tokens and window still has to show.
  const unchanged =
    current?.tokens === live?.tokens &&
    current?.window === live?.window &&
    current?.model === live?.model
  if (!live || unchanged) return
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  await db.conversations.update(conversationId, { liveContext: live })
}
