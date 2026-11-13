import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"

/** Marks a feature the app still considers a lab, wherever it can be turned on or picked. */
export function LabBadge() {
  return <Badge className="bg-warning/15 px-2.5 text-warning">Lab</Badge>
}

/**
 * A lab feature's own name with that mark: one centred line, so the larger type of a heading cannot
 * leave the pill riding its baseline. The sidebar pins the pill to the row's end instead, and spells
 * that itself.
 */
export function LabLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      {children}
      <LabBadge />
    </span>
  )
}
