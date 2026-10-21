/**
 * What changed in a chat between the turns either side of it: a squiggle broken by a word. The model
 * that took over, in its provider/model form; or that the host compacted the conversation. A label,
 * not a control — the pill under the composer is where a model is picked — so it takes no touch
 * target of its own.
 */

/**
 * One squiggle per side, stretched to its half of the row: ten humps a side is a rule at any width,
 * where more of them at a fixed size read as a texture. The stroke keeps its own width through that
 * stretch rather than thinning with it, and its round ends keep the humps soft.
 */
const RISE = " q 0.625 -2 1.25 0 q 0.625 2 1.25 0"
const HUMPS = 10
/** A hump each way spans 2.5, so the wave is as wide as its humps and never squashed to fit. */
const SPAN = 2.5 * HUMPS
const WAVE = `M0 3${RISE.repeat(HUMPS)}`

function Squiggle() {
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${SPAN} 6`}
      preserveAspectRatio="none"
      className="h-1.5 flex-1 text-muted-foreground"
    >
      <path
        d={WAVE}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function Divider({ label, text }: { label: string; text: string }) {
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 py-1">
      <Squiggle />
      <span className="text-[15px] text-muted-foreground">{text}</span>
      <Squiggle />
    </div>
  )
}

export function ModelChange({ model }: { model: string }) {
  return <Divider label={`Model switched to ${model}`} text={model} />
}

export function Compacted() {
  return <Divider label="Conversation compacted" text="Conversation compacted" />
}
