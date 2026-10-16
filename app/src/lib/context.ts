import { noteFailure } from "@/lib/report"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db, type Conversation, type ModelChoice, type Profile } from "@/lib/db"
import { fullModel } from "@/lib/model-info"
import { modelFacts, sameModel, type Catalog } from "@/lib/models"
import { getSessionContext, type ModelChange } from "@/lib/hermes"

/** Bots whose plugin has no context route (an older plugin). */
const unsupported = cooldown()

/**
 * What a session's context use is measured against: the model the next turn runs, since that is
 * what it will be spent on. In order: the window the bot already holds for that model (so a screen
 * paints a number at once, without a lookup), Hermes's own window for the call that ran it, then
 * models.dev's for it. A window known for a model the session has since left behind never shows, so
 * a switch is visible before the new model's first call lands.
 */
export function contextWindow(
  live: Conversation["liveContext"],
  profile: Profile | undefined,
  current: ModelChoice | undefined,
  catalog: Catalog | undefined,
): number | undefined {
  if (profile?.contextWindow && heldFor(profile, current)) return profile.contextWindow
  // Hermes's own window is this model's as long as its recorded call ran it.
  if (live?.window && (!current || sameModel(live.model ?? "", current.model))) return live.window
  return current ? modelFacts(catalog, current).context : undefined
}

/** Whether the window the bot holds was written for the model the chat runs next. */
function heldFor(profile: Profile, current: ModelChoice | undefined) {
  return !current || profile.contextModel === fullModel(current)
}

/**
 * Reads a chat's context use from its server's Gots plugin, which sees every model call, so each
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
    // One left from before would be older than the turns since, the model list with it.
    if (conversation.liveContext || conversation.modelChanges)
      await db.conversations.update(conversationId, {
        liveContext: undefined,
        modelChanges: undefined,
      })
    return
  }
  unsupported.clear(key)
  if (!live) return
  const current = conversation.liveContext
  const changes = live.modelChanges
  const context: Conversation["liveContext"] =
    live.tokens === undefined
      ? undefined
      : { tokens: live.tokens, window: live.window, model: live.model }
  // The model counts too: a switch that lands with the same tokens and window still has to show.
  const contextMoved =
    !!context &&
    (current?.tokens !== context.tokens ||
      current?.window !== context.window ||
      current?.model !== context.model)
  // And a switch recorded under an unchanged figure: the divider rides the list alone.
  const changesMoved = !sameChanges(conversation.modelChanges, changes)
  if (!contextMoved && !changesMoved) return
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  await db.conversations.update(conversationId, {
    ...(contextMoved ? { liveContext: context } : {}),
    ...(changesMoved ? { modelChanges: changes } : {}),
  })
}

/** Whether the host's list moved: a switch can land with the same figure and still has to show. */
function sameChanges(before: ModelChange[] | undefined, after: ModelChange[] | undefined) {
  return (
    (before?.length ?? 0) === (after?.length ?? 0) && before?.at(-1)?.model === after?.at(-1)?.model
  )
}
