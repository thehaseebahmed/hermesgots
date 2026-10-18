/**
 * A bot's MCP servers, read from its Host's Gots plugin (`GET <plugin>/mcp`), with nothing kept on
 * the device. The screen reads once on open and again only while a server is in a state that moves
 * on its own — connecting, or waiting on Server access — and `setEnabled` switches one on or off
 * through the plugin, replacing that row with the state the change landed in. The row and the screen
 * exist only where the plugin advertises the feature, so a Bot whose Hermes is behind has neither
 * and is sent back to its editor, while a Bot whose Host hasn't answered yet is left to answer
 * rather than flashing its screen away. A plugin without the route is left alone like every other
 * optional one.
 */
import { useCallback, useState, useSyncExternalStore } from "react"

import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { MCP_WORK_MS } from "@/lib/freshness"
import {
  getPluginFeatureList,
  listMcpServers,
  setMcpServerEnabled,
  type HermesConfig,
  type McpServer,
  type McpState,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { noteFailure } from "@/lib/report"
import { createSignal } from "@/lib/store"

/** The feature the plugin advertises when its Hermes can list a profile's MCP servers. */
const FEATURE = "mcps"

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

// The connections whose plugin has answered, and what it said; only a real answer is remembered, so
// a Host that was away is asked again the next time its editor is opened.
const answered = new Map<string, "yes" | "no">()
const { subscribe, notify } = createSignal()

async function readFeature(config: HermesConfig) {
  const key = connectionKey(config)
  if (answered.has(key)) return
  const features = await getPluginFeatureList(config)
  // No answer at all (the Host couldn't be read): nothing is remembered, so it is asked again.
  if (!features) return
  answered.set(key, features.includes(FEATURE) ? "yes" : "no")
  notify()
}

/**
 * What a Bot's plugin answered about listing its MCP servers: `yes` it advertises the feature, `no`
 * it answered without it (a Hermes that can't list them at all), and `unknown` while there is no
 * answer yet — which is nothing to act on rather than a Bot without the feature.
 */
export type McpFeatureAnswer = "unknown" | "yes" | "no"

/** What this Bot's plugin answered about its MCP servers (see `McpFeatureAnswer`). */
export function useMcpFeatureAnswer(server: McpServerConfig): McpFeatureAnswer {
  const key = server?.baseUrl && server?.apiKey ? connectionKey(server) : ""
  const baseUrl = server?.baseUrl ?? ""
  const apiKey = server?.apiKey ?? ""
  const answer = useSyncExternalStore(subscribe, () => (key && answered.get(key)) || "unknown")
  usePoll(() => void readFeature({ baseUrl, apiKey }), false, [baseUrl, apiKey], {
    active: Boolean(key),
    onShow: false,
  })
  return answer
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
 * server on or off on the Host and replaces its row with the state the change landed in; a write
 * that fails is thrown for the screen to report, leaving the row as it was.
 */
export function useMcpServers(server: McpServerConfig, active: boolean) {
  const [servers, setServers] = useState<McpServer[] | undefined>(undefined)
  const baseUrl = server?.baseUrl ?? ""
  const apiKey = server?.apiKey ?? ""
  const config = { baseUrl, apiKey }
  const key = baseUrl && apiKey ? connectionKey(config) : ""
  usePoll(
    (signal) => {
      if (unsupported.cooling(key)) return
      listMcpServers(config, signal)
        .then((next) => {
          if (signal.aborted) return
          unsupported.clear(key)
          setServers(next)
        })
        .catch((error: unknown) => {
          if (signal.aborted) return
          // An older plugin has no route to read: nothing is shown, and it is asked again later.
          void lacksRoute(config, error, FEATURE).then((missing) => {
            if (missing) return unsupported.start(key)
            noteFailure("Reading the bot's MCP servers", error)
          })
        })
    },
    keepsReading(servers) ? MCP_WORK_MS : false,
    [key],
    { active: active && Boolean(key) },
  )
  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      const row = await setMcpServerEnabled({ baseUrl, apiKey }, name, enabled)
      setServers((current) => current?.map((server) => (server.name === row.name ? row : server)))
    },
    [baseUrl, apiKey],
  )
  return { servers, setEnabled }
}
