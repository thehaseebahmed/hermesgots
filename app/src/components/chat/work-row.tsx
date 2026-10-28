import { forwardRef, type ComponentProps, type ReactNode } from "react"

import { useReducedMotion } from "@/lib/media"
import { cn } from "@/lib/utils"

/**
 * The one row shape the thread's two accounts of the work share — a run of tool calls and a run of
 * thinking — so the pair read and open the same way by construction (ADR 0050). It stands 29px
 * tall, the exception the app's 44px touch target makes for a reply's work rows (ADR 0058).
 */
export const WORK_ROW_CLASS =
  "relative flex min-h-[29px] w-full items-center gap-2 text-left text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

/** The wave's own name: the class the stylesheet turns into a light, and the slot the tests read. */
const WAVE = "work-wave"

/**
 * A work row's words, carrying the wave while the row works — a light travelling through them, a lap
 * every 1.4 seconds (ADR 0061). It is decoration over words the reader can already read: nothing
 * announces it, and where the reader asked for reduced motion the words are plain.
 *
 * The wave is its own span so the gradient fills the words and nothing else: `truncate`'s ellipsis
 * would otherwise be painted with the same transparent fill, and so would a row's marks.
 */
export const WorkLabel = forwardRef<HTMLSpanElement, ComponentProps<"span"> & { wave?: boolean }>(
  function WorkLabel({ wave, className, children, ...props }, ref) {
    const reduced = useReducedMotion()
    const moving = Boolean(wave) && !reduced
    return (
      <span ref={ref} className={cn("min-w-0 truncate", className)} {...props}>
        {moving ? (
          <span className={WAVE} data-slot={WAVE}>
            {children}
          </span>
        ) : (
          children
        )}
      </span>
    )
  },
)

/**
 * The row button over that shape: what follows the label (a ruler, a chevron) belongs to the row
 * itself, so each caller keeps its own.
 */
export const WorkRow = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & { after?: ReactNode }
>(function WorkRow({ after, children, className, ...props }, ref) {
  return (
    <button ref={ref} type="button" className={cn(WORK_ROW_CLASS, className)} {...props}>
      {children}
      {after}
    </button>
  )
})

/**
 * A note a row says under itself, starting where the label ends rather than on a line's worth of
 * gap: the row's 29px box centres a 20px line, so the pull takes back the half-line left under it.
 * The row's height and the note's offset live in one file, so they move together (ADR 0058).
 */
export function WorkNote({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("-mt-1 truncate pb-1 text-sm", className)} {...props} />
}
