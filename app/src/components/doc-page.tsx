import type { ReactNode } from "react"

import { BackButton } from "@/components/back-button"
import { COLUMN, REPLY_EDGE } from "@/lib/layout"
import { cn } from "@/lib/utils"

export function DocPage({
  title,
  backTo,
  backLabel,
  children,
}: {
  title: string
  backTo: string
  backLabel: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
      <header
        className={cn(
          REPLY_EDGE,
          "flex items-center gap-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3",
        )}
      >
        <BackButton to={backTo} label={backLabel} />
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      </header>
      <div className={cn(COLUMN, "pb-[max(2rem,env(safe-area-inset-bottom))]")}>{children}</div>
    </div>
  )
}
