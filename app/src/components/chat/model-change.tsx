/**
 * Where a chat's model changed, between the turns either side of it: a squiggle broken by the name
 * of the model that took over, in its provider/model form. A label, not a control — the pill under
 * the composer is where a model is picked — so it takes no touch target of its own.
 */

/** One squiggle per side, each stretched to its half of the row: its stroke keeps the hairline. */
const WAVE = `M0 3${" q 0.625 -2 1.25 0 q 0.625 2 1.25 0".repeat(16)}`

function Squiggle() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 40 6"
      preserveAspectRatio="none"
      className="h-1.5 flex-1 text-border"
    >
      <path
        d={WAVE}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function ModelChange({ model }: { model: string }) {
  return (
    <div
      role="separator"
      aria-label={`Model switched to ${model}`}
      className="flex items-center gap-3 py-1"
    >
      <Squiggle />
      <span className="text-xs text-muted-foreground">{model}</span>
      <Squiggle />
    </div>
  )
}
