/**
 * The one dictation hook a screen uses, and the choice it makes at the start of a take.
 *
 * A host that advertises `dictation_stream` gets the take heard while it is spoken; any other host
 * gets the chunked implementation exactly as it was, so no bot loses its microphone to this change.
 * Both are mounted — a hook can't be chosen conditionally — and only the one being used ever hears
 * a `start`.
 */
import type { DictationTranscript } from "@/lib/dictation-transcript"
import { useChunkedDictation, type DictationStatus } from "@/lib/dictation"
import { useStreamDictation } from "@/lib/dictation-stream"
import { usePluginFeature } from "@/lib/features"
import type { HermesConfig } from "@/lib/hermes"

/** The feature a host advertises when it can hear a take while it is spoken. */
export const DICTATION_STREAM = "dictation_stream"

/** What both implementations answer, so the composer and the bar never know which one ran. */
export interface DictationTake {
  status: DictationStatus
  levels: number[] | null
  startedAt: number | null
  error: string | null
  /** What the take has heard so far; empty for the chunked implementation. */
  transcript: DictationTranscript
  recordingSince: () => number | null
  start: () => Promise<void>
  finish: () => Promise<string | null>
  retry: () => Promise<string | null>
  cancel: () => void
}

/**
 * Dictation for this bot. The implementation is picked when a take starts — a live take keeps the
 * one it began on — and anything but a clear `yes` is the chunked one, which is what a host with no
 * answer, or an older plugin, has always had. `vocabulary` is the bot's words, which only the
 * streaming take can use: it rides on the call that opens a take.
 */
export function useDictation(
  config: HermesConfig,
  hint: string,
  key?: string,
  vocabulary?: string[],
): DictationTake {
  const answer = usePluginFeature(config, DICTATION_STREAM)
  const chunked = useChunkedDictation(config, hint, key)
  const stream = useStreamDictation(config, hint, vocabulary)
  if (chunked.status !== "idle") return chunked
  if (stream.status !== "idle") return stream
  return answer === "yes" ? stream : chunked
}
