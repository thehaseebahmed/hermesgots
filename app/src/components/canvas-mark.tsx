/**
 * The mark at the head of a canvas's row (issue #1065): the icon or emoji its user chose for it,
 * drawn on the canvas's own record so every device's sidebar shows the same one.
 *
 * A canvas nobody has marked draws the app's frame mark — what every canvas's row drew before a mark
 * could be chosen, and the same markup still, so an unmarked canvas's row is unchanged.
 */
import { FrameIcon } from "lucide-react"

import { readMark } from "@/lib/canvas-marks"
import { useMarkIcons } from "@/lib/canvas-mark-icons"

/** The row's own head: one 20px slot, whatever draws in it, in the ink every row's mark takes. */
export function CanvasMark({ mark }: { mark?: string }) {
  const chosen = readMark(mark)
  const icons = useMarkIcons(chosen?.kind === "icon")
  if (chosen?.kind === "emoji")
    return (
      <span className="flex size-5 shrink-0 items-center justify-center text-base leading-none">
        {chosen.glyph}
      </span>
    )
  // An icon the app's set doesn't carry is no mark it can draw: the frame is what a canvas with none
  // draws, and a name from a build that shipped one is the only case that lands here.
  const found = chosen?.kind === "icon" ? icons?.get(chosen.name) : undefined
  if (!found) return <FrameIcon className="size-5 text-muted-foreground" />
  return <found.Icon className="size-5 shrink-0 text-muted-foreground" />
}
