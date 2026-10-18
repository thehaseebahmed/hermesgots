/**
 * A bot's MCP servers, read from its Host's Gots plugin (`GET <plugin>/mcp`), with nothing kept on
 * the device. The screen reads once on open and again only while a server is in a state that moves
 * on its own — connecting, or waiting on Server access — and `setEnabled` switches one on or off
 * through the plugin, replacing that row with the state the change landed in, while `remove` takes
 * one away and replaces the whole list with what the Host says is left. `useMcpCatalogue` is the
 * browsing half of adding one: the entries the Host's Hermes offers, read once each time it is
 * opened, marking the ones this Bot already has and adding nothing. The row and the screen
 * exist only where the plugin advertises the feature, and a row's switch, its removal and the Add
 * action only where it advertises that it can write, so a Bot whose Hermes is behind has neither and
 * is sent back to its editor, while a Bot whose Host hasn't answered yet is left to answer rather
 * than flashing its screen away. A plugin without the route is left alone like every other optional
 * one.
 */
import { useCallback, useState, useSyncExternalStore } from "react"

import { connectionKey, serverConfig } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { MCP_WORK_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import {
  getPluginFeatureList,
  listMcpCatalogue,
  listMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  type HermesConfig,
  type McpCatalogueEntry,
  type McpServer,
  type McpState,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { noteFailure } from "@/lib/report"
import { createSignal } from "@/lib/store"

/**
 * Every MCP feature this screen asks its Bot's Host about, by the key it answers under: `list` gates
 * the screen itself, and the switch, the removal and the Catalogue each have their own, because each
 * needs a different set of Hermes built-ins and a host may advertise one without another.
 */
export const MCP_FEATURES = {
  list: "mcps",
  write: "mcps_write",
  removable: "mcps_remove",
  catalogue: "mcps_catalogue",
} as const

/** What each of those features this Bot's Host answered (see `McpFeatureAnswer`). */
export type McpFeatureAnswers = Record<keyof typeof MCP_FEATURES, McpFeatureAnswer>

/** Gots' own word for each state a server can be in; Hermes's finer states collapse into these. */
export const MCP_STATE_WORDS: Record<McpState, string> = {
  on: "on",
  off: "off",
  connecting: "connecting",
  failed: "failed",
  needs_access: "needs access",
  plugin: "provided by a plugin",
}

/** A bot's server as the client takes it: one of a profile or of a Hermes plugin beside it. */
export type McpServerConfig = Pick<HermesConfig, "baseUrl" | "apiKey"> | null | undefined

/** Whether the screen must keep reading: connecting and waiting on Server access move on their own. */
function keepsReading(servers: McpServer[] | undefined) {
  return Boolean(
    servers?.some((server) => server.state === "connecting" || server.state === "needs_access"),
  )
}

/**
 * Lands one of the screen's reads in `set`, or hands its failure to `failed`. Nothing is set or
 * noted once the read was abandoned — a poll that ended, because the screen closed or the connection
 * changed, must not write over its successor's answer — and a failure leaves what the screen has, so
 * an unreachable Host doesn't take it down with it.
 */
function landRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  set: (next: T) => void,
  failed: (error: unknown) => void,
) {
  read(signal)
    .then((next) => {
      if (!signal.aborted) set(next)
    })
    .catch((error: unknown) => {
      if (!signal.aborted) failed(error)
    })
}

// The feature lists the connections' plugins answered; only a real answer is remembered, so a Host
// that was away is asked again the next time its editor is opened.
const answered = new Map<string, string[]>()
const { subscribe, notify } = createSignal()

async function readFeature(config: HermesConfig) {
  const key = connectionKey(config)
  if (answered.has(key)) return
  const features = await getPluginFeatureList(config)
  // No answer at all (the Host couldn't be read): nothing is remembered, so it is asked again.
  if (!features) return
  answered.set(key, features)
  notify()
}

/**
 * What a Bot's plugin answered about a feature: `yes` it advertises it, `no` it answered without it,
 * and `unknown` while there is no answer yet — which is nothing to act on rather than an absence.
 */
export type McpFeatureAnswer = "unknown" | "yes" | "no"

/**
 * What this Bot's plugin answered about its MCP servers: the feature each control needs — `list` for
 * the screen itself, `write` for the switch, `removable` for the removal and `catalogue` for browsing
 * Hermes's Catalogue, each needing a different set of Hermes built-ins and so advertised apart from
 * the others. One read of the plugin's features answers them all.
 */
export function useMcpFeatureAnswers(server: McpServerConfig): McpFeatureAnswers {
  const baseUrl = server?.baseUrl ?? ""
  const apiKey = server?.apiKey ?? ""
  const key = baseUrl && apiKey ? connectionKey({ baseUrl, apiKey }) : ""
  const read = (feature: string): McpFeatureAnswer => {
    const features = key ? answered.get(key) : undefined
    if (!features) return "unknown"
    return features.includes(feature) ? "yes" : "no"
  }
  const list = useSyncExternalStore(subscribe, () => read(MCP_FEATURES.list))
  const write = useSyncExternalStore(subscribe, () => read(MCP_FEATURES.write))
  const removable = useSyncExternalStore(subscribe, () => read(MCP_FEATURES.removable))
  const catalogue = useSyncExternalStore(subscribe, () => read(MCP_FEATURES.catalogue))
  usePoll(() => void readFeature({ baseUrl, apiKey }), false, [baseUrl, apiKey], {
    active: Boolean(key),
    onShow: false,
  })
  return { list, write, removable, catalogue }
}

/** What this Bot's plugin answered about its MCP servers (see `McpFeatureAnswer`). */
export function useMcpFeatureAnswer(server: McpServerConfig): McpFeatureAnswer {
  return useMcpFeatureAnswers(server).list
}

/**
 * Whether this Bot's plugin can list its MCP servers, so its row exists: true only for an answer
 * that carries the feature, false while it's unknown and for a Bot whose Hermes is too old.
 */
export function useMcpFeature(server: McpServerConfig) {
  return useMcpFeatureAnswer(server) === "yes"
}

/** Bots whose plugin has no `mcp` route (an older plugin), each left alone for a while. */
const unsupported = cooldown()

/**
 * The Bot's MCP servers, read once when the screen opens and again only while one is connecting or
 * waiting on Server access. Undefined until a read lands; a read that fails leaves what the screen
 * has, since an unreachable Host must not take the screen down with it. `setEnabled` switches one
 * server on or off on the Host and replaces its row with the state the change landed in, and
 * `remove` takes one away and replaces the list with the servers the Host says are left; a write
 * that fails is thrown for the screen to report, leaving the list as it was.
 */
export function useMcpServers(server: McpServerConfig, active: boolean) {
  const [servers, setServers] = useState<McpServer[] | undefined>(undefined)
  const config = serverConfig(server)
  const { baseUrl, apiKey } = config
  const key = baseUrl && apiKey ? connectionKey(config) : ""
  usePoll(
    (signal) => {
      if (unsupported.cooling(key)) return
      landRead(
        () => listMcpServers(config, signal),
        signal,
        (next) => {
          unsupported.clear(key)
          setServers(next)
        },
        (error) => {
          // An older plugin has no route to read: nothing is shown, and it is asked again later.
          void lacksRoute(config, error, MCP_FEATURES.list).then((missing) => {
            if (missing) return unsupported.start(key)
            noteFailure("Reading the bot's MCP servers", error)
          })
        },
      )
    },
    keepsReading(servers) ? MCP_WORK_MS : false,
    [key],
    { active: active && Boolean(key) },
  )
  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      // A host that never answers is given up on, so a row's save can't wedge the switch disabled.
      const row = await setMcpServerEnabled(
        { baseUrl, apiKey },
        name,
        enabled,
        AbortSignal.timeout(WRITE_TIMEOUT_MS),
      )
      setServers((current) => current?.map((server) => (server.name === row.name ? row : server)))
    },
    [baseUrl, apiKey],
  )
  const remove = useCallback(
    async (name: string) => {
      // The Host's own answer is what the list becomes, so a row that went and one that moved with
      // it cannot disagree with the Bot's servers.
      const left = await removeMcpServer(
        { baseUrl, apiKey },
        name,
        AbortSignal.timeout(WRITE_TIMEOUT_MS),
      )
      setServers(left)
    },
    [baseUrl, apiKey],
  )
  return { servers, setEnabled, remove }
}

/**
 * Hermes's Catalogue as this Bot's Host offers it, read when the Catalogue is opened and again each
 * time it is opened: the entries Hermes offers, each marked with whether this Bot already has it.
 * Undefined until a read lands, and left as it was if one fails — an unreachable Host must not take
 * the sheet down with it. Nothing is added and nothing is polled: the Catalogue is a read of what
 * could be added, so nothing in it moves on its own.
 */
export function useMcpCatalogue(server: McpServerConfig, active: boolean) {
  const [entries, setEntries] = useState<McpCatalogueEntry[] | undefined>(undefined)
  const config = serverConfig(server)
  const key = config.baseUrl && config.apiKey ? connectionKey(config) : ""
  usePoll(
    (signal) => {
      landRead(
        () => listMcpCatalogue(config, signal),
        signal,
        setEntries,
        (error) => noteFailure("Reading the catalogue", error),
      )
    },
    false,
    [key],
    // Opening it is the whole trigger: the once-a-read is not repeated for the page coming back.
    { active: active && Boolean(key), onShow: false },
  )
  return entries
}
