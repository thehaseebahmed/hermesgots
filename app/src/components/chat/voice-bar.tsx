import { useEffect } from "react"
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

const IDLE_BARS = Array<number>(32).fill(0)

export function VoiceBar({
  final,
  interim,
  levels,
  finishing,
  onCancel,
  onStop,
  onSend,
}: {
  final: string
  interim: string
  levels: number[] | null
  finishing: boolean
  onCancel: () => void
  onStop: () => void
  onSend: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  return (
    <div className="flex flex-col gap-3">
      {(final || interim) && (
        <p className="px-5 text-base break-words italic md:text-[15px]" aria-live="polite">
          {final}
          {final && interim && " "}
          <span className="text-muted-foreground">{interim}</span>
        </p>
      )}
      <div className="flex items-center gap-2 rounded-[1.75rem] border border-input bg-background p-1.5 shadow-lg shadow-black/5 dark:bg-input/30">
        <Button
          type="button"
          variant="secondary"
          className="size-11 rounded-full"
          onClick={onCancel}
          aria-label="Cancel"
        >
          <XIcon />
        </Button>
        <div className="flex h-11 min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden">
          {(levels ?? IDLE_BARS).map((level, index) => (
            <span
              key={index}
              className="w-[3px] shrink-0 rounded-full bg-foreground transition-[height] duration-75"
              style={{ height: `${4 + level * 28}px` }}
            />
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          className="size-11 rounded-full"
          onClick={onStop}
          disabled={finishing}
          aria-label="Stop"
        >
          <SquareIcon className="fill-current" />
        </Button>
        <Button
          type="button"
          className="size-11 rounded-full"
          onClick={onSend}
          disabled={finishing}
          aria-label="Send"
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  )
}
