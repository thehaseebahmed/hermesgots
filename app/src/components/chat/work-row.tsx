import { forwardRef, type ComponentProps, type ReactNode } from "react"

import { useCodeFace } from "@/components/chat/code-face"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * The one row shape the thread's two accounts of the work share — a run of tool calls and a run of
 * thinking — so the pair read and open the same way by construction (ADR 0050). It stands 29px
 * tall, the exception the app's 44px touch target makes for a reply's work rows (ADR 0058), and it
 * is muted: a working row says so by its own words pulsing, never by the accent, which is kept for
 * what a reader can press (ADR 0070, ADR 0092).
 */
export const WORK_ROW_CLASS =
  "relative flex min-h-[29px] w-full items-center gap-2 text-left text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"



/**
 * The sign the status line wears ahead of its words — a spinner while the line is live. It is hidden
 * from assistive tech: the line's own name and its words already say what it is doing, and `Spinner`
 * would announce itself. No work row draws one: a working row pulses its words instead (ADR 0092).
 */
export function WorkSign() {
  return (
    <span
      data-slot="work-sign"
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center"
    >
      <Spinner className="size-4" />
    </span>
  )
}

/**
 * A work row's words: the one box they are bounded by, whichever row draws them, so a long label
 * truncates in the row's shape rather than pushing what follows it (ADR 0050). It takes the room left
 * in the row: a shrink-wrapped box answers its text's width, so the fit would never learn the pane had
 * widened and a cut count would stay cut.
 */
export const WorkLabel = forwardRef<HTMLSpanElement, ComponentProps<"span">>(function WorkLabel(
  { className, ...props },
  ref,
) {
  const face = useCodeFace()
  return (
    <span
      ref={ref}
      data-slot="work-label"
      className={cn("min-w-0 flex-1 truncate", face, className)}
      {...props}
    />
  )
})

/**
 * The row button over that shape: what follows the label (a ruler, a chevron) belongs to the row
 * itself, so each caller keeps its own. Nothing stands ahead of the label — a working row pulses its
 * own words rather than wearing a sign, so the words start and stay on the reply's edge whatever the
 * row is doing (ADR 0092).
 */
export const WorkRow = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & { after?: ReactNode; working?: boolean }
>(function WorkRow({ after, children, className, working = false, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-working={working || undefined}
      className={cn(WORK_ROW_CLASS, className)}
      {...props}
    >
      {children}
      {after}
    </button>
  )
})

/**
 * A note a row says under itself, standing on the row's own edge: with no sign ahead of the label
 * there is nothing to dent past (ADR 0092).
 */
export function WorkNote({ className, ...props }: ComponentProps<"p">) {
  const face = useCodeFace()
  return <p className={cn("truncate pb-1 text-sm", face, className)} {...props} />
}
