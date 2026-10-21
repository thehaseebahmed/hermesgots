import { noteFailure } from "@/lib/report"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db, type Conversation, type ModelChoice, type Profile } from "@/lib/db"
import { fullModel } from "@/lib/model-info"
import { modelFacts, sameModel, type Catalog } from "@/lib/models"
import { getSessionContext, type Compaction, type ModelChange } from "@/lib/hermes"

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

/** The read in flight per chat, if any, which the next ask waits on rather than racing. */
const inFlight = new Map<string, Promise<void>>()

/**
 * Reads a chat's context use from its server's Gots plugin, which sees every model call, so each
 * device shows the same exact figure. Hermes's API has nothing to work it out from, so chats without
 * the plugin aren't tracked.
 *
 * A turn's end and the send right after it can ask for the same record at once. One read runs at a
 * time per chat and the second follows the first: joining it instead would hand back a read that
 * started before the turn ended, leaving that turn's row out, and two at once would let the older
 * answer land last and put an older list back.
 */
export function refreshContext(conversationId: string): Promise<void> {
  const previous = inFlight.get(conversationId) ?? Promise.resolve()
  const read = previous
    .catch(() => {})
    .then(() => readContext(conversationId))
    .finally(() => {
      if (inFlight.get(conversationId) === read) inFlight.delete(conversationId)
    })
  inFlight.set(conversationId, read)
  return read
}

async function readContext(conversationId: string): Promise<void> {
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
    if (conversation.liveContext || conversation.modelChanges || conversation.compactions)
      await db.conversations.update(conversationId, {
        liveContext: undefined,
        modelChanges: undefined,
        compactions: undefined,
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
  // The host omits the list when it couldn't read it: unknown is not "no changes", so a missing
  // list keeps the dividers we have rather than clearing them.
  const changesMoved = changes !== undefined && !sameChanges(conversation.modelChanges, changes)
  // The same for compactions: only a list the host sent can replace the one held, and one more or
  // fewer is the only way it moves.
  const compacted = live.compactions
  const compactedMoved =
    compacted !== undefined && !sameCompactions(conversation.compactions, compacted)
  if (!contextMoved && !changesMoved && !compactedMoved) return
  // Not through updateConversation: this is local, so it mustn't move the sync clock.
  await db.conversations.update(conversationId, {
    ...(contextMoved ? { liveContext: context } : {}),
    ...(changesMoved ? { modelChanges: changes } : {}),
    ...(compactedMoved ? { compactions: compacted } : {}),
  })
}

function sameCompactions(before: Compaction[] | undefined, after: Compaction[]) {
  return (
    (before?.length ?? 0) === after.length && (before ?? []).every((c, i) => c.at === after[i].at)
  )
}

/**
 * Whether the host's list moved: a switch can land with the same figure and still have to show, and
 * the host may name one model two ways between reads. Missing on both sides still reads unchanged.
 */
function sameChanges(before: ModelChange[] | undefined, after: ModelChange[] | undefined) {
  const was = before?.at(-1)?.model
  const is = after?.at(-1)?.model
  return (
    (before?.length ?? 0) === (after?.length ?? 0) && (was === is || sameModel(was ?? "", is ?? ""))
  )
}
