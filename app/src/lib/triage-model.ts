import { useEffect, useState } from "react"

import type { ModelChoice } from "@/lib/db"
import { getTriageModel, getTriageWriters, setTriageModel } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"
import { noteFailure } from "@/lib/report"

const TRIAGE: HostRoute<ModelChoice | undefined> = {
  feature: "triage_model",
  label: "the triage model",
  read: async (server, signal) => (await getTriageModel(server, signal)) ?? undefined,
  write: async (server, pick, signal) =>
    (await setTriageModel(server, pick ?? null, signal)) ?? undefined,
}

export function useTriageModel(profile?: { baseUrl: string; apiKey: string } | null) {
  const { value: pick, supported, saving, save } = useHostRecord(profile, TRIAGE, undefined)
  const [withheld, setWithheld] = useState(false)
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void getTriageWriters({ baseUrl, apiKey })
      .then((allowed) => !cancelled && setWithheld(!allowed))
      .catch((error: unknown) => noteFailure("Reading the host's model permission", error))
    return () => {
      cancelled = true
    }
  }, [supported, baseUrl, apiKey])
  return { pick, supported, saving, save, withheld }
}
