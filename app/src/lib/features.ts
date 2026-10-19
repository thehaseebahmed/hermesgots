/**
 * What a Bot's Host answered about the Gots plugin's features (`info`'s `features`), for every
 * screen that gates a control on one. An answer is remembered for its connection, so a screen
 * opened again doesn't wait on the same read; only a real answer is kept, so a Host that was away
 * is asked again the next time a screen needs it.
 */
import { connectionKey, serverConfig } from "@/lib/connection"
import { getPluginFeatureList, type HermesConfig } from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { createStore } from "@/lib/store"

/**
 * What a Bot's plugin answered about a feature: `yes` it advertises it, `no` it answered without
 * it, and `unknown` while there is no answer yet — which is nothing to act on rather than an
 * absence.
 */
export type PluginFeatureAnswer = "unknown" | "yes" | "no"

/** A bot's server as a read of its features takes it. */
type Server = Pick<HermesConfig, "baseUrl" | "apiKey"> | null | undefined

// The features each connection's plugin answered; only a real answer is remembered, and the map is
// replaced rather than mutated so a subscriber is handed a new value.
const answered = createStore<ReadonlyMap<string, readonly string[]>>(new Map())

async function readFeatures(config: HermesConfig) {
  const key = connectionKey(config)
  if (answered.get().has(key)) return
  const features = await getPluginFeatureList(config)
  // No answer at all (the Host couldn't be read): nothing is remembered, so it is asked again.
  if (!features) return
  answered.set(new Map(answered.get()).set(key, features))
}

function answer(known: readonly string[] | undefined, feature: string): PluginFeatureAnswer {
  if (known === undefined) return "unknown"
  return known.includes(feature) ? "yes" : "no"
}

/**
 * What the Bot's plugin answered about each feature in `features` — one read of its list answers
 * them all, for a caller that asks about one at a time or hands over a whole registry. A connection
 * with no answer yet is `unknown` for every feature rather than `no` for each.
 */
export function usePluginFeatureAnswers<K extends string>(
  server: Server,
  features: Record<K, string>,
): Record<K, PluginFeatureAnswer> {
  const config = serverConfig(server)
  const { baseUrl, apiKey } = config
  const key = baseUrl && apiKey ? connectionKey(config) : ""
  const known = answered.use().get(key)
  usePoll(() => void readFeatures(config), false, [baseUrl, apiKey], {
    active: Boolean(key),
    onShow: false,
  })
  return Object.fromEntries(
    (Object.keys(features) as K[]).map((name) => [name, answer(known, features[name])]),
  ) as Record<K, PluginFeatureAnswer>
}

/** One of those features, for a control that needs just the one. */
export function usePluginFeature(server: Server, feature: string): PluginFeatureAnswer {
  return usePluginFeatureAnswers(server, { [feature]: feature })[feature]
}

/** That feature as a switch: true only for an answer that carries it, false while it's unknown. */
export function usePluginFeatureOn(server: Server, feature: string): boolean {
  return usePluginFeature(server, feature) === "yes"
}
