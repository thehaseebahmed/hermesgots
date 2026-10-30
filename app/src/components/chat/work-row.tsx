import { forwardRef, type ComponentProps, type ReactNode } from "react"
import { XIcon } from "lucide-react"

import { useCodeFace } from "@/components/chat/code-face"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * The one row shape the thread's two accounts of the work share — a run of tool calls and a run of
 * thinking — so the pair read and open the same way by construction (ADR 0050). It stands 29px
 * tall, the exception the app's 44px touch target makes for a reply's work rows (ADR 0058).
 */
export const WORK_ROW_CLASS =
  "relative flex min-h-[29px] w-full items-center gap-2 text-left text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

/**
 * What a row wears while the turn works behind it: the status line's loader and word and the
 * thinking row's are this one look, so a turn moving between the two never changes how it reads.
 */
export const WORKING_ROW_CLASS = "text-primary"

/** The sign's own box: the 16px `WORK_LABEL_DENT` clears along with the row's 8px gap. */
const SIGN = "size-4 shrink-0"

/**
 * The dent a note takes to stand under a row's label rather than under the sign ahead of it: the
 * sign's box and the gap after it (ADR 0058, ADR 0064).
 */
const WORK_LABEL_DENT = "pl-6"

/**
 * The sign a work row wears ahead of its label — a spinner while the row works, the mark a group
 * whose calls failed wears in the same slot (ADR 0064). It is hidden from assistive tech: the row's
 * own name and its label already say what it is doing, and `Spinner` would announce itself.
 */
export function WorkSign({ failed }: { failed?: boolean }) {
  if (!failed) return <Spinner aria-hidden className={SIGN} />
  return (
    <XIcon
      data-slot="work-sign"
      aria-hidden
      className={cn(SIGN, "text-destructive")}
      strokeWidth={3}
    />
  )
}

/**
 * A work row's words: the one box they are bounded by, whichever row draws them, so a long label
 * truncates in the row's shape rather than pushing what follows it (ADR 0050).
 */
export const WorkLabel = forwardRef<HTMLSpanElement, ComponentProps<"span">>(function WorkLabel(
  { className, ...props },
  ref,
) {
  const face = useCodeFace()
  return <span ref={ref} className={cn("min-w-0 truncate", face, className)} {...props} />
})

/**
 * The row button over that shape: what follows the label (a ruler, a chevron) belongs to the row
 * itself, so each caller keeps its own, and the sign before it is `WorkSign`.
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
  const face = useCodeFace()
  return <p className={cn(WORK_LABEL_DENT, "truncate pb-1 text-sm", face, className)} {...props} />
}
