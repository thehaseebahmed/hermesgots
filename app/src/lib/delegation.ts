import type { ModelChoice } from "@/lib/db"
import { getDelegationModel, setDelegationModel } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"

const DELEGATION: HostRoute<ModelChoice | undefined> = {
  feature: "delegation_model",
  label: "the delegation model",
  read: async (server, signal) => (await getDelegationModel(server, signal)) ?? undefined,
  write: async (server, pick, signal) =>
    (await setDelegationModel(server, pick ?? null, signal)) ?? undefined,
}

export function useDelegationModel(profile?: { baseUrl: string; apiKey: string } | null) {
  const { value: pick, supported, saving, save } = useHostRecord(profile, DELEGATION, undefined)
  return { pick, supported, saving, save }
}
