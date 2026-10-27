import { formatTokens } from "@/lib/format"
import type { Compaction } from "@/lib/hermes"
import { COLUMN } from "@/lib/layout"
import { cn } from "@/lib/utils"

/**
 * What changed in a chat between the turns either side of it: a squiggle broken by a word. The model
 * that took over, in its provider/model form; or that the host compacted the conversation. A label,
 * not a control — the pill under the composer is where a model is picked — so it takes no touch
 * target of its own.
 */

/**
 * One squiggle per side, running to the edge of the row: each hump is a fixed 17px, so a wide row
 * shows more of them and a narrow one fewer, and they look the same either way. The wave is drawn
 * longer than any row and clipped, from the label outwards, so a hump is cut at the row's edge and
 * never squeezed. Drawn at its own pixel size, so the stroke never thins; its round ends keep the
 * humps soft.
 */
const HUMP = 17
const HUMPS = 48
const RISE = ` q ${HUMP / 4} -2 ${HUMP / 2} 0 q ${HUMP / 4} 2 ${HUMP / 2} 0`
const SPAN = HUMP * HUMPS
const WAVE = `M0 3${RISE.repeat(HUMPS)}`

function Squiggle({ side }: { side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      className={`flex min-w-0 flex-1 overflow-hidden text-muted-foreground ${side === "left" ? "justify-end" : "justify-start"}`}
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

function Divider({ label, text }: { label: string; text: string }) {
  return (
    <div role="separator" aria-label={label} className={cn("flex items-center gap-3 py-1", COLUMN)}>
      <Squiggle side="left" />
      <span className="min-w-0 truncate text-sm text-muted-foreground">{text}</span>
      <Squiggle side="right" />
    </div>
  )
}

export function ModelChange({ model }: { model: string }) {
  return <Divider label={`Model switched to ${model}`} text={model} />
}

/** How full the context was when the host compacted it, where the host recorded it. */
function size({ tokens, window }: Pick<Compaction, "tokens" | "window">) {
  if (!tokens) return ""
  if (!window) return ` · ${formatTokens(tokens)}`
  return ` · ${formatTokens(tokens)} of ${formatTokens(window)} (${Math.round((tokens / window) * 100)}%)`
}

/** What the host recorded about a compaction; a divider drawn from one it hasn't recorded says so. */
export function Compacted({ compaction }: { compaction?: Pick<Compaction, "tokens" | "window"> }) {
  const text = `Compaction${size(compaction ?? {})}`
  return <Divider label={text} text={text} />
}
