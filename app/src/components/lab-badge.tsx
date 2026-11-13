import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

/** Marks a lab feature, wherever it can be turned on or picked. */
export function LabBadge() {
  return <Badge className="h-[22px] bg-warning/15 px-2.5 text-warning-ink">Lab</Badge>
}

/**
 * A lab feature's name and its mark, on one centred line. The name truncates rather than pushing the
 * mark out of the line, so a long title never clips it; `fill` gives the name the row's spare width and
 * pins the pill to its end, which is how the sidebar draws it.
 */
export function LabLabel({ children, fill }: { children: ReactNode; fill?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2", fill && "min-w-0 flex-1")}>
      <span className="min-w-0 truncate">{children}</span>
      <LabBadge />
    </span>
  )
}
