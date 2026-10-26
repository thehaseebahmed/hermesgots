import { forwardRef, type ComponentProps, type ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The one row shape the thread's two accounts of the work share — a run of tool calls and a run of
 * thinking — so the pair read and open the same way by construction (ADR 0050). It stands 29px
 * tall, the exception the app's 44px touch target makes for a reply's work rows (ADR 0058).
 */
export const WORK_ROW_CLASS =
  "relative flex min-h-[29px] w-full items-center gap-2 text-left text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

/**
 * The dent a line takes to stand under a row's label rather than under its icon: the icon and the
 * gap after it (ADR 0058).
 */
export const WORK_LABEL_DENT = "pl-6"

/**
 * The row button over that shape: what shows before the label (a spinner while the work still runs)
 * and what follows it (a ruler, a chevron) belong to the row itself, so each caller keeps its own.
 */
export const WorkRow = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & { before?: ReactNode; after?: ReactNode }
>(function WorkRow({ before, after, children, className, ...props }, ref) {
  return (
    <button ref={ref} type="button" className={cn(WORK_ROW_CLASS, className)} {...props}>
      {before}
      {children}
      {after}
    </button>
  )
})
