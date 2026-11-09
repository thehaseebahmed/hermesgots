import { useEffect, useState } from "react"

import type { ModelChoice, Profile } from "@/lib/db"
import { getResearchWriters, getTriageModel, setTriageModel } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"
import { noteFailure } from "@/lib/report"
import { useThreadSwitches } from "@/lib/threads"

const TRIAGE: HostRoute<ModelChoice | undefined> = {
  feature: "triage_model",
  label: "the triage model",
  read: async (server, signal) => (await getTriageModel(server, signal)) ?? undefined,
  write: async (server, pick, signal) =>
    (await setTriageModel(server, pick ?? null, signal)) ?? undefined,
}

/**
 * A bot's triage model as its settings draw it: the pick its host holds, and whether the field draws
 * at all — with chat threads off it is a setting nowhere, so the host is not asked for anything and
 * its stored pick is read again the moment the switch is on (ADR 0120). A settings read that hasn't
 * answered counts as off: the safe direction.
 */
export function useTriageModel(profile?: Pick<Profile, "baseUrl" | "apiKey"> | null) {
  const draws = useThreadSwitches()?.chatThreads ?? false
  const {
    value: pick,
    supported: hostHasRoute,
    saving,
    save,
  } = useHostRecord(draws ? profile : null, TRIAGE, undefined)
  const [withheld, setWithheld] = useState(false)
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const supported = draws && hostHasRoute
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void getResearchWriters({ baseUrl, apiKey })
      .then((writers) => !cancelled && setWithheld(!(writers.model && writers.provider)))
      .catch((error: unknown) => noteFailure("Reading the host's model permission", error))
    return () => {
      cancelled = true
    }
  }, [supported, baseUrl, apiKey])
  return { pick, supported, saving, save, withheld }
}
