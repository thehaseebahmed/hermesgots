import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/** One pill of a sideways-scrolling row: 44px so a thumb hits it, shrink-0 so the row scrolls. */
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

/** The strip a row of `Chip`s lives in: sideways, never wrapped, no scrollbar. */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4"
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  )
}
