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
 * The dent a note takes to stand under a row's label rather than under the mark ahead of it: the
 * sign's own box and the gap after it (ADR 0058, ADR 0064).
 */
const WORK_LABEL_DENT = "pl-6"

/**
 * The row button over that shape: what shows before the label (a spinner while the work still runs,
 * a failed group's mark) and what follows it (a ruler, a chevron) belong to the row itself, so each
 * caller keeps its own.
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

/**
 * A note a row says under itself, dented past the row's sign so it stands under the words it
 * explains — whether the row above it wears a spinner or a failure's mark (ADR 0064).
 */
export function WorkNote({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn(WORK_LABEL_DENT, "truncate pb-1 text-sm", className)} {...props} />
}
