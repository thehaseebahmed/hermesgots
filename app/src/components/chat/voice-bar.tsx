import { useEffect, useState } from "react"
import { ArrowUpIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { DictationStatus } from "@/lib/dictation"

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
  error,
  onCancel,
  onStop,
  onSend,
  onRetry,
}: {
  status: Exclude<DictationStatus, "idle">
  levels: number[] | null
  startedAt: number | null
  error: string | null
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

  return (
    <div className="flex items-center gap-2 rounded-[1.75rem] border border-input bg-background p-1.5 shadow-lg shadow-black/5 dark:bg-input/30">
      <Button
        type="button"
        variant="secondary"
        className="size-11 rounded-full"
        onClick={onCancel}
        aria-label={status === "failed" ? "Discard" : "Cancel"}
      >
        <XIcon />
      </Button>
      {status === "failed" ? (
        <>
          <p
            className="line-clamp-2 min-w-0 flex-1 px-1 text-sm leading-tight text-destructive"
            role="alert"
            title={error ?? undefined}
          >
            {error ?? "Couldn't transcribe the recording."}
          </p>
          <Button type="button" className="h-11 rounded-full px-4" onClick={onRetry}>
            <RotateCwIcon />
            Retry
          </Button>
        </>
      ) : (
        <>
          <div
            className="flex h-11 min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden"
            aria-live="polite"
          >
            {transcribing ? (
              <span className="animate-pulse text-sm text-muted-foreground">Transcribing…</span>
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
            onClick={onStop}
            disabled={transcribing}
            aria-label="Stop"
          >
            <SquareIcon className="fill-current" />
          </Button>
          <Button
            type="button"
            className="size-11 rounded-full"
            onClick={onSend}
            disabled={transcribing}
            aria-label="Send"
          >
            <ArrowUpIcon />
          </Button>
        </>
      )}
    </div>
  )
}
