import { memo, useCallback, useEffect, useRef, useState } from "react"
import { ChevronRightIcon } from "lucide-react"

import { Markdown } from "@/components/chat/markdown"
import {
  WORK_ROW_CLASS,
  WORKING_ROW_CLASS,
  WorkLabel,
  WorkRow,
  WorkSign,
} from "@/components/chat/work-row"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { COLUMN } from "@/lib/layout"
import { prefersReducedMotion } from "@/lib/media"
import { thinkingLabel } from "@/lib/thinking"
import { useBusyWord } from "@/lib/use-busy-word"
import { cn } from "@/lib/utils"

/** How close to the sheet's bottom still counts as its end, for words that landed in view already. */
const AT_END = 4

/**
 * "The reader left": a wheel up, the keys that jump up, a finger dragging down — any of them takes
 * the reader somewhere the run's words are not, so the follow stops. Only the reader's own scrolling
 * counts: the sheet moves itself as words arrive, and one of its own moves is not the reader
 * leaving. Answers the way to stop listening again.
 */
function watchAway(view: HTMLElement, away: () => void) {
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) away()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") away()
  }
  let touched: number | undefined
  const onTouchStart = (event: TouchEvent) => {
    touched = event.touches[0]?.clientY
  }
  const onTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY
    if (y !== undefined && touched !== undefined && y > touched + 4) away()
    touched = y
  }
  view.addEventListener("wheel", onWheel, { passive: true })
  view.addEventListener("keydown", onKey)
  view.addEventListener("touchstart", onTouchStart, { passive: true })
  view.addEventListener("touchmove", onTouchMove, { passive: true })
  return () => {
    view.removeEventListener("wheel", onWheel)
    view.removeEventListener("keydown", onKey)
    view.removeEventListener("touchstart", onTouchStart)
    view.removeEventListener("touchmove", onTouchMove)
  }
}

/**
 * One stretch of a reply's thinking — or the stretch still to come, while the reply works and its
 * model has said nothing yet, drawn as a status row with nothing to open until words arrive. The
 * row says what the turn is doing: it turns a spinner ahead of the label while the thinking still
 * arrives, and wears no sign at all once this device has measured how long the run took. It opens
 * the working-out in the same sheet the tool row opens, so the thread's two accounts of the work read
 * and open the same way. A live run opened in the sheet lands on its newest words and keeps them in
 * view while they arrive, until the reader scrolls away inside the sheet; the sheet never closes
 * itself — when the thinking ends the label beside it just reads the span. While it thinks the row
 * is the status line's own look, saying the same rotating word it would (ADR 0069), though its
 * name for assistive tech and its sheet's heading stay "Thinking…". See ADR 0050 and ADR 0064.
 */
export const ThinkingLine = memo(function ThinkingLine({
  reasoning,
  seed = "",
  thinking,
  pending,
  spanMs,
  className,
}: {
  reasoning: string
  /** What the rotating word is drawn from: the reply's own, as its status line's is. */
  seed?: string
  /** The model is still thinking, so the row turns a spinner beside "Thinking…" wherever it is drawn. */
  thinking: boolean
  /** The turn works but its stretch has not arrived: the row turns its spinner over no words and
   * offers no tap. */
  pending?: boolean
  /** How long this device watched the turn think, when it watched it at all. */
  spanMs?: number
  /** The part's own classes: the reply's inset, and the gap the pair's upper half drops (ADR 0058). */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  // The sheet's body lands in the tree when the pop-up mounts it, which can be a commit after the
  // tap: the follow waits for the body to really be there rather than for the tap alone.
  const [drawn, setDrawn] = useState(false)
  const body = useRef<HTMLDivElement | null>(null)
  // Stable, so the pop-up attaching the body detaches it only when it really goes.
  const bodyRef = useCallback((node: HTMLDivElement | null) => {
    body.current = node
    setDrawn(Boolean(node))
  }, [])
  // The pop-up hands its scroll box over: the words live in the sheet, so that box is where the
  // reader reads them and where being "at the end" is measured.
  const sheet = useRef<HTMLElement | null>(null)
  const sheetRef = useCallback((node: HTMLDivElement | null) => {
    sheet.current = node
  }, [])
  const following = useRef(false)
  const label = thinkingLabel({ thinking, spanMs })
  const words = useBusyWord(thinking ? "thinking" : undefined, seed) ?? label

  // While the run still thinks, the sheet opened over it lands on its newest words and keeps them
  // in view as they arrive — bounded by the sheet's own body rather than the thread's end. A run
  // already written opens at the top, where its working-out starts, and listens for nothing: no
  // words are still arriving. The body is what is measured: its words are what is growing.
  useEffect(() => {
    if (!open || !drawn || !thinking) return
    const node = body.current
    const view = sheet.current
    if (!node || !view) return
    const stopAway = watchAway(view, () => {
      following.current = false
    })
    // The tap is the reader asking for this run, so its end comes into view.
    following.current = true
    const end = (behavior: ScrollBehavior) => node.scrollIntoView({ block: "end", behavior })
    end(prefersReducedMotion() ? "auto" : "smooth")
    if (typeof ResizeObserver === "undefined") return stopAway
    // A browser reports once as soon as an observer is registered, and that report lands while the
    // smooth arrival is still moving the sheet: it would cancel it. The run's growth is waited for.
    let fresh = true
    let queued = 0
    const keep = () => {
      queued = 0
      if (!following.current) return
      // The end is in view already, so there is nothing to write — and a write would cancel a
      // scroll the sheet is making for its own reasons.
      if (Math.abs(view.scrollTop + view.clientHeight - view.scrollHeight) <= AT_END) return
      end("auto")
    }
    const observer = new ResizeObserver(() => {
      if (fresh) {
        fresh = false
        return
      }
      // One write per frame: the words arrive in many small steps, and a scroll per step would
      // fight the smooth arrival that is still moving the sheet.
      if (following.current && !queued) queued = requestAnimationFrame(keep)
    })
    observer.observe(node)
    return () => {
      stopAway()
      observer.disconnect()
      cancelAnimationFrame(queued)
    }
  }, [open, thinking, drawn])

  return (
    <div className={cn("flex flex-col", className, COLUMN)} data-slot="thinking-line">
      {pending ? (
        // The turn's own stretch has not arrived: the row names what the turn is doing and offers
        // no tap — under this same key, the run's row takes over the moment its words land.
        <div className={cn(WORK_ROW_CLASS, WORKING_ROW_CLASS)} data-slot="thinking-pending">
          <WorkSign />
          <WorkLabel>{words}</WorkLabel>
        </div>
      ) : (
        <WorkRow
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen(true)}
          className={thinking ? WORKING_ROW_CLASS : undefined}
          before={thinking ? <WorkSign /> : null}
          after={<ChevronRightIcon className="size-4 shrink-0" aria-hidden />}
        >
          <WorkLabel>{words}</WorkLabel>
        </WorkRow>
      )}
      {!pending && (
        <Popup open={open} onOpenChange={setOpen}>
          <PopupContent dataSlot="thinking-sheet" scrollRef={sheetRef}>
            <PopupHeader className="pb-3">
              <PopupTitle>{label}</PopupTitle>
            </PopupHeader>
            <div className="flex flex-col px-6 pb-6">
              <div ref={bodyRef} data-slot="thinking-body" className="flex min-w-0 flex-col">
                <Markdown className="text-sm leading-relaxed text-muted-foreground">
                  {reasoning}
                </Markdown>
              </div>
            </div>
          </PopupContent>
        </Popup>
      )}
    </div>
  )
})
