/**
 * What a Bot's Host answered about the Gots plugin's features (`info`'s `features`) and the profiles
 * its connection seats in a room (`info`'s `rooms`), for every screen that gates a control on one or
 * offers a bot as a seat. An answer is remembered for its connection, so a screen opened again
 * doesn't wait on the same read; only a real answer is kept, so a Host that was away is asked again
 * the next time a screen needs it.
 */
import { connectionKey, serverConfig } from "@/lib/connection"
import { forgetPluginAnswer, getPluginAnswer, type HermesConfig, type PluginInfo } from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { createStore } from "@/lib/store"

/**
 * What a Bot's plugin answered about a feature: `yes` it advertises it, `no` it answered without
 * it, and `unknown` while there is no answer yet — which is nothing to act on rather than an
 * absence.
 */
export type PluginFeatureAnswer = "unknown" | "yes" | "no"

/** A bot's server as these hooks take it: a profile, or a plugin beside one, or nothing yet. */
export type PluginServer = Pick<HermesConfig, "baseUrl" | "apiKey"> | null | undefined

// What each connection's plugin answered, whole: its feature names and the profiles it may seat in
// a room (ADR 0128). Only an answer that names something is remembered, and the map is replaced
// rather than mutated so a subscriber is handed a new value.
const answered = createStore<ReadonlyMap<string, PluginInfo>>(new Map())

/**
 * The read each connection is on. A refresh bumps this, so a read that began before the refresh and
 * lands after it writes nothing: it answers the question the refresh replaced, and pinning it would
 * short-circuit every later read (ADR 0128).
 */
const generations = new Map<string, number>()
const generationOf = (key: string) => generations.get(key) ?? 0

/**
 * An answer worth keeping: one that names its features or the profiles it seats. A Host that names
 * neither said nothing, and saying it again must not become final — an older Host answers no
 * features, and a roster on its own is still a real answer (ADR 0128).
 */
const worthKeeping = (info: PluginInfo) =>
  info.features !== null || info.rooms.seatable !== null

async function readAnswer(config: HermesConfig, reread = false) {
  const key = connectionKey(config)
  if (!reread && answered.get().has(key)) return
  const generation = generationOf(key)
  const info = await getPluginAnswer(config)
  // No answer at all (the Host couldn't be read): nothing is remembered, so it is asked again.
  if (!info || !worthKeeping(info)) return
  if (generation !== generationOf(key)) return
  answered.set(new Map(answered.get()).set(key, info))
}

/**
 * Reads a connection's `info` again and replaces what was remembered with what it answers, keeping
 * the old answer until the new one lands (ADR 0128). A create the Host refused is the one word on
 * whether a connection seats a profile, so the answer it contradicts is asked again — but a screen
 * that lost the answer in between would draw a Host that can make no room and take away the rows
 * the refusal's own sentence tells the user to unpick.
 */
export function refreshAnswer(server: PluginServer) {
  const config = serverConfig(server)
  const key = connectionKey(config)
  // The memo half goes, whatever the order it was filled in: left behind, it would answer this read
  // with the roster the Host just refused.
  forgetPluginAnswer(config)
  generations.set(key, generationOf(key) + 1)
  void readAnswer(config, true)
}

function answer(known: PluginInfo | undefined, feature: string): PluginFeatureAnswer {
  // An answer that names no features says nothing about any of them, as no answer would.
  if (!known?.features) return "unknown"
  return known.features.includes(feature) ? "yes" : "no"
}

/**
 * What one connection answered, in one place: the guard on the key, the remembered value and the
 * poll that asks for it, so every question about a connection reads that one answer.
 */
function useConnectionAnswer(server: PluginServer): PluginInfo | undefined {
  const config = serverConfig(server)
  const { baseUrl, apiKey } = config
  const key = baseUrl && apiKey ? connectionKey(config) : ""
  const known = answered.use().get(key)
  usePoll(() => void readAnswer(config), false, [baseUrl, apiKey], {
    active: Boolean(key),
    onShow: false,
  })
  return known
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
  const known = useConnectionAnswer(server)
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
  const known = useConnectionAnswer(server)
  return known === undefined ? undefined : known.rooms.seatable
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
