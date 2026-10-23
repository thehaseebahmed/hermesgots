import { COLUMN } from "@/lib/layout"
import { cn } from "@/lib/utils"

export function DayHeading({ day }: { day: string }) {
  return (
    <div
      data-slot="day-heading"
      aria-hidden
      className={cn(
        "flex items-center gap-3 text-xs font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border",
        COLUMN,
      )}
    >
      {day}
    </div>
  )
}
