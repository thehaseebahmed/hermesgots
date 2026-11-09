/**
 * What a Bot's Host answered about the Gots plugin's features (`info`'s `features`) and the profiles
 * its connection seats in a room (`info`'s `rooms`), for every screen that gates a control on one or
 * offers a bot as a seat. An answer is remembered for its connection, so a screen opened again
 * doesn't wait on the same read; only a real answer is kept, so a Host that was away is asked again
 * the next time a screen needs it.
 */
import { connectionKey, serverConfig } from "@/lib/connection"
import { getPluginAnswer, type HermesConfig } from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { createStore } from "@/lib/store"

/**
 * What a Bot's plugin answered about a feature: `yes` it advertises it, `no` it answered without
 * it, and `unknown` while there is no answer yet — which is nothing to act on rather than an
 * absence.
 */
export type PluginFeatureAnswer = "unknown" | "yes" | "no"

/** A bot's server as a read of its features takes it. */
/** A bot's server as these hooks take it: a profile, or a plugin beside one, or nothing yet. */
export type PluginServer = Pick<HermesConfig, "baseUrl" | "apiKey"> | null | undefined

/**
 * One connection's `info` answer, as this module remembers it: the feature names, and the profiles
 * the connection may seat in a room — null where the Host named none (ADR 0128).
 */
type ConnectionAnswer = {
  features: readonly string[]
  seatable: string[] | null
}

// What each connection's plugin answered; only a real answer is remembered, and the map is replaced
// rather than mutated so a subscriber is handed a new value.
const answered = createStore<ReadonlyMap<string, ConnectionAnswer>>(new Map())

async function readAnswer(config: HermesConfig) {
  const key = connectionKey(config)
  if (answered.get().has(key)) return
  const info = await getPluginAnswer(config)
  // No answer at all (the Host couldn't be read): nothing is remembered, so it is asked again.
  if (!info?.features) return
  answered.set(
    new Map(answered.get()).set(key, { features: info.features, seatable: info.rooms.seatable }),
  )
}

function answer(known: ConnectionAnswer | undefined, feature: string): PluginFeatureAnswer {
  if (known === undefined) return "unknown"
  return known.features.includes(feature) ? "yes" : "no"
}

/**
 * What the Bot's plugin answered about each feature in `features` — one read of its list answers
 * them all, for a caller that asks about one at a time or hands over a whole registry. A connection
 * with no answer yet is `unknown` for every feature rather than `no` for each.
 */
export function usePluginFeatureAnswers<K extends string>(
  server: PluginServer,
  features: Record<K, string>,
): Record<K, PluginFeatureAnswer> {
  const config = serverConfig(server)
  const { baseUrl, apiKey } = config
  const key = baseUrl && apiKey ? connectionKey(config) : ""
  const known = answered.use().get(key)
  usePoll(() => void readAnswer(config), false, [baseUrl, apiKey], {
    active: Boolean(key),
    onShow: false,
  })
  return Object.fromEntries(
    (Object.keys(features) as K[]).map((name) => [name, answer(known, features[name])]),
  ) as Record<K, PluginFeatureAnswer>
}

/** One of those features, for a control that needs just the one. */
export function usePluginFeature(server: PluginServer, feature: string): PluginFeatureAnswer {
  return usePluginFeatureAnswers(server, { [feature]: feature })[feature]
}

/** That feature as a switch: true only for an answer that carries it, false while it's unknown. */
export function usePluginFeatureOn(server: PluginServer, feature: string): boolean {
  return usePluginFeature(server, feature) === "yes"
}

/**
 * The profiles a bot's connection may seat in a room (`info`'s `rooms.seatable`), or **null** where
 * its Host named none — an older Host, whose picker filters nothing — and **undefined** while the
 * read is still owed, so no bot is held out before the answer lands (ADR 0128). It rides the same
 * remembered answer as the features, keyed by the same connection: one read answers both.
 */
export function useRoomSeatable(server: PluginServer): string[] | null | undefined {
  const config = serverConfig(server)
  const { baseUrl, apiKey } = config
  const key = baseUrl && apiKey ? connectionKey(config) : ""
  const known = answered.use().get(key)
  usePoll(() => void readAnswer(config), false, [baseUrl, apiKey], {
    active: Boolean(key),
    onShow: false,
  })
  return known?.seatable
}

/**
 * One feature across several bots' servers, keyed by connection: every connection the device holds is
 * asked, because a control about something no bot owns — the app's New room is every Host's, not one
 * bot's (ADR 0115) — has to know which Host answers it. A hook cannot be called in a loop, so this is
 * the one place that read is made for a set.
 */
export function usePluginFeatureByServer(
  servers: PluginServer[],
  feature: string,
): Record<string, PluginFeatureAnswer> {
  const configs = servers.map((server) => serverConfig(server))
  const held = answered.use()
  const keys = configs.map((config) => (config.baseUrl && config.apiKey ? connectionKey(config) : ""))
  const live = keys.filter(Boolean)
  usePoll(
    () => {
      for (const config of configs) if (config.baseUrl && config.apiKey) void readAnswer(config)
    },
    false,
    [live.join(" ")],
    { active: live.length > 0, onShow: false },
  )
  const answers: Record<string, PluginFeatureAnswer> = {}
  for (const key of keys) if (key) answers[key] = answer(held.get(key), feature)
  return answers
}
