import { useEffect, useRef, useState, type MouseEvent } from "react"
import { ArrowUpIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { keyboardClick, type DictationStatus } from "@/lib/dictation"
import { failureLine, type DictationFailure } from "@/lib/dictation-failure"

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

export function VoiceBar({
  status,
  levels,
  startedAt,
  failure,
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
  const closing = failed ? (failure?.discard ? "Discard" : "Dismiss") : "Cancel"

  return (
    <div
      role="group"
      aria-label="Speech-to-text take"
      onPointerDownCapture={() => (pressed.current = true)}
      className="flex flex-col rounded-[1.75rem] border border-input bg-background shadow-lg shadow-black/5 dark:bg-input/30"
    >
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
