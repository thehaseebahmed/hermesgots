import type { Compaction } from "@/lib/hermes"

/**
 * What changed in a chat between the turns either side of it: a squiggle broken by a word. The model
 * that took over, in its provider/model form; or that the host compacted the conversation. A label,
 * not a control — the pill under the composer is where a model is picked — so it takes no touch
 * target of its own.
 */

/**
 * One squiggle per side, at a fixed size whatever the label's width: six humps of 8px, so the pattern
 * is the same beside "gpt-5" as beside a long provider/model, and the row is centred on its label.
 * Drawn at its own pixel size, so the stroke never thins or stretches; its round ends keep the humps
 * soft.
 */
const HUMP = 8
const HUMPS = 6
const RISE = ` q ${HUMP / 4} -3 ${HUMP / 2} 0 q ${HUMP / 4} 3 ${HUMP / 2} 0`
const SPAN = HUMP * HUMPS
const WAVE = `M0 3${RISE.repeat(HUMPS)}`

function Squiggle() {
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${SPAN} 6`}
      width={SPAN}
      height={6}
      className="shrink-0 text-muted-foreground"
    >
      <path
        d={WAVE}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Divider({ label, text }: { label: string; text: string }) {
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center justify-center gap-3 py-1"
    >
      <Squiggle />
      <span className="min-w-0 truncate text-sm text-muted-foreground">{text}</span>
      <Squiggle />
    </div>
  )
}

export function ModelChange({ model }: { model: string }) {
  return <Divider label={`Model switched to ${model}`} text={model} />
}

/** How full the context was when the host compacted it, where the host recorded it. */
function percent({ tokens, window }: Compaction) {
  return tokens && window ? ` at ${Math.round((tokens / window) * 100)}%` : ""
}

export function Compacted({ compaction }: { compaction: Compaction }) {
  const text = `Conversation compacted${percent(compaction)}`
  return <Divider label={text} text={text} />
}
