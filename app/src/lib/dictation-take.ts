import { useRef } from "react"

import type { DictationFailure } from "@/lib/dictation-failure"
import type { DictationTranscript } from "@/lib/dictation-transcript"
import { useChunkedDictation, type DictationStatus } from "@/lib/dictation"
import { useStreamDictation } from "@/lib/dictation-stream"
import { getPluginFeatureList, type HermesConfig } from "@/lib/hermes"

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
  const chunked = useChunkedDictation(config, hint, key, onCommitted)
  const stream = useStreamDictation(config, hint, key, vocabulary, onCommitted)
  // Which one a take opened with, held so Finish, Retry and Cancel answer to the take that is
  // actually live rather than to a re-read. The pick itself waits for `start`, so opening a chat
  // asks the host nothing — only a take asks, and it asks once, on the way in.
  const opened = useRef<DictationTake | null>(null)

  const live = (): DictationTake => {
    if (chunked.status !== "idle") return chunked
    if (stream.status !== "idle") return stream
    return opened.current ?? chunked
  }
  const pick = async (): Promise<DictationTake> => {
    if (chunked.status !== "idle") return chunked
    if (stream.status !== "idle") return stream
    const features = await getPluginFeatureList(config)
    return (opened.current = features?.includes(DICTATION_STREAM) ? stream : chunked)
  }

  const view = live()
  return {
    status: view.status,
    levels: view.levels,
    startedAt: view.startedAt,
    failure: view.failure,
    transcript: view.transcript,
    recordingSince: view.recordingSince,
    anchor: view.anchor,
    start: async (caret?: number | null) => {
      await (await pick()).start(caret)
    },
    finish: (waitMs?: number) => live().finish(waitMs),
    retry: () => live().retry(),
    cancel: () => live().cancel(),
  }
}
