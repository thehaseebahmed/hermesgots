import { memo, useEffect, useId, useRef } from "react"
import { ChevronRightIcon } from "lucide-react"

import { Markdown } from "@/components/chat/markdown"
import { COLUMN } from "@/lib/layout"
import { thinkingLabel } from "@/lib/thinking"
import { cn } from "@/lib/utils"

/** How close to the thread's end a reader counts as reading it, so a row that opens on its own follows. */
const NEAR_END = 40

/** How close to the thread's end still counts as its end, for words that landed in view already. */
const AT_END = 4

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

function scroller(node: HTMLElement | null): HTMLElement | null {
  const thread = node?.closest<HTMLElement>("[data-slot=message-scroller-viewport]")
  if (thread) return thread
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
 * One stretch of a reply's thinking: a folded row that reads its words as the reply's own markdown
 * while open, however long they run, and lands the reader on its newest ones. The row keeps no state
 * of its own — the thread says whether it lies open and whether the reader asked for it, so one place
 * can answer whether any row of the turn is open, which the footer's working line has to know — and a
 * tap only asks the thread to open or fold it.
 */
export const ThinkingLine = memo(function ThinkingLine({
  reasoning,
  thinking,
  spanMs,
  open,
  asked,
  onToggle,
  className,
}: {
  reasoning: string
  /** The model is still thinking, so the line reads "Thinking…" even when it is folded. */
  thinking: boolean
  /** How long this device watched the turn think, when it watched it at all. */
  spanMs?: number
  /** The row lies open, as the thread answers it from its latch and the reader's taps. */
  open: boolean
  /** The reader asked for this row, so wherever they were, its end is what they came for. */
  asked: boolean
  /** Opens or folds the row for the visit; the thread keeps what it decided. */
  onToggle: () => void
  /** The margin that hugs the row it sits beside, when the thread's parts hand one over. */
  className?: string
}) {
  const id = useId()
  const root = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const following = useRef(false)

  // Opening reads from the newest words down: the row's end is put at the foot of the thread, and
  // kept there as the row grows — the fold's own transition and the run's arriving words both grow
  // it — until the reader scrolls away, which stops the follow until the row is opened again. The
  // row itself is what is measured: a folded row's body keeps its own height while the row around it
  // opens, so watching the body alone would miss the moment the words come into view.
  useEffect(() => {
    if (!open) return
    const node = body.current
    const row = root.current
    if (!node || !row) return
    const view = scroller(node)
    // A tap is the reader asking for this run, so its end comes into view; a row that opens on its
    // own follows only for a reader already at the thread's end, and never pulls someone who has
    // scrolled up back down to a run they did not ask for.
    following.current =
      asked || !view || view.scrollTop + view.clientHeight >= view.scrollHeight - NEAR_END
    if (!following.current) return
    const end = (behavior: ScrollBehavior) => node.scrollIntoView({ block: "end", behavior })
    end(reducedMotion() ? "auto" : "smooth")
    if (typeof ResizeObserver === "undefined") return
    // A browser reports once as soon as an observer is registered, and that report lands while the
    // smooth arrival is still moving the thread: it would cancel it. The run's growth is waited for.
    let fresh = true
    let queued = 0
    const keep = () => {
      queued = 0
      if (!following.current) return
      // The row's end is in view already, so there is nothing to write — and a write would cancel a
      // scroll the thread is making for its own reasons.
      if (view && Math.abs(view.scrollTop + view.clientHeight - view.scrollHeight) <= AT_END) return
      end("auto")
    }
    const observer = new ResizeObserver(() => {
      if (fresh) {
        fresh = false
        return
      }
      // One write per frame: the words arrive in many small steps, and a scroll per step would
      // fight the smooth arrival that is still moving the thread.
      if (following.current && !queued) queued = requestAnimationFrame(keep)
    })
    observer.observe(row)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(queued)
    }
  }, [open, asked])

  // Scrolling the thread up takes the reader somewhere else, so the follow stops for this row and
  // stays off however much more its run has to say. Only the reader's own scrolling counts: the
  // thread moves itself as rows grow, and one of its own moves is not the reader leaving.
  useEffect(() => {
    if (!open) return
    const view = scroller(body.current)
    if (!view) return
    return watchAway(view, () => {
      following.current = false
    })
  }, [open])

  return (
    <div ref={root} className={cn("flex flex-col", className, COLUMN)} data-slot="thinking-line">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 text-left text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        {thinkingLabel({ thinking, spanMs })}
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden
        />
      </button>
      <div
        id={id}
        // Folded text would still be read out, and its links would still take a tab, so the line
        // leaves the tree and the tab order until it opens.
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          {/* `scroll-mb-16` keeps the row's end clear of the thread's own floating scroll control
              when landing on it: the newest words are what the reader came for. */}
          <div ref={body} data-slot="thinking-body" className="flex min-w-0 scroll-mb-16 flex-col">
            <Markdown className="px-1 pt-1 text-sm leading-relaxed text-muted-foreground">
              {reasoning}
            </Markdown>
          </div>
        </div>
      </div>
    </div>
  )
})
