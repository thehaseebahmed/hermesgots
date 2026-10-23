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

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/** The box this row scrolls in: the thread's own viewport, or the nearest box that scrolls. */
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
 * One run of a reply's thinking: a folded row that opens on a tap, reads its words as the reply's
 * own markdown while open, and lands the reader on its newest ones.
 */
export const ThinkingLine = memo(function ThinkingLine({
  reasoning,
  thinking,
  spanMs,
}: {
  reasoning: string
  /** The model is still thinking, so the line streams open. */
  thinking: boolean
  /** How long this device watched the turn think, when it watched it at all. */
  spanMs?: number
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  // The reader asked for the rest of a long run, so this row's cap is off.
  const [revealed, setRevealed] = useState(false)
  // The run's words are taller than its cap, so the rest waits behind a Show more.
  const [overflowing, setOverflowing] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  // This row's end is the reader's place in the thread, until they scroll away from it.
  const following = useRef(false)
  const open = override ?? thinking
  const capped = !revealed
  // A run past its cap, open and not yet revealed: the fade and the control are what say so.
  const folded = open && capped && overflowing

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
    const end = (behavior: ScrollBehavior) => node.scrollIntoView({ block: "end", behavior })
    following.current = true
    end(reducedMotion() ? "auto" : "smooth")
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (following.current) end("auto")
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [open])

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

  // Only a run that actually outgrows its cap gets the fade and the control: a short one is drawn
  // whole, with nothing hidden and nothing to reveal.
  useEffect(() => {
    if (!open || !capped) {
      setOverflowing(false)
      return
    }
    const node = box.current
    if (!node) return
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    for (const child of Array.from(node.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [open, capped])

  return (
    <div ref={root} className="-my-2 flex flex-col" data-slot="thinking-line">
      <button
        type="button"
        className="flex min-h-11 items-center gap-1 self-start rounded-lg px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOverride(!open)}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden
        />
        {thinkingLabel({ thinking, spanMs })}
      </button>
      <div
        id={id}
        // Folded text would still be read out, so it leaves the tree until the line opens.
        aria-hidden={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          {/* `scroll-mb-16` keeps the row's end clear of the thread's own floating scroll control
              when landing on it: the newest words are what the reader came for. */}
          <div
            ref={body}
            data-slot="thinking-body"
            className="flex min-w-0 scroll-mb-16 flex-col"
          >
            {/* The reply's own markdown, so a run reads the way the answer under it does. */}
            <div
              ref={box}
              data-slot="thinking-cap"
              className={cn("relative min-w-0", capped && [CAP, "overflow-hidden"])}
            >
              <Markdown className="px-1 pt-1 text-sm leading-relaxed text-muted-foreground">
                {reasoning}
              </Markdown>
              {folded && (
                <div
                  data-slot="thinking-fade"
                  // The rest of the run is under this edge; it must not take a tap meant for the text.
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-background"
                />
              )}
            </div>
            {folded && (
              <button
                type="button"
                className="flex min-h-12 w-full items-center justify-center gap-1 rounded-lg px-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setRevealed(true)}
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
