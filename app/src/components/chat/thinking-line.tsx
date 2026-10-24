import { memo, useEffect, useId, useRef, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"

import { Markdown } from "@/components/chat/markdown"
import { thinkingLabel } from "@/lib/thinking"
import { cn } from "@/lib/utils"

/**
 * How much of a run reads before the rest waits behind Show more, in the screen's own units so a
 * phone and a tablet each keep a screenful for the reply: a long working-out is common, and it must
 * never push the answer it belongs to off the bottom.
 */
const CAP = "max-h-[30dvh]"

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

/** How a run reads once open: whole when it fits, capped while the rest waits, revealed once asked. */
type Read = "whole" | "capped" | "revealed"

/**
 * One run of a reply's thinking: a folded row that opens on a tap, reads its words as the reply's
 * own markdown while open, and lands the reader on its newest ones.
 */
export const ThinkingLine = memo(function ThinkingLine({
  reasoning,
  thinking,
  spanMs,
  className,
}: {
  reasoning: string
  /** The model is still thinking, so the line streams open. */
  thinking: boolean
  /** How long this device watched the turn think, when it watched it at all. */
  spanMs?: number
  /** The margin that hugs the row it sits beside, when the thread's parts hand one over. */
  className?: string
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  const [read, setRead] = useState<Read>("whole")
  const id = useId()
  const root = useRef<HTMLDivElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const following = useRef(false)
  const open = override ?? thinking

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
      override !== null ||
      !view ||
      view.scrollTop + view.clientHeight >= view.scrollHeight - NEAR_END
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
  }, [open, override])

  // Scrolling the thread up takes the reader somewhere else, so the follow stops for this row and
  // stays off however much more its run has to say. Only the reader's own scrolling counts: the
  // thread moves itself as rows grow, and one of its own moves is not the reader leaving.
  useEffect(() => {
    if (!open) return
    const view = scroller(body.current)
    if (!view) return
    const away = () => {
      following.current = false
    }
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
  }, [open])

  useEffect(() => {
    if (!open) return
    const node = box.current
    const words = node?.firstElementChild
    if (!node || !words) return
    const measure = () =>
      setRead((was) =>
        was === "revealed" ? was : node.scrollHeight > node.clientHeight + 1 ? "capped" : "whole",
      )
    measure()
    if (typeof ResizeObserver === "undefined") return
    // The words are what grows: a capped box stops at its cap, so watching it would miss the run
    // getting taller, and this wrapper is the one element whose height follows the words.
    const observer = new ResizeObserver(measure)
    observer.observe(words)
    return () => observer.disconnect()
  }, [open])

  return (
    <div ref={root} className={cn("flex flex-col", className)} data-slot="thinking-line">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 text-left text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOverride(!open)}
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
            <div
              ref={box}
              data-slot="thinking-cap"
              className={cn("relative min-w-0", read !== "revealed" && [CAP, "overflow-hidden"])}
            >
              <Markdown className="px-1 pt-1 text-sm leading-relaxed text-muted-foreground">
                {reasoning}
              </Markdown>
              {open && read === "capped" && (
                <div
                  data-slot="thinking-fade"
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-background"
                />
              )}
            </div>
            {open && read === "capped" && (
              <button
                type="button"
                className="flex min-h-12 w-full items-center justify-center gap-1 rounded-lg px-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setRead("revealed")}
              >
                Show more
                <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
