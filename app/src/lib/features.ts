/**
 * What a Bot's Host answered about the Gots plugin's features (`info`'s `features`), for every
 * screen that gates a control on one. An answer is remembered for its connection, so a screen
 * opened again doesn't wait on the same read; only a real answer is kept, so a Host that was away
 * is asked again the next time a screen needs it.
 */
import { useMemo, useSyncExternalStore } from "react"

import { connectionKey, serverConfig } from "@/lib/connection"
import { getPluginFeatureList, type HermesConfig } from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { createSignal } from "@/lib/store"

/**
 * What a Bot's plugin answered about a feature: `yes` it advertises it, `no` it answered without
 * it, and `unknown` while there is no answer yet — which is nothing to act on rather than an
 * absence.
 */
export type PluginFeatureAnswer = "unknown" | "yes" | "no"

/** A bot's server as a read of its features takes it. */
type Server = Pick<HermesConfig, "baseUrl" | "apiKey"> | null | undefined

// The feature lists the connections' plugins answered; only a real answer is remembered.
const answered = new Map<string, string[]>()
const { subscribe, notify } = createSignal()

async function readFeatures(config: HermesConfig) {
  const key = connectionKey(config)
  if (answered.has(key)) return
  const features = await getPluginFeatureList(config)
  // No answer at all (the Host couldn't be read): nothing is remembered, so it is asked again.
  if (!features) return
  answered.set(key, features)
  notify()
}

/**
 * What the Bot's plugin answered about each of `features` — one read of its list answers them all.
 * The snapshot is that answer's own names, so a Host that was asked again re-renders here; a
 * connection with no answer yet is `unknown` for every feature rather than `no` for each.
 */
export function usePluginFeatureAnswers(
  server: Server,
  features: readonly string[],
): Record<string, PluginFeatureAnswer> {
  const config = serverConfig(server)
  const { baseUrl, apiKey } = config
  const key = baseUrl && apiKey ? connectionKey(config) : ""
  const listed = useSyncExternalStore(subscribe, () =>
    key && answered.has(key) ? answered.get(key)!.join(",") : null,
  )
  usePoll(() => void readFeatures(config), false, [baseUrl, apiKey], {
    active: Boolean(key),
    onShow: false,
  })
  const names = features.join(",")
  return useMemo(() => {
    const known = listed === null ? null : listed ? listed.split(",") : []
    return Object.fromEntries(
      (names ? names.split(",") : []).map((feature) => [
        feature,
        known === null ? "unknown" : known.includes(feature) ? "yes" : "no",
      ]),
    )
  }, [listed, names])
}

/** One of those features, for a control that needs just the one. */
export function usePluginFeature(server: Server, feature: string): PluginFeatureAnswer {
  return usePluginFeatureAnswers(server, [feature])[feature]
}

/** That feature as a switch: true only for an answer that carries it, false while it's unknown. */
export function usePluginFeatureOn(server: Server, feature: string): boolean {
  return usePluginFeature(server, feature) === "yes"
}
