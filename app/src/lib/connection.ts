import type { HermesConfig } from "@/lib/hermes"

/** One server and key: bots that share both share a stream, a cache entry and a poll. */
export const connectionKey = (server: { baseUrl: string; apiKey: string }) =>
  `${server.baseUrl.trim().replace(/\/+$/, "")}\n${server.apiKey}`

/**
 * The bots whose lists are read once each: two bots on one server and profile share one list, so the
 * first of them keeps it. Every screen that merges a list across bots reads this, not the raw list.
 */
export const hostTargets = async <T extends { baseUrl: string; apiKey?: string }>(profiles: T[]) => {
  const seen = new Set<string>()
  return profiles.filter((profile) => {
    const key = connectionKey({ baseUrl: profile.baseUrl, apiKey: profile.apiKey ?? "" })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Whether a bot can be called at all: a server to call and a key to call it with. */
export const hasServer = (profile?: { baseUrl: string; apiKey: string } | null) =>
  Boolean(profile?.apiKey && profile?.baseUrl.trim())

/** A bot's server as its client takes it (and its calls, polls and caches are keyed by it): the URL
 * and key to call it with, empty while there is no bot. */
export const serverConfig = (
  profile?: { baseUrl: string; apiKey: string } | null,
): HermesConfig => ({ baseUrl: profile?.baseUrl ?? "", apiKey: profile?.apiKey ?? "" })
