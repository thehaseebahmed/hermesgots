import { createContext, useContext, type ReactNode } from "react"
import { CrosshairIcon, XIcon } from "lucide-react"

import type { CanvasPoint } from "@/lib/point-marker"
import { cn } from "@/lib/utils"

/**
 * The page a canvas's chat is drawn beside, as a place to point at. The chat's composer
 * offers Point only where a screen provides this — a canvas's own screen does, since it holds the frame
 * the page is drawn in — and asks the page to answer the element the reader taps.
 */
export interface CanvasPoints {
  /**
   * Arms the page: the element under the finger is outlined, and a tap answers it. The answer goes out
   * once, to every listener, and the page stops listening when the caller lets it go.
   */
  listen(answer: (point: CanvasPoint) => void): () => void
  /** The element the page answered, said to whoever is listening for one. */
  answer(point: CanvasPoint): void
  /**
   * Sends the reader to the page instead of arming it here. A chat with the page beside it arms that
   * page in place; a chat drawn with no page at all — the phone's edit screen, where the page is
   * another address — has nothing here to arm, so the composer's Point row takes them to the page
   * and lets that screen do the pointing. Absent, the composer arms this screen's page as it always has.
   */
  onArm?: () => void
  /**
   * The element the page answered for this chat before it opened, handed over once: how a chip picked
   * on the page survives the trip back to the chat that asked for it (the page unmounts the chat, so
   * an answer cannot be a prop or a promise). Absent, no element is waiting for this chat.
   */
  take?: () => CanvasPoint | undefined
}

const CanvasPointsContext = createContext<CanvasPoints | null>(null)

export function CanvasPointsProvider({
  points,
  children,
}: {
  points: CanvasPoints
  children: ReactNode
}) {
  return <CanvasPointsContext.Provider value={points}>{children}</CanvasPointsContext.Provider>
}

/** What this chat can point at, or null for a chat that is beside no page at all. */
export const useCanvasPoints = () => useContext(CanvasPointsContext)

/**
 * The elements a message points at, over its words or above its bubble: one chip each, in the order the
 * message named them, with the selector behind each on the chip's own title.
 */
export function PointChips({ points, className }: { points?: CanvasPoint[]; className?: string }) {
  if (!points?.length) return null
  return (
    <ul data-points className={cn("flex flex-wrap justify-end gap-1", className)}>
      {points.map((point, at) => (
        <li key={`${point.selector}-${at}`}>
          <PointChip point={point} />
        </li>
      ))}
    </ul>
  )
}

/**
 * One element a message points at: its own words on a chip, with the selector that finds it again
 * behind them. `draft` is the chip the composer holds before the message goes, which is the one the
 * reader can take back.
 */
export function PointChip({
  point,
  draft = false,
  onRemove,
  className,
}: {
  point: CanvasPoint
  draft?: boolean
  onRemove?: () => void
  className?: string
}) {
  return (
    <span
      data-point-chip={draft ? undefined : ""}
      data-draft-point={draft ? "" : undefined}
      title={point.selector}
      className={cn(
        "inline-flex max-w-64 min-w-0 items-center gap-1.5 rounded-full border bg-muted py-1 pr-1.5 pl-2.5 text-xs",
        className,
      )}
    >
      <CrosshairIcon aria-hidden className="size-3 shrink-0 opacity-70" />
      <span className="truncate">{point.label}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove the point on ${point.label}`}
          // A 44px target around the chip's small dot, as a staged file's remove is.
          className="-my-2 grid size-11 shrink-0 place-items-center rounded-full"
          onClick={onRemove}
        >
          <span className="grid size-5 place-items-center rounded-full bg-foreground/10">
            <XIcon className="size-3" />
          </span>
        </button>
      ) : null}
    </span>
  )
}
