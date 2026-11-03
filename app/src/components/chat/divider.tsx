/**
 * A thing that happened between two turns, drawn as one piece: a squiggle on either side, broken by
 * its words. The day heading, the model change and the compaction all draw through it, so the same
 * quiet break never arrives in two colours, two sizes or two shapes (ADR 0087).
 *
 * The squiggle wears the border colour and the words the muted one: the line is furniture under
 * words that have something to say, which is how the day heading was drawn before the other two
 * arrived. It is a separator and it says itself to assistive tech, so a reader who cannot see the
 * break is still told the day turned, the model switched or the context was compacted.
 *
 * One squiggle per side, running to the edge of the row: each hump is a fixed 17px, so a wide row
 * shows more of them and a narrow one fewer, and they look the same either way. The wave is drawn
 * longer than any row and clipped, from the label outwards, so a hump is cut at the row's edge and
 * never squeezed. Drawn at its own pixel size, so the stroke never thins; its round ends keep the
 * humps soft.
 */
import { COLUMN } from "@/lib/layout"
import { cn } from "@/lib/utils"

const HUMP = 17
const HUMPS = 48
const RISE = ` q ${HUMP / 4} -2 ${HUMP / 2} 0 q ${HUMP / 4} 2 ${HUMP / 2} 0`
const SPAN = HUMP * HUMPS
const WAVE = `M0 3${RISE.repeat(HUMPS)}`

function Squiggle({ side }: { side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      className={`flex min-w-0 flex-1 overflow-hidden text-border ${side === "left" ? "justify-end" : "justify-start"}`}
    >
      <svg viewBox={`0 0 ${SPAN} 6`} width={SPAN} height={6} className="shrink-0">
        <path
          d={WAVE}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

/** The divider's words, and what a reader who can't see the squiggle is told instead. */
export function Divider({
  text,
  spoken = text,
  slot,
  className,
}: {
  text: string
  spoken?: string
  /** What a test or a style can name the break by. */
  slot?: string
  className?: string
}) {
  return (
    <div
      role="separator"
      aria-label={spoken}
      data-slot={slot}
      className={cn("flex items-center gap-3 py-1", COLUMN, className)}
    >
      <Squiggle side="left" />
      <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{text}</span>
      <Squiggle side="right" />
    </div>
  )
}
