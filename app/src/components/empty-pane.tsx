import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

/**
 * A pane with nothing in it: the mark, at the size and tone the app gives an empty screen, over the
 * one line saying what is missing, the two centred on both axes of whatever the block fills. One
 * component decides the look, so a list's lane and a canvas's page cannot drift apart (ADR 0130); each
 * caller names its own slot, since the panes are found by different names.
 */
export function EmptyPane({
  icon: Icon,
  slot,
  children,
}: {
  icon: LucideIcon
  slot: string
  children: ReactNode
}) {
  return (
    <div
      data-slot={slot}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <Icon aria-hidden className="size-16 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}
