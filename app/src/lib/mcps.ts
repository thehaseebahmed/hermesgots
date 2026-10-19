/**
 * A bot's MCP servers, read from its Host's Gots plugin (`GET <plugin>/mcp`), with nothing kept on
 * the device. The screen reads once on open and again only while a server is in a state that moves
 * on its own — connecting, or waiting on Server access — and `setEnabled` switches one on or off
 * through the plugin, replacing that row with the state the change landed in, while `remove` takes
 * one away and `install` adds one from the Catalogue, each replacing the whole list with what the
 * Host says the bot has after it. The adding half is its own pair of reads: `useMcpCatalogue` is the
 * entries the Host's Hermes offers, each marked with whether this Bot already has it, and
 * `useMcpCatalogueEntry` is one of them with the values it declares, read when its form is opened.
 * The row and the screen exist only where the plugin advertises the feature, a row's switch, its
 * removal and the Add action each only where the plugin advertises that one — the switch's
 * `mcps_write`, the removal's `mcps_remove`, and the Add action and the form behind it only where
 * both `mcps_catalogue` and `mcps_add` are advertised, since the action's whole work is the adding —
 * so a Bot whose Hermes is behind loses exactly the control it couldn't use, while a Bot whose Host
 * hasn't answered yet is left to answer rather than flashing its screen away. A plugin without the
 * route is left alone like every other optional one.
 */
import { useCallback, useRef, useState } from "react"

