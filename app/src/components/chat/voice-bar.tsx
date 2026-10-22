import { useEffect, useRef, useState, type MouseEvent } from "react"
import { ArrowUpIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { keyboardClick, type DictationStatus } from "@/lib/dictation"
import { failureLine, type DictationFailure } from "@/lib/dictation-failure"
import { hearing, transcriptText, type DictationTranscript } from "@/lib/dictation-transcript"

const IDLE_BARS = Array<number>(32).fill(0)

function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <span className="w-10 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
      {clock(now - since)}
    </span>
  )
}

/**
 * The take's words, newest at the bottom, scrolling within a few lines rather than growing. It is
 * not a live region: a screen reader reads it on request, so a take is never announced word by word.
 */
function Transcript({ transcript }: { transcript: DictationTranscript }) {
  const box = useRef<HTMLDivElement>(null)
  const text = transcriptText(transcript)
  useEffect(() => {
    const element = box.current
    if (element) element.scrollTop = element.scrollHeight
  }, [text, transcript.behind])
  return (
    <div
      ref={box}
      role="region"
      aria-label="Dictation"
      aria-live="off"
      className="max-h-[4.5rem] overflow-y-auto px-3 pt-2 pb-0.5 text-sm leading-snug"
    >
      {transcript.preparing && !text && (
        <span className="text-muted-foreground motion-safe:animate-pulse">Preparing…</span>
      )}
      {text && <p className="break-words whitespace-pre-wrap">{text}</p>}
      {transcript.behind && <p className="pt-0.5 text-xs text-muted-foreground">Behind</p>}
    </div>
  )
}

export function VoiceBar({
  status,
  levels,
  startedAt,
  failure,
  transcript,
  onCancel,
  onStop,
  onSend,
  onRetry,
}: {
  status: Exclude<DictationStatus, "idle">
  levels: number[] | null
  startedAt: number | null
  /** Why the take failed, with what to try: the bar's one line while it is failed. */
  failure: DictationFailure | null
  /** What the take has heard so far; absent for the chunked implementation, which has no words yet. */
  transcript?: DictationTranscript
  onCancel: () => void
  onStop: () => void
  onSend: () => void
  onRetry: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  const transcribing = status === "transcribing"
  const failed = status === "failed"
  // The bar takes the mic's place under the finger, so the tap that started recording ends with a
  // click on whatever button sits there now; only a press that began on the bar counts.
  const pressed = useRef(false)
  const pressedHere = (action: () => void) => (event: MouseEvent) => {
    if (pressed.current || keyboardClick(event)) action()
  }
  // Closing a failed take discards a recording only when one is still held; a take that already
  // put its words in the field has nothing left to discard, so its button only dismisses the line.
  const closing = failed ? (failure?.discard ? "Discard" : "Dismiss") : "Cancel"

  return (
    <div
      role="group"
      aria-label="Dictation take"
      onPointerDownCapture={() => (pressed.current = true)}
      className="flex flex-col rounded-[1.75rem] border border-input bg-background shadow-lg shadow-black/5 dark:bg-input/30"
    >
      {status !== "failed" && transcript && hearing(transcript) && (
        <Transcript transcript={transcript} />
      )}
      <div className="flex items-center gap-2 p-1.5">
        <Button
          type="button"
          variant="secondary"
          className="size-11 rounded-full"
          onClick={pressedHere(onCancel)}
          aria-label={closing}
        >
          <XIcon />
        </Button>
        {failed ? (
          <>
            <div className="min-w-0 flex-1 px-1">
              <p
                className="line-clamp-2 text-sm leading-tight text-destructive"
                role="alert"
                title={failure ? failureLine(failure) : undefined}
              >
                {failure?.message ?? "Couldn't transcribe the recording."}
              </p>
              {failure?.advice && (
                <p className="line-clamp-1 text-xs leading-tight text-muted-foreground">
                  {failure.advice}
                </p>
              )}
            </div>
            {failure?.retry !== false && (
              <Button type="button" className="h-11 rounded-full px-4" onClick={pressedHere(onRetry)}>
                <RotateCwIcon />
                Retry
              </Button>
            )}
          </>
        ) : (
          <>
            <div
              className="flex h-11 min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden"
              aria-live="polite"
            >
              {transcribing ? (
                <span className="text-sm text-muted-foreground motion-safe:animate-pulse">
                  Transcribing…
                </span>
              ) : (
                (levels ?? IDLE_BARS).map((level, index) => (
                  <span
                    key={index}
                    className="w-[3px] shrink-0 rounded-full bg-foreground transition-[height] duration-75"
                    style={{ height: `${4 + level * 28}px` }}
                  />
                ))
              )}
            </div>
            {startedAt !== null && !transcribing && <Elapsed since={startedAt} />}
            <Button
              type="button"
              variant="secondary"
              className="size-11 rounded-full"
              onClick={pressedHere(onStop)}
              disabled={transcribing}
              aria-label="Stop"
            >
              <SquareIcon className="fill-current" />
            </Button>
            <Button
              type="button"
              className="size-11 rounded-full"
              onClick={pressedHere(onSend)}
              disabled={transcribing}
              aria-label="Send"
            >
              <ArrowUpIcon />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
