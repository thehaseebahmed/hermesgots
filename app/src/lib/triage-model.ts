import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getSettings, type ModelChoice } from "@/lib/db"
import { getResearchWriters, getTriageModel, setTriageModel } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"
import { noteFailure } from "@/lib/report"
import { opensInMain } from "@/lib/threads"

const TRIAGE: HostRoute<ModelChoice | undefined> = {
  feature: "triage_model",
  label: "the triage model",
  read: async (server, signal) => (await getTriageModel(server, signal)) ?? undefined,
  write: async (server, pick, signal) =>
    (await setTriageModel(server, pick ?? null, signal)) ?? undefined,
}

/**
 * A bot's triage model, as its settings draw it: the pick its host holds, and whether the field
 * draws at all. That second answer is the switch's as much as the host's — with chat threads off in
 * the bot layout the triage model is a setting nowhere (ADR 0120), so `supported` is false and the
 * host is not asked for its features, its route or the pick, nor for the permission the row warns
 * about. Nothing is deleted: the moment the switch is on, the host's stored pick is read again and
 * the field stands where it did.
 *
 * A settings read that hasn't answered counts as off — the safe direction, since a moment without
 * the row is better than one with it.
 */
export function useTriageModel(profile?: { baseUrl: string; apiKey: string } | null) {
  // Read live, so a flip of the switch gives the field back without a reload.
  const draws = useLiveQuery(async () => !opensInMain(await getSettings()), []) === true
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
