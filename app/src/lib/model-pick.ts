/**
 * The model a chat sends with, and the one its first send fixes there.
 *
 * Changing a bot's Default model says what the turns to come run on; a thread or session that has
 * already started keeps what it started on. So the first send writes the model in effect into the
 * chat's own pick, and every send after it reads that pick instead of the default.
 *
 * No runtime imports: the rule is held on its own, without a database or a host.
 */
import type { Conversation, ModelChoice, Profile } from "@/lib/db"

type Chat = Pick<Conversation, "modelChoice" | "main">
type BotPick = Pick<Profile, "modelChoice">
type BotName = BotPick & Pick<Profile, "model">
/** The host's main model as a read of it leaves it: no model until the host names one. */
export type HostModel = { provider?: string; model?: string } | null | undefined

/**
 * The Default row, written down as the pick it is: no model in it at all. The row has to say the
 * user chose something, because an absent pick is also what a chat that has never sent looks like
 * and the first send pins over one of those. `storedPick` is the one place that writes it and
 * `chosenOf` the one place that reads it back as no pick.
 */
const FOLLOWS_DEFAULT: ModelChoice = { provider: "", model: "" }

/** The pick a chat's row keeps for a menu choice, Default included. */
export function storedPick(choice: ModelChoice | undefined): ModelChoice {
  return choice ?? FOLLOWS_DEFAULT
}

/** That pick as the rest of the app reads it: the Default row's marker is no pick at all. */
export function chosenOf(choice: ModelChoice | undefined) {
  return choice?.model ? choice : undefined
}

/** Whether two picks name the same model, so a write can be told from the one it replaced. */
export function samePick(one?: ModelChoice, other?: ModelChoice) {
  return Boolean(one && other && one.provider === other.provider && one.model === other.model)
}

/**
 * Whether a pick can be sent at all: both halves, and no provider meaning "whichever fits". The
 * one place that rule is held — `pinOf` and `pickFields` both ask it.
 */
function sendable(pick?: Partial<ModelChoice>): pick is ModelChoice {
  return Boolean(pick?.model && pick.provider && pick.provider !== "auto")
}

/** A pick as a run body names it: both halves, or nothing at all when it couldn't be sent. */
export function pickFields(pick?: Partial<ModelChoice>) {
  return sendable(pick) ? { model: pick.model, provider: pick.provider } : {}
}

/**
 * Whether a chat's model is still to be fixed: it holds no pick of its own and isn't Main, whose
 * whole job is to follow the default as it changes. Also the one case where a send may have to ask
 * the host what it runs.
 */
export function wantsPin(chat: Chat) {
  return !chat.main && !chat.modelChoice
}

/** The chat's own pick, else the bot's default: the model in effect, before the host is asked. */
export function pickOf(chat: Chat, bot: BotPick) {
  return chosenOf(chat.modelChoice) ?? bot.modelChoice
}

/** The chat's own pick, else the bot's default, else whatever the host runs. */
export function modelOf(chat: Chat, bot: BotName) {
  const chosen = pickOf(chat, bot)
  return { model: chosen?.model ?? bot.model, provider: chosen?.provider }
}

/**
 * What a chat's first send pins: the pick its caller resolved — the bot's default, else the
 * host's own — so the pin is the model the screen showed. Nothing for a chat that already has a
 * pick of its own (the user's, or the Default row's), none for Main, and none for a pick nothing
 * could send.
 */
export function pinOf(chat: Chat, pick?: ModelChoice): ModelChoice | undefined {
  if (!wantsPin(chat) || !sendable(pick)) return undefined
  return pick
}
