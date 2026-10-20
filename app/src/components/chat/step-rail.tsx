import type { ReactNode } from "react"

/**
 * The mark down the left of a step or a row, and the line that joins it to the next one — the
 * timeline three pop-ups draw: a todo list, a run's tool calls, and a staged task's stages.
 */
export function StepRail({ last, children }: { last: boolean; children: ReactNode }) {
  return (
    <div className="relative w-7 shrink-0">
      <div className="flex h-11 items-center justify-center">{children}</div>
      {/* Runs from under this mark to the next one's. */}
      {!last && (
        <div className="absolute top-10 -bottom-1 left-1/2 w-px -translate-x-1/2 bg-border" />
      )}
    </div>
  )
}
