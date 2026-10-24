import { memo, useCallback, useEffect, useRef, useState } from "react"
import { ChevronRightIcon } from "lucide-react"

import { Markdown } from "@/components/chat/markdown"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { COLUMN } from "@/lib/layout"
import { thinkingLabel } from "@/lib/thinking"
import { cn } from "@/lib/utils"

/** How close to the sheet's bottom still counts as its end, for words that landed in view already. */
const AT_END = 4

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

function scroller(node: HTMLElement | null): HTMLElement | null {
  // The words live in a pop-up, so its own scroll box is where the reader reads them.
  const sheet = node?.closest<HTMLElement>("[data-slot=popup-scroll]")
  if (sheet) return sheet
  for (let parent = node?.parentElement ?? null; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === "auto" || overflowY === "scroll") return parent
  }
  return null
}

/**
 * The listeners that stop a row following when the reader scrolls away, kept once per thread scroller
 * rather than once per open row: a live turn holds every row of its thinking open, so four listeners
 * per row would be four per stretch of the turn. The wheel, the keys and the touch are the reader's
 * own moves, so one set stops every row of the thread that is following.
 */
const watchers = new WeakMap<HTMLElement, { rows: Set<() => void>; stop: () => void }>()

/** Registers a row's "the reader left" callback against its scroller; answers the way to drop it. */
function watchAway(view: HTMLElement, away: () => void) {
  let watcher = watchers.get(view)
  if (!watcher) {
    const rows = new Set<() => void>()
    const allAway = () => {
      for (const row of rows) row()
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) allAway()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") allAway()
    }
    let touched: number | undefined
    const onTouchStart = (event: TouchEvent) => {
      touched = event.touches[0]?.clientY
    }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      if (y !== undefined && touched !== undefined && y > touched + 4) allAway()
      touched = y
    }
    view.addEventListener("wheel", onWheel, { passive: true })
    view.addEventListener("keydown", onKey)
    view.addEventListener("touchstart", onTouchStart, { passive: true })
    view.addEventListener("touchmove", onTouchMove, { passive: true })
    const stop = () => {
      view.removeEventListener("wheel", onWheel)
      view.removeEventListener("keydown", onKey)
      view.removeEventListener("touchstart", onTouchStart)
      view.removeEventListener("touchmove", onTouchMove)
    }
    watcher = { rows, stop }
    watchers.set(view, watcher)
  }
  const held = watcher
  held.rows.add(away)
  return () => {
    held.rows.delete(away)
    // The last row of the thread that was following has closed: nothing follows now, so the thread
    // is listened to for nothing until a row opens again.
    if (held.rows.size) return
    held.stop()
    watchers.delete(view)
  }
}

/**
 * One stretch of a reply's thinking — or the stretch still to come, while the reply works and its
 * model has said nothing yet. The row says what the turn is doing: its spinner while the thinking
 * still arrives, its label once this device has measured how long the run took. It opens the
 * working-out in the same sheet the tool row opens, so the thread's two accounts of the work read
 * and open the same way, and the fold the row used to draw in the thread is gone with it. A live
 * run opened in the sheet lands on its newest words and keeps them in view while they arrive,
 * until the reader scrolls away inside the sheet; the sheet never closes itself — when the thinking
 * ends the label beside it just reads the span. See ADR 0050.
 */
export const ThinkingLine = memo(function ThinkingLine({
  reasoning,
  thinking,
  spanMs,
  className,
}: {
  reasoning: string
  /** The model is still thinking, so the row spins and reads "Thinking…" wherever it is drawn. */
  thinking: boolean
  /** How long this device watched the turn think, when it watched it at all. */
  spanMs?: number
  /** The margin that hugs the row it sits beside, when the thread's parts hand one over. */
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
  const following = useRef(false)
  const label = thinkingLabel({ thinking, spanMs })

  // The sheet opened over a run still thinking lands on its newest words and keeps them in view as
  // they arrive — the follow the open row used to do in the thread, now bounded by the sheet's own
  // body rather than the thread's end. A run already written opens at the top, where its
  // working-out starts. The body is what is measured: its words are what is growing.
  useEffect(() => {
    if (!open || !thinking || !drawn) return
    const node = body.current
    if (!node) return
    const view = scroller(node)
    // The tap is the reader asking for this run, so its end comes into view; a box with no room
    // to scroll has nothing to follow either way.
    following.current = Boolean(view)
    if (!following.current) return
    const end = (behavior: ScrollBehavior) => node.scrollIntoView({ block: "end", behavior })
    end(reducedMotion() ? "auto" : "smooth")
    if (typeof ResizeObserver === "undefined") return
    // A browser reports once as soon as an observer is registered, and that report lands while the
    // smooth arrival is still moving the sheet: it would cancel it. The run's growth is waited for.
    let fresh = true
    let queued = 0
    const keep = () => {
      queued = 0
      if (!following.current) return
      // The end is in view already, so there is nothing to write — and a write would cancel a
      // scroll the sheet is making for its own reasons.
      if (view && Math.abs(view.scrollTop + view.clientHeight - view.scrollHeight) <= AT_END) return
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
      observer.disconnect()
      cancelAnimationFrame(queued)
    }
  }, [open, thinking, drawn])

  // Scrolling the sheet up takes the reader somewhere else, so the follow stops and stays off
  // however much more the run has to say. Only the reader's own scrolling counts: the sheet moves
  // itself as words arrive, and one of its own moves is not the reader leaving.
  useEffect(() => {
    if (!open || !drawn) return
    const view = scroller(body.current)
    if (!view) return
    return watchAway(view, () => {
      following.current = false
    })
  }, [open, drawn])

  return (
    <div className={cn("flex flex-col", className, COLUMN)} data-slot="thinking-line">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 text-left text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => setOpen(true)}
      >
        {thinking && <Spinner className="size-4 shrink-0" />}
        {label}
        <ChevronRightIcon className="size-4 shrink-0" aria-hidden />
      </button>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent>
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
    </div>
  )
})
