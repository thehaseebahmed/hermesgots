import type { ModelChoice } from "@/lib/db"
import { getDelegationModel, setDelegationModel } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"

interface Delegation {
  pick?: ModelChoice
  custom?: boolean
}

export const DELEGATION: HostRoute<Delegation> = {
  feature: "delegation_model",
  label: "the delegation model",
  read: async (server, signal) => {
    const { pick, custom } = await getDelegationModel(server, signal)
    return { pick: pick ?? undefined, custom }
  },
  write: async (server, { pick }, signal) => ({
    pick: (await setDelegationModel(server, pick ?? null, signal)) ?? undefined,
  }),
}

export function useDelegationModel(profile?: { baseUrl: string; apiKey: string } | null) {
  const { value, supported, saving, save } = useHostRecord<Delegation>(profile, DELEGATION, {})
  return {
    pick: value.pick,
    custom: value.custom === true,
    supported,
    saving,
    save: (pick: ModelChoice | undefined) => save({ pick }),
  }
}
