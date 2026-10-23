import type { DictationFailure } from "@/lib/dictation-failure"
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
  /** Why the take failed, with what to try: the bar's one line while it is failed. */
  failure: DictationFailure | null
  /** What the take has heard so far; empty for the chunked implementation. */
  transcript: DictationTranscript
  recordingSince: () => number | null
  /**
   * Where a take that came back was left, for a restore: the composer inserts its text there, so it
   * lands where it was begun rather than at the end of the draft.
   */
  anchor: () => number | null
  /** `caret` is where the field's caret was, kept with the take so a restore can put it back. */
  start: (caret?: number | null) => Promise<void>
  /**
   * Ends the take and answers what to put in the field. `waitMs` is how long the tail is waited for
   * before the take is abandoned to what it already has: a Send waits short and a Stop longer
   * (`SEND_WAIT_MS` / `STOP_WAIT_MS`), so a slow host never holds the composer.
   */
  finish: (waitMs?: number) => Promise<string | null>
  retry: () => Promise<string | null>
  cancel: () => void
}

export function useDictation(
  config: HermesConfig,
  hint: string,
  key?: string,
  vocabulary?: string[],
  onCommitted?: (text: string) => void,
): DictationTake {
  const answer = usePluginFeature(config, DICTATION_STREAM)
  const chunked = useChunkedDictation(config, hint, key, onCommitted)
  const stream = useStreamDictation(config, hint, key, vocabulary, onCommitted)
  if (chunked.status !== "idle") return chunked
  if (stream.status !== "idle") return stream
  return answer === "yes" ? stream : chunked
}
