import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * One pill of a sideways-scrolling row: the filter a list or a log is read through, with one of them
 * active at a time and an `All` beside them where the row needs one. 44px so a thumb hits it, and
 * shrink-0 so the row scrolls rather than squeezing its pills.
 */
export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}
