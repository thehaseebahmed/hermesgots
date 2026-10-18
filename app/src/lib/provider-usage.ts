import { noteFailure } from "@/lib/report"
import { connectionKey, serverConfig } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db, type Conversation, type Profile } from "@/lib/db"
import { JUST_FOLLOWED_UP_MS } from "@/lib/freshness"
import { getProviderUsage, type ProviderUsage as ProviderUsageData } from "@/lib/hermes"

/** Bots whose plugin has no usage route (an older plugin). */
const unsupported = cooldown()
/** When each server's figure for a provider was last asked for, so a chat opening asks once. */
const asked = new Map<string, number>()
/** Show the banner when this much or less of a window is left. */
export const NOTICE_REMAINING_PERCENT = 20

export function effectiveProvider(
  conversation: Conversation | undefined,
  profile: Profile | undefined,
) {
  if (conversation?.modelChoice?.provider) return conversation.modelChoice.provider
  if (profile?.modelChoice?.provider) return profile.modelChoice.provider
  return profile?.hostModel?.provider
}

export interface UsageWindowView {
  label: string
  usedPercent: number
  remaining: number
  resetsAt?: number
  detail?: string
}

export function windowViews(usage: ProviderUsageData | undefined): UsageWindowView[] {
  if (!usage?.windows.length) return []
  // The route's order is the provider's own (a weekly window above a monthly one, say), so the
  // sheet keeps it; the banner picks the tightest window itself.
  return usage.windows.map((w) => ({
    label: w.label,
    usedPercent: w.usedPercent,
    remaining: Math.max(0, Math.round(100 - w.usedPercent)),
    ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
    ...(w.detail ? { detail: w.detail } : {}),
  }))
}

/**
 * A window with no reset time is a balance, not a period: bought credits, which a spent allowance
 * draws on. Nothing about it runs out with the clock, so it is what keeps an account working after
 * the period above it is spent. The route carries the key either way — an ISO time, or a null for a
 * balance — so a window without one is a balance rather than a period the app couldn't date.
 */
function isBalance(window: UsageWindowView) {
  return window.resetsAt === undefined
}

function tightestOf(windows: UsageWindowView[]) {
  return windows.reduce<UsageWindowView | undefined>(
    (tightest, window) => (!tightest || window.remaining < tightest.remaining ? window : tightest),
    undefined,
  )
}

/**
 * The notice for the composer, or nothing while the account can still run.
 *
 * A balance with room left is capacity, so a spent allowance beside it isn't the end of the road
 * and nothing is shown; a balance that is itself running out is what warns, and names itself. With
 * no balance in hand the tightest window decides, as it always has: a spent one reads as the
 * account being out, a nearly spent one as a warning.
 */
export function limitNotice(usage: ProviderUsageData | undefined) {
  const windows = windowViews(usage)
  const balance = tightestOf(windows.filter((w) => isBalance(w) && w.remaining > 0))
  if (balance && balance.remaining > NOTICE_REMAINING_PERCENT) return undefined
  const notice = balance ?? tightestOf(windows)
  return notice && notice.remaining <= NOTICE_REMAINING_PERCENT ? notice : undefined
}

/** A dismissal lasts that window's state: one dismissed while approaching still reports being out. */
export function limitNoticeKey(provider: string, window: UsageWindowView) {
  const state = window.remaining > 0 ? "approaching" : "out"
  return `${provider}:${window.label}:${window.resetsAt ?? 0}:${state}`
}

/** Two answers are the same when their windows match by value, not by reference. */
function sameWindows(a: ProviderUsageData | undefined, b: ProviderUsageData) {
  if (!a || a.provider !== b.provider || a.windows.length !== b.windows.length) return false
  const shape = (w: { label: string; usedPercent: number; resetsAt?: number }) =>
    `${w.label}:${w.usedPercent}:${w.resetsAt ?? 0}`
  return a.windows.every((w, i) => shape(w) === shape(b.windows[i]))
}

export function resetsInText(ms: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((ms - now) / 1000))
  // The last minute reads "1m" rather than a second count the 60-second tick can't keep up with;
  // the other forms are coarse enough to be honest between ticks.
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (seconds < 86400) return m ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(seconds / 86400)
  const hr = Math.floor((seconds % 86400) / 3600)
  return hr ? `${d}d ${hr}h` : `${d}d`
}

export function resetsAtText(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

/**
 * Reads the provider's account-usage windows from its server's Gots plugin.
 * Stored on the profile (local only, never synced) so each device sees the same
 * figure. Skips keyless or disabled bots, and backs off a failed server for 5
 * minutes so a missing plugin doesn't poll on every catch-up.
 */
export async function refreshProviderUsage(profileId: string, provider: string | undefined) {
  if (!provider) return
  const profile = await db.profiles.get(profileId)
  if (!profile || !profile.apiKey || profile.disabled) return
  const key = connectionKey(profile)
  if (unsupported.cooling(key)) return
  const at = asked.get(`${key} ${provider}`) ?? -Infinity
  if (Date.now() - at < JUST_FOLLOWED_UP_MS) return
  asked.set(`${key} ${provider}`, Date.now())
  const config = serverConfig(profile)
  let usage: ProviderUsageData | null
  try {
    usage = await getProviderUsage(config, provider)
  } catch (error) {
    noteFailure("Reading provider limits", error)
    // A blip keeps the figure until the next read; a plugin without the route has none to give.
    if (!(await lacksRoute(profile, error, "usage"))) return
    unsupported.start(key)
    if (profile.providerUsage) await db.profiles.update(profileId, { providerUsage: undefined })
    return
  }
  unsupported.clear(key)
  if (!usage || sameWindows(profile.providerUsage, usage)) return
  // Not through updateProfile: this is local, so it mustn't move the sync clock.
  await db.profiles.update(profileId, { providerUsage: usage })
}

/** `refreshProviderUsage` for the provider a chat runs on. */
export async function refreshChatProviderUsage(conversationId: string) {
  const conversation = await db.conversations.get(conversationId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  if (profile) await refreshProviderUsage(profile.id, effectiveProvider(conversation, profile))
}
