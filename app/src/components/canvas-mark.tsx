/**
 * The mark at the head of a canvas's row (issue #1065): the icon or emoji its user chose for it,
 * drawn on the canvas's own record so every device's sidebar shows the same one.
 *
 * A canvas nobody has marked draws the app's frame mark — what every canvas's row drew before a mark
 * could be chosen, and the same markup still, so an unmarked canvas's row is unchanged.
 *
 * The same mark is what a canvas's tile in the Canvas list draws where the record holds no picture
 * (issue #1074), so it comes in the tile's own size as well as the row's.
 */
import { FrameIcon } from "lucide-react"

import { readMark } from "@/lib/canvas-marks"
import { useMarkIcons } from "@/lib/canvas-mark-icons"
import { cn } from "@/lib/utils"

/**
 * A canvas's mark: one slot, whatever draws in it, in the ink every row's mark takes. `large` is the
 * list's tile, whose box is a canvas's face rather than a row's head.
 */
export function CanvasMark({ mark, large }: { mark?: string; large?: boolean }) {
  const chosen = readMark(mark)
  const icons = useMarkIcons(chosen?.kind === "icon")
  const box = large ? "size-7" : "size-5"
  if (chosen?.kind === "emoji")
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center leading-none",
          box,
          large ? "text-xl" : "text-base",
        )}
      >
        {chosen.glyph}
      </span>
    )
  // An icon the app's set doesn't carry is no mark it can draw: the frame is what a canvas with none
  // draws, and a name from a build that shipped one is the only case that lands here.
  const found = chosen?.kind === "icon" ? icons?.get(chosen.name) : undefined
  // The frame's own markup is what an unmarked row drew before a mark existed, so it keeps exactly
  // the class it had: only the mark that arrived is the one that doesn't shrink.
  if (!found) return <FrameIcon className={cn(box, "text-muted-foreground")} />
  return <found.Icon className={cn(box, "shrink-0 text-muted-foreground")} />
}
