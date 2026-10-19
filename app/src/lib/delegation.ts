import type { ModelChoice } from "@/lib/db"
import { getDelegationModel, setDelegationModel } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"

/** A bot's pick, or none at all: its host holds a model, or a delegated task inherits the bot's. */
type Pick = ModelChoice | undefined

/**
 * The host's own delegation model (Hermes's `delegation.model` and `delegation.provider`), which
 * every task the bot delegates runs on. The route answers `null` for a bot that inherits its own.
 */
const DELEGATION: HostRoute<Pick> = {
  feature: "delegation_model",
  what: "the delegation model",
  read: async (server, signal) => (await getDelegationModel(server, signal)) ?? undefined,
  write: async (server, pick, signal) =>
    (await setDelegationModel(server, pick ?? null, signal)) ?? undefined,
}

/**
 * The model a bot's delegated tasks run on, read from its host once the plugin says it has the
 * route. `pick` is the model to show, `saving` whether a write is on its way there, and clearing it
 * (undefined) puts every task back on the bot's own model.
 */
export function useDelegationModel(profile?: { baseUrl: string; apiKey: string } | null) {
  const { value: pick, supported, saving, save } = useHostRecord(profile, DELEGATION, undefined)
  return { pick, supported, saving, save }
}