import { connectionKey, serverConfig } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import {
  usePluginFeatureAnswers,
  type PluginFeatureAnswer,
  type PluginServer,
} from "@/lib/features"
import {
  MCP_ACCESS_MS,
  MCP_INSTALL_MS,
  MCP_SAVE_MS,
  MCP_TOOLS_MS,
  MCP_WORK_MS,
  READ_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
} from "@/lib/freshness"
import {
  addCustomMcpServer,
  deliverMcpAccess,
  getMcpCatalogueEntry,
  getMcpServer,
  installMcpServer,
  listMcpCatalogue,
  listMcpServers,
  listMcpServerTools,
  probeMcpServerTools,
  removeMcpServer,
  saveMcpServer,
  setMcpServerEnabled,
  startMcpAccess,
  type McpAccess,
  type McpCatalogueEntry,
  type McpCustomServer,
  type McpServer,
  type McpServerEdit,
  type McpTools,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { noteFailure } from "@/lib/report"

/**
 * Every MCP feature this screen asks its Bot's Host about, by the key it answers under: `list` gates
 * the screen itself, and the switch, the removal, the Catalogue and adding from it each have their
 * own, because each needs a different set of Hermes built-ins and a host may advertise one without
 * another.
 */
export const MCP_FEATURES = {
  list: "mcps",
  write: "mcps_write",
  removable: "mcps_remove",
  catalogue: "mcps_catalogue",
  add: "mcps_add",
  access: "mcps_access",
  config: "mcps_config",
  tools: "mcps_tools",
} as const

/** What each of those features this Bot's Host answered (see `McpFeatureAnswer`). */
export type McpFeatureAnswers = Record<keyof typeof MCP_FEATURES, McpFeatureAnswer>

/** A bot's server as the client takes it: the shape every feature hook already names. */
export type McpServerConfig = PluginServer

/**
 * Whether the screen must keep reading: a server the Host is still starting gets there on its own.
 * A server waiting on Server access is steady — nothing moves it but the user — so the screen reads
 * it once, and again only while a flow for it is open (`watching`).
 */
function keepsReading(servers: McpServer[] | undefined) {
  return Boolean(servers?.some((server) => server.state === "connecting"))
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

/** What a Bot's plugin answered about one of those (see `PluginFeatureAnswer`). */
export type McpFeatureAnswer = PluginFeatureAnswer

/**
 * What this Bot's plugin answered about its MCP servers: the feature each control needs — `list` for
 * the screen itself, `write` for the switch, `removable` for the removal, `catalogue` for browsing
 * Hermes's Catalogue and `add` for adding one from it, each needing a different set of Hermes
 * built-ins and so advertised apart from the others. One read of the plugin's features answers them
 * all.
 */
export function useMcpFeatureAnswers(server: McpServerConfig): McpFeatureAnswers {
  return usePluginFeatureAnswers(server, MCP_FEATURES)
}

/** Bots whose plugin has no `mcp` route (an older plugin), each left alone for a while. */
const unsupported = cooldown()

/**
 * The Bot's MCP servers, read once when the screen opens and again only while one is connecting, or
 * while `watching` says the Server access sheet the screen opened is still waiting on one. Undefined until a read lands; a read that fails leaves what the screen
 * has, since an unreachable Host must not take the screen down with it. `setEnabled` switches one
 * server on or off on the Host and replaces its row with the state the change landed in, while
 * `remove` takes one away and `install` adds one from the Catalogue, each replacing the list with the
 * servers the Host says the bot has; a write that fails is thrown for the screen to report, leaving
 * the list as it was.
 */
export function useMcpServers(server: McpServerConfig, active: boolean, watching = false) {
  const [servers, setServers] = useState<McpServer[] | undefined>(undefined)
  // The interval changes with what the screen is doing, and `usePoll` reads at once when its
  // interval changes — so a sheet opening or closing would re-read a list that is a second old.
  const readAt = useRef(0)
  const config = serverConfig(server)
  const { baseUrl, apiKey } = config
  const key = baseUrl && apiKey ? connectionKey(config) : ""
  usePoll(
    (signal) => {
      if (unsupported.cooling(key)) return
      if (Date.now() - readAt.current < MCP_WORK_MS / 2) return
      landRead(
        () => listMcpServers(config, signal),
        signal,
        (next) => {
          unsupported.clear(key)
          readAt.current = Date.now()
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
    keepsReading(servers) || watching ? MCP_WORK_MS : false,
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
  const install = useCallback(
    async (name: string, values: Record<string, string>) => {
      // Adding one may clone and install the entry's own repository, so it is given longer than a
      // switch's write is; the Host's own answer is what the list becomes, as it is after a removal.
      const left = await installMcpServer(
        { baseUrl, apiKey },
        name,
        values,
        AbortSignal.timeout(MCP_INSTALL_MS),
      )
      setServers(left)
    },
    [baseUrl, apiKey],
  )
  const reload = useCallback(async () => {
    // The screen's own poll follows a connecting or waiting server, and a *failed* row that a flow
    // is running for is neither — so the sheet that waits on one asks for the list itself, rather
    // than leaving the row's read to whatever the screen does next.
    try {
      const next = await listMcpServers({ baseUrl, apiKey }, AbortSignal.timeout(READ_TIMEOUT_MS))
      unsupported.clear(key)
      setServers(next)
    } catch (error) {
      noteFailure("Reading the bot's MCP servers", error)
    }
  }, [baseUrl, apiKey, key])
  const saveConfig = useCallback(
    async (name: string, edit: McpServerEdit) => {
      // A block save is a config write and the Host's reconcile, which can back off, so it is given
      // what an add is rather than a switch's write; the Host's own answer is what the list becomes.
      const { servers: left, detail } = await saveMcpServer(
        { baseUrl, apiKey },
        name,
        edit,
        AbortSignal.timeout(MCP_SAVE_MS),
      )
      setServers(left)
      return detail
    },
    [baseUrl, apiKey],
  )
  const addCustom = useCallback(
    async (server: McpCustomServer) => {
      const left = await addCustomMcpServer(
        { baseUrl, apiKey },
        server,
        AbortSignal.timeout(MCP_SAVE_MS),
      )
      setServers(left)
    },
    [baseUrl, apiKey],
  )
  const grant = useCallback(
    async (name: string, abandoned?: AbortSignal): Promise<McpAccess> =>
      // The Host discovers the provider and waits for its authorization URL before answering, which
      // is longer than a write: a start that never produces one is given up on rather than hanging —
      // as is one whose sheet was dismissed while it was starting.
      startMcpAccess(
        { baseUrl, apiKey },
        name,
        abandoned
          ? AbortSignal.any([abandoned, AbortSignal.timeout(MCP_ACCESS_MS)])
          : AbortSignal.timeout(MCP_ACCESS_MS),
      ),
    [baseUrl, apiKey],
  )
  const deliver = useCallback(
    async (name: string, url: string) => {
      await deliverMcpAccess({ baseUrl, apiKey }, name, url, AbortSignal.timeout(WRITE_TIMEOUT_MS))
    },
    [baseUrl, apiKey],
  )
  return { servers, setEnabled, remove, install, saveConfig, addCustom, grant, deliver, reload }
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

/**
 * One server's own block, read when its sheet opens and again each time it is opened: what its
 * Config tab is built from. `detail` is undefined until a read lands, and `failedFor` says the read
 * that was meant to answer it came back an error, so the tab can say so rather than standing there
 * as an empty stub. An answer for a different server is never handed back, and nothing is written by
 * reading this.
 */
/**
 * One named thing read while its sheet is open — the shape both a server's block and a catalogue
 * entry's values take: opening the sheet is the whole trigger, the read is bounded by
 * `READ_TIMEOUT_MS` (a Host that accepted the connection and went quiet can't hold the sheet), an
 * answer for a different name is never handed back, and `reload` asks again after a flow wrote it.
 */
function useReadOnOpen<T extends { name: string }>(
  server: McpServerConfig,
  name: string | undefined,
  active: boolean,
  read: (
    config: { baseUrl: string; apiKey: string },
    name: string,
    signal: AbortSignal,
  ) => Promise<T | undefined>,
  noting: string,
) {
  const [value, setValue] = useState<T | undefined>(undefined)
  const [failedFor, setFailedFor] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const config = serverConfig(server)
  const key = config.baseUrl && config.apiKey ? connectionKey(config) : ""
  usePoll(
    (signal) => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
      landRead(
        () => read({ baseUrl: config.baseUrl, apiKey: config.apiKey }, name ?? "", bounded),
        bounded,
        (found) => {
          setValue(found)
          setFailedFor(undefined)
        },
        (error) => {
          setFailedFor(name)
          noteFailure(noting, error)
        },
      )
    },
    false,
    [key, name, attempt],
    { active: active && Boolean(key) && Boolean(name), onShow: false },
  )
  return {
    value: name !== undefined && value?.name === name ? value : undefined,
    failed: name !== undefined && failedFor === name,
    reload: () => setAttempt((count) => count + 1),
  }
}

/**
 * One server's block: what the Config tab is built from, read when its sheet opens. Undefined until
 * a read lands; `failed` says the read came back an error, so the tab can say so rather than
 * standing there as an empty stub. Nothing is written by reading this.
 */
export function useMcpServerDetail(
  server: McpServerConfig,
  name: string | undefined,
  active: boolean,
) {
  const { value, failed, reload } = useReadOnOpen(
    server,
    name,
    active,
    getMcpServer,
    "Reading a server's configuration",
  )
  return { detail: value, failed, reload }
}

/**
 * One catalogue entry with the values it declares: what the entry's form is built from, read when
 * the form opens. Nothing is added by reading this.
 */
export function useMcpCatalogueEntry(
  server: McpServerConfig,
  name: string | undefined,
  active: boolean,
) {
  const { value, failed } = useReadOnOpen(
    server,
    name,
    active,
    getMcpCatalogueEntry,
    "Reading a catalogue entry",
  )
  return { entry: value, failed }
}

/**
 * One server's tools: Hermes's own schema cache when the sheet opens — so opening it never connects
 * anything — and `probe` for the tap that asks the server itself, given `MCP_TOOLS_MS` because the
 * Host connects it once, lists what it offers and disconnects. An undefined answer means no read has
 * landed yet; a cache miss is an empty list with `cached` false rather than an error.
 */
export function useMcpServerTools(
  server: McpServerConfig,
  name: string | undefined,
  active: boolean,
) {
  const [found, setFound] = useState<McpTools | undefined>(undefined)
  const [unread, setUnread] = useState(false)
  const [probing, setProbing] = useState(false)
  // The Host's own sentence for a probe it refused: the one tap that reaches the server says why,
  // rather than leaving a button that looks like nothing happened.
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const config = serverConfig(server)
  const key = config.baseUrl && config.apiKey ? connectionKey(config) : ""
  usePoll(
    (signal) => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
      landRead(
        () => listMcpServerTools(config, name ?? "", bounded),
        bounded,
        (tools) => {
          setFound(tools)
          setUnread(false)
        },
        (error) => {
          setUnread(true)
          noteFailure("Reading a server's tools", error)
        },
      )
    },
    false,
    [key, name],
    { active: active && Boolean(key) && Boolean(name), onShow: false },
  )
  const probe = useCallback(async () => {
    if (!name) return
    setProbing(true)
    setFailed(undefined)
    try {
      setUnread(false)
      setFound(
        await probeMcpServerTools(
          { baseUrl: config.baseUrl, apiKey: config.apiKey },
          name,
          AbortSignal.timeout(MCP_TOOLS_MS),
        ),
      )
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "Couldn't load those.")
    } finally {
      setProbing(false)
    }
  }, [config.baseUrl, config.apiKey, name])
  return {
    tools: found,
    probing,
    // The read that answers the tab before anything is tapped, and the probe's own sentence: both
    // said, so an empty tab never reads as one still loading.
    failed: failed ?? (unread ? "Couldn't read this server's tools." : undefined),
    probe,
  }
}
