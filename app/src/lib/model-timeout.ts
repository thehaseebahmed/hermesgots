import { DEFAULT_MODEL_TIMEOUT_S, getModelTimeout, setModelTimeout } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"

/**
 * A bot's model-call timeout, held on its host (`model_timeout.py`): the longest a research or
 * meeting model call may take before the host gives up on it. A host setting, so it is not a device
 * flag: the calls it bounds run on the host, with the app closed. The feature is the host's own, so
 * a plugin older than it offers no row.
 */
export const MODEL_TIMEOUT: HostRoute<number> = {
  feature: "model_timeout",
  label: "the model call timeout",
  read: (server, signal) => getModelTimeout(server, signal),
  write: (server, seconds, signal) => setModelTimeout(server, seconds, signal),
}

/** The values a pick offers, in seconds. The host takes any whole number it allows; a value it
 * holds that isn't here is drawn beside these rather than hidden. */
export const TIMEOUT_CHOICES = [60, 120, 180, 300, 600] as const

/** A timeout as a reader says it: whole minutes as minutes, anything else in seconds. */
export function timeoutLabel(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`
}

/** The choices to draw for what the host holds: the presets, plus the held value where it is none of them. */
export function timeoutOptions(held: number) {
  const seconds: number[] = [...TIMEOUT_CHOICES]
  if (!seconds.includes(held)) seconds.push(held)
  return seconds.sort((a, b) => a - b).map((id) => ({ id, label: timeoutLabel(id) }))
}

export function useModelTimeout(profile: { baseUrl: string; apiKey: string } | null | undefined) {
  return useHostRecord(profile, MODEL_TIMEOUT, DEFAULT_MODEL_TIMEOUT_S)
}
