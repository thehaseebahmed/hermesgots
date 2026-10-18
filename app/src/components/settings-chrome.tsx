import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/** The chrome every Settings screen wears: a sticky header over one centred column of groups. */
export function Screen({
  title,
  leading,
  className,
  children,
}: {
  title: string
  leading?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}>
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex min-h-11 max-w-2xl items-center gap-3">
          {leading}
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  )
}

/** The rounded card list with hairline separators the Settings rows sit in. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10 *:rounded-none">
      {children}
    </div>
  )
}

export const rowClass =
  "flex min-h-14 w-full items-center gap-4 bg-card px-5 py-3 text-left text-card-foreground"
/** `rowClass` for a row that opens something. */
export const linkRowClass = `${rowClass} transition-colors hover:bg-muted`

/** A row's title over its muted second line. */
export function RowText({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-base">{title}</span>
      {subtitle && <span className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</span>}
    </span>
  )
}
