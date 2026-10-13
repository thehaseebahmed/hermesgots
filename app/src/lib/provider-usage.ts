import { db, type Conversation, type Profile } from "@/lib/db"
import { getProviderUsage, type HermesConfig, type ProviderUsage as ProviderUsageData } from "@/lib/hermes"

/** Bots whose plugin has no usage route (or an older plugin), and when they were last asked. */
const unsupported = new Map<string, number>()
const RETRY_MS = 5 * 60 * 1000
/** Show the banner when this much or less of a window is left. */
export const NOTICE_REMAINING_PERCENT = 20

export function effectiveProvider(conversation: Conversation | undefined, profile: Profile | undefined) {
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

export function tightestWindow(usage: ProviderUsageData | undefined): UsageWindowView | undefined {
  if (!usage?.windows.length) return undefined
  return usage.windows
    .map((w) => ({
      label: w.label,
      usedPercent: w.usedPercent,
      remaining: Math.max(0, Math.round(100 - w.usedPercent)),
      ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      ...(w.detail ? { detail: w.detail } : {}),
    }))
    .sort((a, b) => a.remaining - b.remaining)[0]
}

export function limitNotice(usage: ProviderUsageData | undefined) {
  const w = tightestWindow(usage)
  if (!w || w.remaining > NOTICE_REMAINING_PERCENT) return undefined
  return w
}

export function limitNoticeKey(provider: string, window: UsageWindowView) {
  return `${provider}:${window.label}:${window.resetsAt ?? 0}`
}

export function resetsInText(ms: number) {
  const now = Date.now()
  const seconds = Math.max(0, Math.round((ms - now) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    return `${m}m`
  }
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
 * Reads the provider's account-usage windows from its server's Memento plugin.
 * Stored on the profile (local only, never synced) so each device sees the same
 * figure. Skips keyless or disabled bots, and backs off a failed server for 5
 * minutes so a missing plugin doesn't poll on every catch-up.
 */
export async function refreshProviderUsage(profileId: string, provider: string | undefined) {
  if (!provider) return
  const profile = await db.profiles.get(profileId)
  if (!profile || !profile.apiKey || profile.disabled) return
  const key = `${profile.baseUrl}\n${profile.apiKey}`
  if (Date.now() - (unsupported.get(key) ?? -Infinity) < RETRY_MS) return
  const config: HermesConfig = { baseUrl: profile.baseUrl, apiKey: profile.apiKey }
  let usage: ProviderUsageData | null
  try {
    usage = await getProviderUsage(config, provider)
  } catch {
    unsupported.set(key, Date.now())
    if (profile.providerUsage) await db.profiles.update(profileId, { providerUsage: undefined })
    return
  }
  // A 404 (CORS-blocked) means the plugin isn't there; back off so the catch-up
  // timer doesn't hammer it. getProviderUsage returns null on any failure, so we
  // can't tell a missing plugin from "no windows" — treat null + no existing
  // data as unsupported to avoid clearing good data on a transient empty result.
  if (!usage) {
    if (!profile.providerUsage) unsupported.set(key, Date.now())
    return
  }
  unsupported.delete(key)
  const current = profile.providerUsage
  if (current && current.provider === usage.provider && current.windows === usage.windows) return
  await db.profiles.update(profileId, { providerUsage: usage })
}